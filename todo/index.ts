import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "done";
type TodoSource = "agent" | "human";

type Todo = {
  id: number;
  text: string;
  status: TodoStatus;
  source: TodoSource;
};

type TodoState = {
  todos: Todo[];
  nextId: number;
  autoFeed: boolean;
};

type TodoToolDetails = TodoState & {
  action: string;
  message: string;
};

const STATE_ENTRY = "todo-panel-state";
const WIDGET_KEY = "todo-panel";
const MAX_VISIBLE_TODOS = 14;
const MAX_AUTO_CONTINUATIONS = 20;

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "start", "done", "reopen", "remove", "clear"] as const),
  id: Type.Optional(Type.Number({ description: "Todo ID for start, done, reopen, or remove" })),
  text: Type.Optional(Type.String({ description: "Todo text for add" })),
  items: Type.Optional(Type.Array(Type.String(), { description: "Several todo texts to add in order" })),
});

function cloneState(state: TodoState): TodoState {
  return {
    todos: state.todos.map((todo) => ({ ...todo })),
    nextId: state.nextId,
    autoFeed: state.autoFeed,
  };
}

function isState(value: unknown): value is TodoState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TodoState>;
  return Array.isArray(candidate.todos) && typeof candidate.nextId === "number" && typeof candidate.autoFeed === "boolean";
}

function statusIcon(status: TodoStatus): string {
  if (status === "done") return "✓";
  if (status === "in_progress") return "▶";
  return "○";
}

function nextTodo(todos: Todo[]): Todo | undefined {
  return todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending");
}

function renderTodo(theme: Theme, todo: Todo, selected = false): string {
  const marker = selected ? theme.fg("accent", "›") : " ";
  const icon = todo.status === "done"
    ? theme.fg("success", statusIcon(todo.status))
    : todo.status === "in_progress"
      ? theme.fg("accent", statusIcon(todo.status))
      : theme.fg("dim", statusIcon(todo.status));
  const text = todo.status === "done" ? theme.fg("dim", theme.strikethrough(todo.text)) : todo.text;
  return `${marker} ${icon} ${theme.fg("muted", `#${todo.id}`)} ${text}`;
}

class TodoManager {
  private selected = 0;

  constructor(
    private readonly theme: Theme,
    private readonly getState: () => TodoState,
    private readonly changed: () => void,
    private readonly close: () => void,
    private readonly requestRender: () => void,
  ) {}

  handleInput(data: string): void {
    const state = this.getState();
    const count = state.todos.length;
    const move = (delta: number) => {
      const target = this.selected + delta;
      if (target < 0 || target >= count) return;
      [state.todos[this.selected], state.todos[target]] = [state.todos[target]!, state.todos[this.selected]!];
      this.selected = target;
      this.changed();
    };

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.close();
      return;
    }
    if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
    else if (data === "K") move(-1);
    else if (data === "J") move(1);
    else if (data === "f") {
      state.autoFeed = !state.autoFeed;
      this.changed();
    } else if (data === " " && state.todos[this.selected]) {
      const todo = state.todos[this.selected]!;
      todo.status = todo.status === "pending" ? "in_progress" : todo.status === "in_progress" ? "done" : "pending";
      this.changed();
    } else if ((data === "x" || matchesKey(data, "delete")) && state.todos[this.selected]) {
      state.todos.splice(this.selected, 1);
      this.selected = Math.max(0, Math.min(this.selected, state.todos.length - 1));
      this.changed();
    } else return;

