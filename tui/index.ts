import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_KEY = Symbol.for("pi.tui.right-panel.v1");

type RightPanelState = {
  collapsed: boolean;
};

const globals = globalThis as typeof globalThis & { [STATE_KEY]?: RightPanelState };
const state = (globals[STATE_KEY] ??= { collapsed: false });

function render(ctx: ExtensionContext): void {
  // setStatus always requests a layout pass, even when the key is already clear.
  ctx.ui.setStatus("tui-right-panel-control", undefined);
}

export default function rightPanelControls(pi: ExtensionAPI): void {
  pi.registerCommand("right-panel", {
    description: "Right panel: toggle, show, hide, auto, or status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "toggle") state.collapsed = !state.collapsed;
      else if (action === "show" || action === "auto") state.collapsed = false;
      else if (action === "hide") state.collapsed = true;
      else if (action !== "status") {
        ctx.ui.notify("Usage: /right-panel [toggle|show|hide|auto|status]", "warning");
        return;
      }

      render(ctx);
      const mode = state.collapsed ? "hidden" : "responsive";
      ctx.ui.notify(`Right panel: ${mode}`, "info");
    },
  });
}
