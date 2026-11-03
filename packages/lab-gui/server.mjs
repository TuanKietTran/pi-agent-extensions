#!/usr/bin/env node
// Local web GUI for agent-cli-lab. One command: `node server.mjs --open` (or `npm start`).
// Binds 127.0.0.1 only. No external requests, no telemetry.
import { spawn } from "node:child_process";
import { startGui } from "./lib/serve.mjs";

function parseArgs(argv) {
  const opts = { port: Number(process.env.LAB_GUI_PORT) || 4317, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--open") opts.open = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: lab-gui [--port N] [--open]\n  Serves the lab board on http://127.0.0.1:N (default 4317; 0 picks a free port).\n  Reads labs through the agent-cli-lab binary on PATH (override with AGENT_CLI_LAB_BIN);\n  AGENT_CLI_LAB_DIR selects which labs it sees.");
      process.exit(0);
    } else {
      console.error(`lab-gui: unknown option ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error("lab-gui: --port must be 0-65535");
    process.exit(2);
  }
  return opts;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

const opts = parseArgs(process.argv.slice(2));
let gui;
try {
  gui = await startGui({ port: opts.port });
} catch (error) {
  console.error(`lab-gui: ${error.message}`);
  process.exit(1);
}
console.log(`lab-gui: ${gui.url}  (Ctrl-C to stop; the link carries this launch's key)`);
if (opts.open) openBrowser(gui.url);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    setTimeout(() => process.exit(0), 500).unref();
    gui.close().then(() => process.exit(0));
  });
}
