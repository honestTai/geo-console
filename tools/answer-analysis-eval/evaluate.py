"""Offline, standard-library-only evaluation of exported analyses against human labels.

No network, model calls, code generation, database access or production defaults.
Python 3.9+. Input data stays in files explicitly provided by the operator.
"""

import argparse
import json
from pathlib import Path


def load_records(path):
    content = Path(path).read_text(encoding="utf-8-sig")
    try:
        value = json.loads(content)
        records = value if isinstance(value, list) else [value]
    except json.JSONDecodeError:
        records = [json.loads(line) for line in content.splitlines() if line.strip()]
    indexed = {}
    for record in records:
        capture_id = record.get("captureId") if isinstance(record, dict) else None
        if not isinstance(capture_id, str) or not capture_id or capture_id in indexed:
            raise ValueError("Each record requires a unique, nonempty captureId")
        indexed[capture_id] = record
    return indexed


def normalized(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Label identifiers and values must be nonempty strings")
    return " ".join(value.split()).casefold()


def labels(capture_id, record):
    result = {"brand_sentiment": set(), "brand_stance": set(), "aspect_sentiment": set()}
    brands = record.get("brands")
    if not isinstance(brands, list):
        raise ValueError("Annotations require a brands array, including [] for no brands")
    seen = set()
    for brand in brands:
        brand_id = brand.get("brandId")
        if not isinstance(brand_id, str) or not brand_id or brand_id in seen:
            raise ValueError("Each answer requires unique brandId values")
        seen.add(brand_id)
        sentiment = normalized(brand["sentiment"])
        stance = normalized(brand["stance"])
        if sentiment not in {"positive", "neutral", "negative", "mixed", "unclear"}:
            raise ValueError("Unknown sentiment label")
        if stance not in {"explicit", "implicit", "conditional", "none", "against", "mixed", "unclear"}:
            raise ValueError("Unknown stance label")
        result["brand_sentiment"].add((capture_id, brand_id, sentiment))
        result["brand_stance"].add((capture_id, brand_id, stance))
        aspects = set()
        for aspect in brand.get("aspects", []):
            name = normalized(aspect["aspect"])
            if name in aspects:
                raise ValueError("Aspect names must be unique within each brand")
            aspects.add(name)
            polarity = normalized(aspect["sentiment"])
            if polarity not in {"positive", "neutral", "negative", "mixed", "unclear"}:
                raise ValueError("Unknown aspect sentiment")
            result["aspect_sentiment"].add((capture_id, brand_id, name, polarity))
    return result


def scores(expected, predicted):
    tp = len(expected & predicted)
    fp = len(predicted - expected)
    fn = len(expected - predicted)
    return {
        "truePositive": tp, "falsePositive": fp, "falseNegative": fn,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
    }


def evaluate(gold, predictions):
    if not gold:
        raise ValueError("Gold annotation set must not be empty")
    if set(predictions) - set(gold):
        raise ValueError("Predictions contain answers outside the gold annotation set")
    expected = {key: set() for key in ("brand_sentiment", "brand_stance", "aspect_sentiment")}
    predicted = {key: set() for key in expected}
    answered = 0
    hash_checked = 0
    for capture_id, truth in gold.items():
        for key, values in labels(capture_id, truth).items():
            expected[key].update(values)
        export = predictions.get(capture_id)
        if export is None:
            continue  # Missing answers remain in recall denominators, never silently filtered.
        view = export.get("analysis")
        if not isinstance(view, dict):
            raise ValueError("Predictions must use the UI's exported analysis envelope")
        if truth.get("answerHash"):
            hash_checked += 1
            if truth["answerHash"] != view.get("answerHash"):
                raise ValueError("Gold and prediction refer to different original answer hashes")
        if view.get("status") != "ready" or not view.get("result"):
            continue  # Pending, failed and needs_review are abstentions, not neutral sentiments.
        analysis = view["result"]["analysis"]
        if analysis.get("schemaVersion") != "geo.answer-analysis.v1":
            raise ValueError("Unsupported analysis schema version")
        answered += 1
        for key, values in labels(capture_id, analysis).items():
            predicted[key].update(values)
    return {
        "version": "geo.answer-analysis-eval.v1",
        "answers": len(gold), "usablePredictions": answered,
        "analysisCoverage": answered / len(gold), "answerHashesChecked": hash_checked,
        "metrics": {key: scores(expected[key], predicted[key]) for key in expected},
        "limitations": [
            "Exact aspect-name matching after whitespace/case normalization; no semantic synonym matching.",
            "This evaluates labels only, not summary correctness, quote entailment or ranking causality.",
            "No confidence or business score is inferred from these results.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gold", required=True, help="Human annotations: JSON object/array or JSONL")
    parser.add_argument("--predictions", required=True, nargs="+", help="One or more UI exports or JSONL files")
    args = parser.parse_args()
    try:
        predictions = {}
        for path in args.predictions:
            current = load_records(path)
            if set(predictions) & set(current):
                raise ValueError("Choose exactly one analysis revision per captureId")
            predictions.update(current)
        report = evaluate(load_records(args.gold), predictions)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.error(str(error))
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
