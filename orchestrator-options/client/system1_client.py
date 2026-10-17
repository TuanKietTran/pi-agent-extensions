#!/usr/bin/env python3
"""Executive options briefing for System 1 (the orchestrator).

Claude plays the chief of staff: it reasons at xhigh effort over a decision and
returns a board-style briefing (3-4 genuinely different options, trade-offs, a
recommendation). `send` then posts the briefing, plus the chosen option, to the
System 1 API.

    system1_client.py options "task or decision" [--context FILE] [--send] [--choose ID]
    system1_client.py send briefing.json [--choose ID] [--dry-run]

Env: ANTHROPIC_API_KEY (or `ant auth login`), SYSTEM1_API_URL, SYSTEM1_API_KEY (optional).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

import anthropic

MODEL = "claude-opus-5-5"
EFFORT = "xhigh"

SYSTEM = """\
You are the chief of staff to System 1, an orchestrator that coordinates agents and tools. \
System 1 acts on whatever it is told, so your job is to put a real decision in front of it \
the way a C-level executive briefs a board: the decision, the options, the trade-offs, a \
recommendation.

- Offer 3 or 4 options that differ in strategy (scope, sequencing, build vs buy, depth vs \
speed), not in wording. One may be the minimal/do-less option.
- State cost, time to first value, risk and reversibility for each, in terms a manager can \
compare at a glance. Say which downside would hurt most, not every downside.
- Recommend exactly one option and justify it against the others in two or three sentences.
- List only the open questions whose answers would change the recommendation.
- Be concrete about what System 1 would actually do under each option: the agents or tools \
it would start and the order.
"""

LEVELS = ["low", "medium", "high"]

BRIEFING_SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {"type": "string"},
        "situation": {"type": "string"},
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "system1_plan": {"type": "array", "items": {"type": "string"}},
                    "cost": {"type": "string", "enum": LEVELS},
                    "time_to_value": {"type": "string"},
                    "risk": {"type": "string", "enum": LEVELS},
                    "reversibility": {"type": "string", "enum": LEVELS},
                    "upsides": {"type": "array", "items": {"type": "string"}},
                    "downsides": {"type": "array", "items": {"type": "string"}},
                },
                "required": [
                    "id", "title", "summary", "system1_plan", "cost", "time_to_value",
                    "risk", "reversibility", "upsides", "downsides",
                ],
                "additionalProperties": False,
            },
        },
        "recommendation": {
            "type": "object",
            "properties": {"option_id": {"type": "string"}, "rationale": {"type": "string"}},
            "required": ["option_id", "rationale"],
            "additionalProperties": False,
        },
        "open_questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["decision", "situation", "options", "recommendation", "open_questions"],
    "additionalProperties": False,
}


def generate_briefing(task: str, context: str = "") -> dict:
    client = anthropic.Anthropic()
    prompt = f"<task>\n{task}\n</task>"
    if context:
        prompt += f"\n\n<context>\n{context}\n</context>"

    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=64000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={
                "effort": EFFORT,
                "format": {"type": "json_schema", "schema": BRIEFING_SCHEMA},
            },
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            message = stream.get_final_message()
    except anthropic.APIStatusError as e:
        sys.exit(f"Anthropic API error {e.status_code}: {e.message}")
    except anthropic.APIConnectionError as e:
        sys.exit(f"Could not reach the Anthropic API: {e}")

    if message.stop_reason == "refusal":
        sys.exit(f"Model refused the request: {message.stop_details}")
    if message.stop_reason == "max_tokens":
        sys.exit("Briefing was cut off at max_tokens; narrow the task or raise the limit.")

    text = next((b.text for b in message.content if b.type == "text"), "")
    briefing = json.loads(text)
    ids = {o["id"] for o in briefing["options"]}
    if briefing["recommendation"]["option_id"] not in ids:
        sys.exit("Model recommended an option id that is not in the option list.")
    return briefing


def send_to_system1(briefing: dict, chosen: str | None, dry_run: bool = False) -> str:
    ids = {o["id"] for o in briefing["options"]}
    chosen = chosen or briefing["recommendation"]["option_id"]
    if chosen not in ids:
        sys.exit(f"Unknown option id {chosen!r}; choose one of {sorted(ids)}.")

    payload = {"type": "decision_options", "briefing": briefing, "chosen_option_id": chosen}
    body = json.dumps(payload).encode()
    if dry_run:
        return json.dumps(payload, indent=2)

    url = os.environ.get("SYSTEM1_API_URL")
    if not url:
        sys.exit("Set SYSTEM1_API_URL to the System 1 endpoint (or pass --dry-run).")
    headers = {"Content-Type": "application/json"}
    if key := os.environ.get("SYSTEM1_API_KEY"):
        headers["Authorization"] = f"Bearer {key}"

    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read().decode()
    except urllib.error.HTTPError as e:
        sys.exit(f"System 1 returned HTTP {e.code}: {e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        sys.exit(f"Could not reach System 1 at {url}: {e.reason}")


def render(briefing: dict) -> str:
    rec = briefing["recommendation"]["option_id"]
    lines = [f"DECISION: {briefing['decision']}", briefing["situation"], ""]
    for o in briefing["options"]:
        star = "  <- recommended" if o["id"] == rec else ""
        lines += [
            f"[{o['id']}] {o['title']}{star}",
            f"    {o['summary']}",
            f"    cost={o['cost']}  risk={o['risk']}  reversibility={o['reversibility']}  "
            f"time to value: {o['time_to_value']}",
            f"    + {'; '.join(o['upsides'])}",
            f"    - {'; '.join(o['downsides'])}",
            "",
        ]
    lines.append(f"RECOMMENDATION: {rec}. {briefing['recommendation']['rationale']}")
    if briefing["open_questions"]:
        lines += ["", "OPEN QUESTIONS:"] + [f"  ? {q}" for q in briefing["open_questions"]]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    opts = sub.add_parser("options", help="generate an options briefing")
    opts.add_argument("task")
    opts.add_argument("--context", help="file with background to include")
    opts.add_argument("--json", action="store_true", help="print the briefing as JSON")
    opts.add_argument("--send", action="store_true", help="post the briefing to System 1")
    opts.add_argument("--choose", help="option id to send (default: the recommendation)")
    opts.add_argument("--dry-run", action="store_true", help="with --send: print the payload")

    snd = sub.add_parser("send", help="post a saved briefing JSON to System 1")
    snd.add_argument("briefing", help="path to a briefing JSON file ('-' for stdin)")
    snd.add_argument("--choose")
    snd.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()

    if args.cmd == "options":
        context = open(args.context).read() if args.context else ""
        briefing = generate_briefing(args.task, context)
        print(json.dumps(briefing, indent=2) if args.json else render(briefing))
        if args.send:
            print("\n--- System 1 response ---", file=sys.stderr)
            print(send_to_system1(briefing, args.choose, args.dry_run))
    else:
        raw = sys.stdin.read() if args.briefing == "-" else open(args.briefing).read()
        print(send_to_system1(json.loads(raw), args.choose, args.dry_run))


if __name__ == "__main__":
    main()
