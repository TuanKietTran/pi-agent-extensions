---
name: orchestrator-options
description: >
  Hand a task to System 1 (the orchestrator) autonomously. Claude reasons at
  xhigh effort like a chief of staff briefing a C-level or manager, produces 3-4
  genuinely different strategic options with cost, risk, reversibility, a
  recommendation, its own assumptions and a rule for choosing, and sends that
  briefing to the System 1 API through the bundled client. No questions to the
  user, no approval step: System 1 picks and runs on its own. Use whenever a task
  is for System 1 or an orchestrated multi-agent run, the user says "System 1",
  "orchestrator", "options" or "autonomous", or a task has more than one
  defensible approach and nobody will be around to answer questions.
---

# Orchestrator options (System 1, autonomous)

System 1 acts on whatever it is told and runs unattended. A vague instruction
becomes expensive work, and a question has nobody to answer it. So the input
is a **decision with options**, framed the way executives get them: what each
option costs, how fast it pays off, what could go wrong, whether it can be
undone, and what the briefer would pick. System 1 then chooses and runs.

## Do not ask the user anything

Never call `AskUserQuestion` and never stop to ask for clarification, before
or after the briefing. Where the task is ambiguous, choose the most reasonable
reading yourself and record it as an assumption in the briefing; System 1 gets
the assumptions and can see what was decided on its behalf. The briefing step
is where the thinking happens, so spend the effort there instead of on a
round-trip.

## Flow

1. **Frame the task** in one sentence from the conversation and repo. If the
   background is long, write it to a file and pass `--context notes.md`.
2. **Run the client.** It generates the briefing with Claude Opus 5.5 at
   `effort: xhigh` and adaptive thinking (this is where the quality of the
   options comes from), then posts it to System 1:

   ```bash
   python3 orchestrator-options/client/system1_client.py options "<task>" [--context notes.md]
   ```

   `--json` prints `{briefing, system1_response, error}` for programmatic use;
   `--no-send` generates without posting; `--dry-run` prints the payload.
3. **Report the outcome in a line or two:** which option was recommended, and
   System 1's response. If the client prints `NOT SENT`, say why (usually
   `SYSTEM1_API_URL` unset) and keep the briefing; do not ask the user how to
   proceed.

If you cannot reach the client (no `ANTHROPIC_API_KEY`, no network), write the
same briefing yourself in the shape below and keep going; do not fall back to
a list of questions.

## What a good briefing looks like

- **3-4 options that differ in strategy** (scope, sequencing, build vs buy,
  depth vs speed), one of which is the do-less option. Reworded variants of the
  same plan are a failure.
- **Per option:** summary, what System 1 would run and in what order, what it
  falls back to if a step fails, cost / risk / reversibility (low-medium-high),
  time to first value, the upside, and the one downside that would hurt most.
- **One recommendation**, justified against the others in two or three sentences.
- **Assumptions** that were resolved on System 1's behalf.
- **Selection guidance:** the rule System 1 applies to choose on its own,
  including when to prefer an option other than the recommended one.

## Payload sent to System 1

```json
{"type": "decision_options", "mode": "autonomous", "briefing": { ... },
 "recommended_option_id": "B"}
```

`chosen_option_id` is added only when forced with `send --choose ID`; by
default System 1 decides. The endpoint shape is an assumption: adjust
`build_payload` / `send_to_system1` in the client to match the real API.

## Related pieces in this folder

- `client/system1_client.py` - generate and send (`pip install -r client/requirements.txt`)
- `plugin/system1-options/` - `/system1 <task>` command and a pane that shows
  the briefing and System 1's response (a Claude Code mod; runs the client)
- `extension/settings-snippet.json` - pre-approves the client and denies
  `AskUserQuestion` so a run cannot stop for input
