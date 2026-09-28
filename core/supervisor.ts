import { spawn, type ChildProcess } from "node:child_process";

export type JobState =
	| "queued"
	| "running"
	| "progress"
	| "completed"
	| "failed"
	| "timed_out"
	| "lost"
	| "cancelled";

export interface KindConfig {
	sla_s: number;
	heartbeat_s: number;
	class: "idempotent" | "reversible" | "compensable" | "irreversible";
	cancelable: boolean;
}

export interface JobEvent {
	type: "job_event";
	job_id: string;
	state: JobState;
	step: string;
	elapsed_s: number;
	last_line: string;
	reversible: boolean;
	cancelable: boolean;
	options: string[];
}

export interface JobRecord {
	job_id: string;
	kind: string;
	command: string;
	cwd: string;
	state: JobState;
	pid?: number;
	started_at: number;
	sla_s: number;
	heartbeat_s: number;
	reversible: boolean;
	cancelable: boolean;
	exit_code?: number | null;
}

interface LiveJob {
	rec: JobRecord;
	child?: ChildProcess;
	lines: string[];
	partial: string;
	lastBeat: number;
	timers: NodeJS.Timeout[];
	terminal: boolean;
}

const RING_MAX = 500;
const TERMINAL: JobState[] = ["completed", "failed", "timed_out", "lost", "cancelled"];

export interface SupervisorHooks {
	/** Called once per state change worth telling the model about. */
	onEvent(ev: JobEvent): void;
	/** Called on every record change so the host can persist. */
	onPersist(rec: JobRecord): void;
	/** Operator-only live output (never fed to the model). */
	onOutput?(job_id: string, line: string): void;
}

export class Supervisor {
	private jobs = new Map<string, LiveJob>();
	private seq = 0;

	constructor(
		private kinds: Record<string, KindConfig>,
		private options: Record<string, string[]>,
		private hooks: SupervisorHooks,
		private allowIrreversible: boolean,
	) {}

	setConfig(kinds: Record<string, KindConfig>, options: Record<string, string[]>) {
		this.kinds = kinds;
		this.options = options;
	}

	kindNames(): string[] {
		return Object.keys(this.kinds);
	}

	/** Restore records from a resumed session; live processes are unknown so running ones become lost. */
	restore(recs: JobRecord[]) {
		for (const rec of recs) {
			if (this.jobs.has(rec.job_id)) continue;
			const n = Number(rec.job_id.split("-").pop());
			if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
			const job: LiveJob = { rec, lines: [], partial: "", lastBeat: Date.now(), timers: [], terminal: TERMINAL.includes(rec.state) };
			this.jobs.set(rec.job_id, job);
			if (!job.terminal) {
				let alive = false;
				if (rec.pid) {
					try {
						process.kill(rec.pid, 0);
						alive = true;
					} catch {}
				}
				if (alive) {
					// Cannot reattach to stdio; treat as lost so the model decides.
					this.finish(job, "lost", "resumed: process still alive but unattached");
				} else {
					this.finish(job, "lost", "resumed: process gone");
				}
			}
		}
	}

