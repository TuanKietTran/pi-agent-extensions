export type Option = {
  id: string
  title: string
  summary: string
  cost: string
  risk: string
  reversibility: string
  time_to_value: string
}

export type Briefing = {
  decision: string
  situation: string
  options: Option[]
  recommendation: { option_id: string; rationale: string }
  open_questions: string[]
}

export type Status =
  | { kind: 'idle' }
  | { kind: 'thinking'; task: string }
  | { kind: 'ready' }
  | { kind: 'sent'; option: string; reply: string }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    'system1-options': { briefing: Briefing | null; status: Status }
  }
}
