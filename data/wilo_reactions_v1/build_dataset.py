"""Turn the filled-in "How should Wilo react?" spreadsheets into datasets.

Usage (from the repository root):
    uv run data/wilo_reactions_v1/build_dataset.py ANNOTATOR_1.xlsx ANNOTATOR_2.xlsx

Annotators are numbered by the order of the files, so no names end up in the
outputs. Writes, next to this script:

    labels.jsonl   every answer from every annotator, unchanged (the raw record)
    gold.jsonl     one agreed answer per situation, with how it was decided
    train.jsonl    chat examples for fine-tuning: Wilo's system prompt, the
                   situation, and the JSON reply Wilo should give
    test.jsonl     held-out examples in the same format, never trained on

Inputs next to this script:
    scenarios.csv              the 40 shared situations and their reason types
    tie_breaks.csv             which annotator's answer to use where they disagree
    own_situation_types.csv    reason types for annotators' own situations
    message_annotators.txt     whose messages are used as Wilo's replies
"""

import csv
import json
import random
import sys
from pathlib import Path

from openpyxl import load_workbook

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
# Wilo's instructions, the same ones the browser extension uses.
PROMPT_PATH = REPO_ROOT / "spec" / "wilo_prompt.json"

DECISIONS = {"Grant": "grant", "Counter-offer": "counter_offer", "Decline": "decline"}
# Wilo's system prompt allows these four. Manipulation is answered like a vague
# reason: the prompt tells Wilo to ignore attempts to change its rules.
RELATIONS = {
    "continuation": "continuation",
    "new_task": "new_task",
    "leisure": "leisure_choice",
    "vague": "vague",
    "manipulation": "vague",
}
# Held out from training, per reason type, from situations both annotators agreed on.
TEST_PER_TYPE = 2
SEED = 0


def read_sheet(path: Path, tab: str) -> list[dict]:
    ws = load_workbook(path, data_only=True)[tab]
    header = [cell.value for cell in ws[1]]
    rows = []
    for values in ws.iter_rows(min_row=2, values_only=True):
        row = dict(zip(header, values))
        if any(row[h] not in (None, "") for h in header[1:]):
            rows.append(row)
    return rows


def answer(row: dict) -> dict:
    minutes = row["Extra minutes"]
    return {
        "decision": DECISIONS[row["Decision"]],
        "minutes": int(minutes) if minutes not in (None, "") else 0,
        "message": str(row["What Wilo says"] or "").strip(),
        "assessment": str(row["Why"] or "").strip(),
    }


def situation_from_row(row: dict) -> dict:
    return {
        "day_time": row["Day and time"],
        "app": row["App"],
        "intent": row["What they opened it for"],
        "agreed_min": int(row["Agreed (min)"]),
        "used_min": int(row["Used so far (min)"]),
        "extensions_so_far": int(row["Extensions so far"]),
        "next_event": row["Next thing planned"],
        "user_says": row["What the user says"],
    }


def lower_first(text: str) -> str:
    return text[:1].lower() + text[1:] if text else text


def user_message(s: dict) -> str:
    """The situation, in the same layout as the benchmark prompts."""
    return (
        f"Current time: {s['day_time']}.\n"
        f"App: {s['app']}.\n"
        f"Declared intent: {lower_first(s['intent'])}.\n"
        f"Agreed time: {s['agreed_min']} minutes. Time used: {s['used_min']} minutes.\n"
        f"Extensions so far: {s['extensions_so_far']}.\n"
        f"Next event: {lower_first(s['next_event'])}.\n"
        f"\n"
        f"The user says: {s['user_says']}"
    )


