---
name: orchestrator-options
description: >
  Brief System 1 (the orchestrator) like a chief of staff briefs a C-level or
  manager: instead of asking the user a string of clarifying questions, put 3-4
  genuinely different strategic options with cost, risk, reversibility and a
  recommendation in front of them, reasoned at xhigh effort, and send the
  chosen option to the System 1 API through the bundled client. Use this
  whenever a task for System 1 or an orchestrated multi-agent run has more than
  one defensible approach, the user says "options", "orchestrator", "System 1",
  "what should we do", or asks to hand a decision to the orchestrator, even if
  they never say "briefing".
---

# Orchestrator options (System 1)

System 1 acts on whatever it is told. A vague instruction becomes expensive
work, so the right unit of input is a **decision with options**, not a
question. Executives decide fast when the choices are already framed: what each
option costs, how fast it pays off, what could go wrong, whether it can be
undone, and what the briefer would pick.

## Flow

1. **Frame the decision** in one sentence, and the situation in two. Pull
   background from the conversation or repo; do not interrogate the user for it.
2. **Generate the briefing with the client** (it runs Claude Opus 5.5 at
   `effort: xhigh` with adaptive thinking, which is where the quality of the
   options comes from):

   ```bash
   python3 orchestrator-options/client/system1_client.py options "<decision>" [--context notes.md]
   ```

   Add `--json` to get the machine-readable briefing.
3. **Present the briefing to the user** and let them pick. Keep the shape below;
   lead with the recommendation.
4. **Send only after the user picks (or says to go with the recommendation)**:

   ```bash
   python3 orchestrator-options/client/system1_client.py send briefing.json --choose B
   ```

   `--dry-run` prints the payload without posting. `SYSTEM1_API_URL` (and
   optionally `SYSTEM1_API_KEY`) must be set; the client refuses to send without
   a URL. Sending is an external action, so it is not pre-approved by the
   extension snippet.

## What a good briefing looks like

- **3-4 options that differ in strategy** (scope, sequencing, build vs buy,
  depth vs speed), one of which is the do-less option. Reworded variants of the
  same plan are a failure.
- **Per option:** summary, what System 1 would actually run and in what order,
  cost / risk / reversibility (low-medium-high), time to first value, the
  upside, and the one downside that would hurt most.
- **One recommendation**, justified against the others in two or three sentences.
- **Open questions only if an answer would change the recommendation.**

If you cannot reach the client (no `ANTHROPIC_API_KEY`, no network), write the
same briefing yourself in this shape; do not fall back to a list of questions.

## Payload sent to System 1

```json
{"type": "decision_options", "briefing": { ... }, "chosen_option_id": "B"}
```

The endpoint shape is an assumption: adjust `send_to_system1` in the client to
match the real System 1 API if it differs.

## Related pieces in this folder

- `client/system1_client.py` - generate and send (needs `pip install -r client/requirements.txt`)
- `plugin/system1-options/` - `/system1 <task>` command and a pane with a
  Send button per option (mod for Claude Code; runs the client above)
- `extension/settings-snippet.json` - pre-approves generating briefings, keeps
  `send` behind a prompt
