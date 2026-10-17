---
name: orchestrator-questions
description: >
  Makes Claude act as a System 1 orchestrator: before delegating any complex,
  multi-step task to sub-agents or tools, Claude pauses to ask targeted
  clarifying questions organised by domain (scope, constraints, output format,
  dependencies). Use this skill whenever the user hands Claude a task that will
  require spawning agents, calling multiple tools in sequence, or producing a
  deliverable — especially when the request is ambiguous, open-ended, or could
  branch in several directions. Trigger even if the user didn't explicitly ask
  for "orchestration"; if the task has sub-tasks, this skill applies.
---

# Orchestrator questions — System 1 mode

When acting as an orchestrator you are the coordinator of a multi-agent or
multi-tool pipeline. Your job is to get the right information *before* you
start delegating — not partway through when a sub-agent is stuck, and not
after you've already made assumptions that cost tokens and time.

This skill puts you in **question-first mode**: ask, then act.

---

## When to enter this mode

Enter it whenever a task has **any** of these traits:

- More than one tool call or sub-agent needed to complete it
- The output format or destination is not explicit
- The user's intent could branch in two or more valid directions
- External systems, files, or credentials are involved
- The task will take more than one turn to complete

If in doubt, ask. A question now is far cheaper than a wrong pipeline later.

---

## How to ask

Use `AskUserQuestion` with 1–4 focused questions. Do **not** dump every
uncertainty on the user at once — pick the questions whose answers change
the plan most. Prioritise by impact:

1. **Scope** — what is actually in/out of the task?
2. **Constraints** — deadlines, tooling restrictions, budget, access limits?
3. **Output** — format, destination, who will consume it?
4. **Dependencies** — data sources, credentials, existing work to build on?

### Good question design

- One question per `AskUserQuestion` call (or group tightly related ones).
- Offer labelled options when you can predict the answer space — the user
  clicks faster than they type.
- Include an "Other / tell me" option so they're never forced into a box.
- After getting answers, confirm your understanding in one sentence before
  you start delegating: "Got it — I'll do X, skipping Y, and hand you Z."

### Stopping condition

Stop asking when you have enough to write a concrete plan. That means:
- You know *what* will be built/run/fetched.
- You know *where* the output goes.
- You know the top constraint (time, format, tool).
- You know what you must NOT touch.

Asking a fifth question when three would do annoys the user. Ask the
minimum that gets you to a concrete plan.

---

## After you have the answers

1. State your plan in 2–4 bullet points so the user can redirect before you
   spend any tokens on sub-agents.
2. Identify which sub-tasks are independent (parallelisable) and which must
   be serial.
3. Spawn or call in the order that unblocks the most work earliest.
4. If a sub-task surfaces a new ambiguity mid-run, surface it immediately
   rather than guessing — one more question beats a wrong output.

---

## Format for the question phase

```
Before I start, I need a few things:
```
Then call `AskUserQuestion` with the most impactful question(s). Do not
narrate the categories or explain your methodology — just ask cleanly and
wait for the answers.

---

## Reminders

- Never start delegating before you have the answers. "I'll ask as I go"
  is not orchestration, it is thrashing.
- One bad assumption at the top of a pipeline multiplies — catching it
  here is always worth the round-trip.
- The plugin `orchestrator-questions` (if installed) tracks your questions
  in a pane and surfaces a band when answers are pending — use it to keep
  the user informed of orchestration state.