	start(kind: string, command: string, cwd: string): JobRecord {
		const cfg = this.kinds[kind];
		if (!cfg) throw new Error(`Unknown kind '${kind}'. Known: ${this.kindNames().join(", ")}`);
		if (cfg.class === "irreversible" && !this.allowIrreversible) {
			throw new Error(
				`Kind '${kind}' is irreversible and disabled. Ask the user to confirm and set PI_JOBS_ALLOW_IRREVERSIBLE=1.`,
			);
		}
		const job_id = `${kind}-${++this.seq}`;
		const rec: JobRecord = {
			job_id,
			kind,
			command,
			cwd,
			state: "queued",
			started_at: Date.now(),
			sla_s: cfg.sla_s,
			heartbeat_s: cfg.heartbeat_s,
			reversible: cfg.class === "idempotent" || cfg.class === "reversible",
			cancelable: cfg.cancelable,
		};
		const job: LiveJob = { rec, lines: [], partial: "", lastBeat: Date.now(), timers: [], terminal: false };
		this.jobs.set(job_id, job);

		const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		job.child = child;
		rec.pid = child.pid;
		rec.state = "running";
		this.hooks.onPersist(rec);

		const onData = (buf: Buffer) => {
			job.lastBeat = Date.now();
			job.partial += buf.toString("utf8");
			const parts = job.partial.split("\n");
			job.partial = parts.pop() ?? "";
			for (const line of parts) this.pushLine(job, line);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (e) => this.finish(job, "failed", `spawn error: ${e.message}`));
		child.on("close", (code, sig) => {
			if (job.partial) this.pushLine(job, job.partial);
			job.partial = "";
			rec.exit_code = code;
			if (job.terminal) return;
			if (code === 0) this.finish(job, "completed");
			else if (sig && code === null) this.finish(job, "lost", `killed by signal ${sig}`);
			else this.finish(job, "failed", `exit ${code}`);
		});

		job.timers.push(
			setTimeout(() => {
				if (job.terminal) return;
				// SLA miss: report, do not kill. The model chooses cancel / keep_waiting.
				this.emit(job, "timed_out", "sla");
			}, cfg.sla_s * 1000),
		);
		if (cfg.heartbeat_s > 0) {
			job.timers.push(
				setInterval(() => {
					if (job.terminal) return;
					if (Date.now() - job.lastBeat > cfg.heartbeat_s * 2000) {
						this.finish(job, "lost", "heartbeat missed");
						// Unattended policy: auto-cancel on lost.
						this.kill(job);
					}
				}, cfg.heartbeat_s * 1000),
			);
		}
		return rec;
	}

	status(job_id: string): (JobRecord & { elapsed_s: number; last_line: string }) | undefined {
		const j = this.jobs.get(job_id);
		if (!j) return undefined;
		return { ...j.rec, elapsed_s: this.elapsed(j), last_line: this.last(j) };
	}

	list(): JobRecord[] {
		return [...this.jobs.values()].map((j) => j.rec);
	}

	logs(job_id: string, tail: number): string[] | undefined {
		const j = this.jobs.get(job_id);
		if (!j) return undefined;
		return j.lines.slice(-Math.max(1, Math.min(tail, 200)));
	}

	cancel(job_id: string): string {
		const j = this.jobs.get(job_id);
		if (!j) throw new Error(`Unknown job ${job_id}`);
		if (j.terminal) return `already ${j.rec.state}`;
		if (!j.rec.cancelable) throw new Error(`Job ${job_id} is not cancelable`);
		this.finish(j, "cancelled");
		this.kill(j);
		return "cancelled";
	}

	shutdown() {
		for (const j of this.jobs.values()) {
			for (const t of j.timers) {
				clearTimeout(t);
				clearInterval(t);
			}
			j.timers = [];
		}
	}

	private kill(j: LiveJob) {
		const pid = j.child?.pid ?? j.rec.pid;
		if (!pid) return;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {}
		setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
		}, 3000).unref();
	}

	private pushLine(j: LiveJob, line: string) {
		j.lines.push(line);
		if (j.lines.length > RING_MAX) j.lines.shift();
		this.hooks.onOutput?.(j.rec.job_id, line);
	}

	private elapsed(j: LiveJob) {
		return Math.round((Date.now() - j.rec.started_at) / 1000);
	}

	private last(j: LiveJob) {
		return (j.lines[j.lines.length - 1] ?? "").slice(0, 200);
	}

	private finish(j: LiveJob, state: JobState, note?: string) {
		if (j.terminal) return;
		j.terminal = true;
		for (const t of j.timers) {
			clearTimeout(t);
			clearInterval(t);
		}
		j.timers = [];
		j.rec.state = state;
		if (note) this.pushLine(j, `[host] ${note}`);
		this.emit(j, state, note ?? "");
	}

	private emit(j: LiveJob, state: JobState, step: string) {
		if (state === "timed_out") j.rec.state = "timed_out";
		this.hooks.onPersist(j.rec);
		this.hooks.onEvent({
			type: "job_event",
			job_id: j.rec.job_id,
			state,
			step,
			elapsed_s: this.elapsed(j),
			last_line: this.last(j),
			reversible: j.rec.reversible,
			cancelable: j.rec.cancelable && !j.terminal,
			options: this.options[state] ?? [],
		});
	}
}
