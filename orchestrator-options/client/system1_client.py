#!/usr/bin/env python3
"""Autonomous options briefing for System 1 (the orchestrator).

Claude plays the chief of staff: it reasons at xhigh effort over a task and
returns a board-style briefing (3-4 genuinely different options, trade-offs, a
recommendation, the assumptions it made, and a rule for choosing). The briefing
is then posted to the System 1 API, which picks and runs on its own. Nobody is
asked anything in between.

    system1_client.py options "task" [--context FILE] [--no-send] [--json] [--dry-run]
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
System 1 acts on whatever it is told, and it runs unattended: no human will answer a question \
once it starts. Your job is to hand it a real decision the way a C-level executive briefs a \
board: the decision, the options, the trade-offs, a recommendation, and a rule for choosing.

- Offer 3 or 4 options that differ in strategy (scope, sequencing, build vs buy, depth vs \
speed), not in wording. One may be the minimal/do-less option.
- State cost, time to first value, risk and reversibility for each, in terms a manager can \
compare at a glance. Say which downside would hurt most, not every downside.
- Be concrete about what System 1 would actually do under each option: the agents or tools \
it would start and the order, and what it falls back to if a step fails.
- Resolve ambiguity yourself. Where the task leaves something open, pick the most reasonable \
reading and record it as an assumption. Never hand System 1 a question for a human.
- Recommend exactly one option and justify it against the others in two or three sentences.
- Give selection guidance: the rule System 1 should apply to choose among the options on its \
own, including when to prefer a different option than the recommended one.
"""

LEVELS = ["low", "medium", "high"]

BRIEFING_SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {"type": "string"},
        "situation": {"type": "string"},
        "assumptions": {"type": "array", "items": {"type": "string"}},
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "system1_plan": {"type": "array", "items": {"type": "string"}},
                    "fallback": {"type": "string"},
                    "cost": {"type": "string", "enum": LEVELS},
                    "time_to_value": {"type": "string"},
                    "risk": {"type": "string", "enum": LEVELS},
                    "reversibility": {"type": "string", "enum": LEVELS},
                    "upsides": {"type": "array", "items": {"type": "string"}},
                    "downsides": {"type": "array", "items": {"type": "string"}},
                },
                "required": [
                    "id", "title", "summary", "system1_plan", "fallback", "cost",
                    "time_to_value", "risk", "reversibility", "upsides", "downsides",
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
        "selection_guidance": {"type": "string"},
    },
    "required": [
        "decision", "situation", "assumptions", "options", "recommendation", "selection_guidance",
    ],
    "additionalProperties": False,
}


class SendError(Exception):
    pass


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


def build_payload(briefing: dict, chosen: str | None) -> dict:
    payload = {
        "type": "decision_options",
        "mode": "autonomous",
        "briefing": briefing,
        "recommended_option_id": briefing["recommendation"]["option_id"],
    }
    if chosen:
        if chosen not in {o["id"] for o in briefing["options"]}:
            raise SendError(f"Unknown option id {chosen!r}.")
        payload["chosen_option_id"] = chosen
    return payload


def send_to_system1(briefing: dict, chosen: str | None = None, dry_run: bool = False) -> str:
    payload = build_payload(briefing, chosen)
    if dry_run:
        return json.dumps(payload, indent=2)

    url = os.environ.get("SYSTEM1_API_URL")
    if not url:
        raise SendError("SYSTEM1_API_URL is not set.")
    headers = {"Content-Type": "application/json"}
    if key := os.environ.get("SYSTEM1_API_KEY"):
        headers["Authorization"] = f"Bearer {key}"

    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read().decode()
    except urllib.error.HTTPError as e:
        raise SendError(f"System 1 returned HTTP {e.code}: {e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        raise SendError(f"Could not reach System 1 at {url}: {e.reason}")


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
            f"    fallback: {o['fallback']}",
            "",
        ]
    lines.append(f"RECOMMENDATION: {rec}. {briefing['recommendation']['rationale']}")
    lines.append(f"SELECTION GUIDANCE: {briefing['selection_guidance']}")
    if briefing["assumptions"]:
        lines += ["", "ASSUMPTIONS:"] + [f"  * {a}" for a in briefing["assumptions"]]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    opts = sub.add_parser("options", help="generate a briefing and send it to System 1")
    opts.add_argument("task")
    opts.add_argument("--context", help="file with background to include")
    opts.add_argument("--json", action="store_true", help="print {briefing, system1_response, error} as JSON")
    opts.add_argument("--no-send", action="store_true", help="only generate; do not post to System 1")
    opts.add_argument("--dry-run", action="store_true", help="print the payload instead of posting")

    snd = sub.add_parser("send", help="post a saved briefing JSON to System 1")
    snd.add_argument("briefing", help="path to a briefing JSON file ('-' for stdin)")
    snd.add_argument("--choose", help="force System 1 to use this option id")
    snd.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()

    if args.cmd == "send":
        raw = sys.stdin.read() if args.briefing == "-" else open(args.briefing).read()
        try:
            print(send_to_system1(json.loads(raw), args.choose, args.dry_run))
        except SendError as e:
            sys.exit(str(e))
        return

    context = open(args.context).read() if args.context else ""
    briefing = generate_briefing(args.task, context)
    reply, error = None, None
    if not args.no_send:
        try:
            reply = send_to_system1(briefing, None, args.dry_run)
        except SendError as e:
            error = str(e)

    if args.json:
        print(json.dumps({"briefing": briefing, "system1_response": reply, "error": error}))
    else:
        print(render(briefing))
        if reply is not None:
            print("\n--- System 1 response ---\n" + reply)
        if error:
            print(f"\nNOT SENT: {error}", file=sys.stderr)
    sys.exit(1 if error else 0)


if __name__ == "__main__":
    main()