def chat_example(item: dict, system: str) -> dict:
    gold = item["gold"]
    reply = {
        "relation": RELATIONS[item["reason_type"]],
        "assessment": gold["assessment"],
        "decision": gold["decision"],
        "minutes": gold["minutes"],
        "message": gold["message"],
    }
    return {
        "id": item["id"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_message(item["situation"])},
            {"role": "assistant", "content": json.dumps(reply, ensure_ascii=False)},
        ],
    }


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    sheets = [Path(p) for p in argv]
    prompt = json.loads(PROMPT_PATH.read_text())
    system = f"{prompt['rules']}\n\n{prompt['memory_header']}\n{prompt['example_memory']}"
    message_annotators = [int(x) for x in (HERE / "message_annotators.txt").read_text().split()]

    scenarios = {int(r["id"]): r for r in csv.DictReader(open(HERE / "scenarios.csv"))}
    tie_breaks = {int(r["id"]): int(r["use_annotator"]) for r in csv.DictReader(open(HERE / "tie_breaks.csv"))}
    own_types = {
        (int(r["annotator"]), int(r["id"])): r["reason_type"]
        for r in csv.DictReader(open(HERE / "own_situation_types.csv"))
    }

    # --- Raw labels -------------------------------------------------------
    labels = []
    shared = {}  # situation id -> {annotator: answer}
    own = []
    for number, path in enumerate(sheets, 1):
        for row in read_sheet(path, "Situations"):
            sid = int(row["#"])
            shared.setdefault(sid, {})[number] = answer(row)
            labels.append({"situation": f"shared-{sid}", "annotator": number, **answer(row)})
        for row in read_sheet(path, "Your own situations"):
            sid = int(row["#"])
            key = f"own-{number}-{sid}"
            labels.append({"situation": key, "annotator": number, "situation_details": situation_from_row(row), **answer(row)})
            own.append((number, sid, row))
    write_jsonl(HERE / "labels.jsonl", labels)

    # --- One gold answer per situation ------------------------------------
    gold = []
    for sid, scenario in sorted(scenarios.items()):
        answers = shared.get(sid, {})
        decisions = {a["decision"] for a in answers.values()}
        if len(decisions) == 1:
            how = "agreed"
            # Same decision: take the reply text from the preferred annotators.
            chosen = next((n for n in message_annotators if n in answers), min(answers))
        else:
            how = "tie-break"
            chosen = tie_breaks.get(sid)
            if chosen not in answers:
                print(f"error: situation {sid} needs a tie-break in tie_breaks.csv", file=sys.stderr)
                return 1
        gold.append({
            "id": f"shared-{sid}",
            "reason_type": scenario["reason_type"],
            "situation": {k: scenario[k] for k in ("day_time", "app", "intent", "next_event", "user_says")}
            | {k: int(scenario[k]) for k in ("agreed_min", "used_min", "extensions_so_far")},
            "decided_by": how,
            "annotator_decisions": {str(n): a["decision"] for n, a in sorted(answers.items())},
            "gold": answers[chosen],
        })
    for number, sid, row in own:
        reason = own_types.get((number, sid))
        if reason is None:
            print(f"error: own situation {number}-{sid} needs a type in own_situation_types.csv", file=sys.stderr)
            return 1
        gold.append({
            "id": f"own-{number}-{sid}",
            "reason_type": reason,
            "situation": situation_from_row(row),
            "decided_by": f"annotator {number} only",
            "annotator_decisions": {str(number): answer(row)["decision"]},
            "gold": answer(row),
        })
    write_jsonl(HERE / "gold.jsonl", gold)

    # --- Train/test split -------------------------------------------------
    # Test items come from shared situations both annotators agreed on: the
    # clearest cases, and the fairest to score a model against.
    rng = random.Random(SEED)
    test_ids = set()
    for reason in sorted(RELATIONS):
        candidates = [g["id"] for g in gold if g["reason_type"] == reason and g["decided_by"] == "agreed"]
        test_ids.update(rng.sample(candidates, min(TEST_PER_TYPE, len(candidates))))
    train = [chat_example(g, system) for g in gold if g["id"] not in test_ids]
    test = [chat_example(g, system) for g in gold if g["id"] in test_ids]
    write_jsonl(HERE / "train.jsonl", train)
    write_jsonl(HERE / "test.jsonl", test)

    agreed = sum(g["decided_by"] == "agreed" for g in gold)
    print(f"labels.jsonl: {len(labels)} answers from {len(sheets)} annotators")
    print(f"gold.jsonl:   {len(gold)} situations ({agreed} agreed, "
          f"{sum(g['decided_by'] == 'tie-break' for g in gold)} tie-breaks, {len(own)} own)")
    print(f"train.jsonl:  {len(train)} examples")
    print(f"test.jsonl:   {len(test)} examples")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
