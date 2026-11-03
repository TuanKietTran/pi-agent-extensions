/**
 * Decides when the `claude` subprocess has said everything Pi needs.
 *
 * Pi only needs Claude's first assistant message when that message requests host
 * tools: Pi runs them and starts a new turn with the results. Left alone, Claude
 * Code would feed the capture acknowledgement back to the model and make two more
 * API round trips (an acknowledgement turn and a structured-output turn) whose
 * output Pi throws away. The provider stops the process as soon as every requested
 * host call has been captured.
 */
export const HOST_TOOL_PREFIX = "mcp__pi-host__";

export class EarlyStop {
  /** Host tool_use blocks announced by the assistant message being streamed. */
  private announced = 0;
  private messageDone = false;
  private captured = 0;
  private stopped = false;

  /** Feed every `stream_event` payload. */
  observe(event: any): void {
    if (!event || this.messageDone) return;
    if (event.type === "message_start") {
      this.announced = 0;
    } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      if (String(event.content_block.name ?? "").startsWith(HOST_TOOL_PREFIX)) this.announced += 1;
    } else if (event.type === "message_stop") {
      this.messageDone = this.announced > 0;
    }
  }

  /** Call when the MCP bridge records one host call. */
  captureOne(): void {
    this.captured += 1;
  }

  /** True once, when the process can be stopped. */
  shouldStop(): boolean {
    if (this.stopped || !this.messageDone || this.captured < this.announced) return false;
    this.stopped = true;
    return true;
  }
}
