// Pi lifecycle and message event names, kept separate from bridge constants.
export const PI_EVENT = {
  SESSION_START: "session_start",
  MODEL_SELECT: "model_select",
  BEFORE_AGENT_START: "before_agent_start",
  MESSAGE_UPDATE: "message_update",
  MESSAGE_END: "message_end",
  AGENT_SETTLED: "agent_settled",
  SESSION_SHUTDOWN: "session_shutdown",
} as const;