    this.requestRender();
  }

  render(width: number): string[] {
    const state = this.getState();
    const open = state.todos.filter((todo) => todo.status !== "done").length;
    const lines = [
      this.theme.fg("accent", this.theme.bold(` Todos ${open}/${state.todos.length} `)),
      this.theme.fg("dim", "↑↓/jk select · J/K move · space status · x delete"),
      this.theme.fg("dim", `f auto-feed: ${state.autoFeed ? "on" : "off"} · q close`),
      "",
    ];
    if (state.todos.length === 0) lines.push(this.theme.fg("dim", "No todos. Use /todo add <text>."));
    else state.todos.forEach((todo, index) => lines.push(renderTodo(this.theme, todo, index === this.selected)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}

export default function todoPanel(pi: ExtensionAPI): void {
  let state: TodoState = { todos: [], nextId: 1, autoFeed: true };
  let autoContinuations = 0;
  let stateRevision = 0;
  let lastAutoTodoId: number | undefined;
  let lastAutoRevision = -1;

  function persist(): void {
    stateRevision++;
    pi.appendEntry(STATE_ENTRY, cloneState(state));
  }

  function publish(ctx: ExtensionContext): void {
    const open = state.todos.filter((todo) => todo.status !== "done").length;
    if (state.todos.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(WIDGET_KEY, undefined);
      return;
    }

    const visible = state.todos.slice(0, MAX_VISIBLE_TODOS);
    const lines = [
      ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Todos ${open}/${state.todos.length}`)) +
        ctx.ui.theme.fg("dim", ` · auto ${state.autoFeed ? "on" : "off"}`),
      ...visible.map((todo) => renderTodo(ctx.ui.theme, todo)),
    ];
    if (visible.length < state.todos.length) {
      lines.push(ctx.ui.theme.fg("dim", `  … ${state.todos.length - visible.length} more · /todo`));
    }
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    ctx.ui.setStatus(WIDGET_KEY, ctx.ui.theme.fg(open > 0 ? "accent" : "success", `☑ ${open}`));
  }

  function saveAndPublish(ctx: ExtensionContext): void {
    persist();
    publish(ctx);
  }

  // A fully completed queue is stale context for the next request; drop it.
  function clearIfAllDone(ctx: ExtensionContext): void {
    if (state.todos.length === 0 || state.todos.some((todo) => todo.status !== "done")) return;
    state.todos = [];
    saveAndPublish(ctx);
  }

  function restore(ctx: ExtensionContext): void {
    state = { todos: [], nextId: 1, autoFeed: true };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY || !isState(entry.data)) continue;
      state = cloneState(entry.data);
    }
    autoContinuations = 0;
    stateRevision = 0;
    lastAutoTodoId = undefined;
    lastAutoRevision = -1;
    publish(ctx);
  }

  function addTodos(texts: string[], source: TodoSource): Todo[] {
    const added: Todo[] = [];
    for (const raw of texts) {
      const text = raw.trim();
      if (!text) continue;
      const todo: Todo = { id: state.nextId++, text, status: "pending", source };
      state.todos.push(todo);
      added.push(todo);
    }
    return added;
  }

  async function openManager(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The todo manager requires TUI mode", "warning");
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => new TodoManager(
        theme,
        () => state,
        () => saveAndPublish(ctx),
        () => done(),
        () => tui.requestRender(),
      ),
      { overlay: true, overlayOptions: { anchor: "right-center", width: "45%", maxHeight: "80%" } },
    );
  }

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", async (_event, ctx) => {
    clearIfAllDone(ctx);
    const open = state.todos.filter((todo) => todo.status !== "done");
    const list = state.todos.length === 0
      ? "(empty)"
      : state.todos.map((todo, index) => `${index + 1}. [${todo.status}] #${todo.id} ${todo.text}`).join("\n");
    return {
      message: {
        customType: "todo-panel-guidance",
        display: false,
        content: `<todo_workflow>
The Pi host provides a todo tool and the human-owned ordered queue below.
- For work with multiple meaningful steps, add missing steps before doing them.
- Also add newly discovered follow-up work when it becomes necessary.
- Never reorder the queue; only the human controls order.
- Work on the first unfinished item. Mark it in_progress before work and done immediately after completion.
- Do not duplicate existing items. Keep simple one-step requests out of the queue.
- Before ending, update every item whose status changed.
- Use the clear action to drop done items once they no longer matter as context. A fully done queue clears automatically.
Auto-feed is ${state.autoFeed ? "enabled" : "disabled"}.
Current queue (${open.length} open):
${list}
</todo_workflow>`,
      },
    };
  });

  pi.on("agent_start", async () => {
    autoContinuations = 0;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastAutoTodoId = undefined;
    lastAutoRevision = -1;
    clearIfAllDone(ctx);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    publish(ctx);
    if (!state.autoFeed || event.outcome !== "completed" || !event.context.canContinue) return;
    const todo = nextTodo(state.todos);
    if (!todo) return;
    if (lastAutoTodoId === todo.id && lastAutoRevision === stateRevision) {
      ctx.ui.notify(`Todo auto-feed paused: #${todo.id} made no queue progress`, "warning");
      return;
    }
    if (autoContinuations >= MAX_AUTO_CONTINUATIONS) {
      ctx.ui.notify(`Todo auto-feed paused after ${MAX_AUTO_CONTINUATIONS} continuations`, "warning");
      return;
    }
    autoContinuations++;
    lastAutoTodoId = todo.id;
    lastAutoRevision = stateRevision;
    return {
      entries: [{
        type: "custom_message",
        customType: "todo-auto-feed",
        display: false,
        content: `Continue autonomously with the next queued todo: #${todo.id} ${todo.text}. Use the todo tool to update its status.`,
      }],
      continue: true,
    };
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Maintain the ordered shared work queue. Add discovered work; start, complete, reopen, remove, or list items; clear drops done items. The human alone controls ordering.",
    parameters: TodoParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let message = "";
      if (params.action === "add") {
        const added = addTodos([...(params.items ?? []), ...(params.text ? [params.text] : [])], "agent");
        if (added.length === 0) throw new Error("todo add requires text or non-empty items");
        message = `Added ${added.map((todo) => `#${todo.id}`).join(", ")}`;
      } else if (params.action === "list") {
        message = `${state.todos.length} todo(s)`;
      } else if (params.action === "clear") {
        const before = state.todos.length;
        state.todos = state.todos.filter((todo) => todo.status !== "done");
        message = `Cleared ${before - state.todos.length} done todo(s)`;
      } else {
        if (params.id === undefined) throw new Error(`todo ${params.action} requires id`);
        const index = state.todos.findIndex((todo) => todo.id === params.id);
        if (index < 0) throw new Error(`todo #${params.id} not found`);
        const todo = state.todos[index]!;
        if (params.action === "start") {
          todo.status = "in_progress";
          message = `Started #${todo.id}`;
        } else if (params.action === "done") {
          todo.status = "done";
          message = `Completed #${todo.id}`;
        } else if (params.action === "reopen") {
          todo.status = "pending";
          message = `Reopened #${todo.id}`;
        } else {
          state.todos.splice(index, 1);
          message = `Removed #${todo.id}`;
        }
      }
      saveAndPublish(ctx);
      const listing = state.todos.map((todo, index) => `${index + 1}. [${todo.status}] #${todo.id} ${todo.text}`).join("\n") || "(empty)";
      return {
        content: [{ type: "text", text: `${message}\n${listing}` }],
        details: { ...cloneState(state), action: params.action, message } satisfies TodoToolDetails,
      };
    },
  });

  pi.registerCommand("todo", {
    description: "Manage todos: /todo [add|move|done|remove|clear-done|auto]",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        await openManager(ctx);
        return;
      }
      const [action = "", ...rest] = input.split(/\s+/);
      if (action === "add") {
        const added = addTodos([rest.join(" ")], "human");
        if (added.length === 0) ctx.ui.notify("Usage: /todo add <text>", "warning");
        else saveAndPublish(ctx);
        return;
      }
      if (action === "move") {
        const id = Number(rest[0]);
        const position = Number(rest[1]);
        const from = state.todos.findIndex((todo) => todo.id === id);
        if (from < 0 || !Number.isInteger(position) || position < 1 || position > state.todos.length) {
          ctx.ui.notify("Usage: /todo move <id> <position>", "warning");
          return;
        }
        const [todo] = state.todos.splice(from, 1);
        state.todos.splice(position - 1, 0, todo!);
        saveAndPublish(ctx);
        return;
      }
      if (action === "done" || action === "remove") {
        const id = Number(rest[0]);
        const index = state.todos.findIndex((todo) => todo.id === id);
        if (index < 0) {
          ctx.ui.notify(`Todo #${rest[0] ?? "?"} not found`, "warning");
          return;
        }
        if (action === "done") state.todos[index]!.status = "done";
        else state.todos.splice(index, 1);
        saveAndPublish(ctx);
        return;
      }
      if (action === "clear-done") {
        state.todos = state.todos.filter((todo) => todo.status !== "done");
        saveAndPublish(ctx);
        return;
      }
      if (action === "auto") {
        const setting = rest[0]?.toLowerCase();
        state.autoFeed = setting === "on" ? true : setting === "off" ? false : !state.autoFeed;
        saveAndPublish(ctx);
        ctx.ui.notify(`Todo auto-feed ${state.autoFeed ? "enabled" : "disabled"}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /todo [add <text>|move <id> <position>|done <id>|remove <id>|clear-done|auto on|off]", "warning");
    },
  });

  pi.registerShortcut(Key.ctrlShift("t"), {
    description: "Open todo manager",
    handler: openManager,
  });
}
