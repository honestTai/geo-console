import json
from pathlib import Path
import tempfile
import unittest

from evaluate import evaluate, load_records


class EvaluationTest(unittest.TestCase):
    def setUp(self):
        self.brand = {"brandId": "test-brand", "sentiment": "mixed", "stance": "conditional", "aspects": [{"aspect": "测试维度", "sentiment": "negative"}]}
        self.gold = {"test-capture": {"captureId": "test-capture", "brands": [self.brand], "answerHash": "test-hash"}}
        self.prediction = {"captureId": "test-capture", "analysis": {"status": "ready", "answerHash": "test-hash", "result": {"analysis": {"schemaVersion": "geo.answer-analysis.v1", "brands": [self.brand]}}}}

    def test_exact_labels(self):
        result = evaluate(self.gold, {"test-capture": self.prediction})
        self.assertEqual(result["analysisCoverage"], 1)
        self.assertEqual(result["metrics"]["aspect_sentiment"]["f1"], 1)

    def test_missing_and_review_results_are_abstentions(self):
        self.prediction["analysis"]["status"] = "needs_review"
        for predictions in ({}, {"test-capture": self.prediction}):
            result = evaluate(self.gold, predictions)
            self.assertEqual(result["analysisCoverage"], 0)
            self.assertEqual(result["metrics"]["brand_sentiment"]["falseNegative"], 1)
            self.assertEqual(result["metrics"]["brand_sentiment"]["recall"], 0)
            self.assertIsNone(result["metrics"]["brand_sentiment"]["precision"])

    def test_hash_and_dataset_mismatch_rejected(self):
        self.prediction["analysis"]["answerHash"] = "different"
        with self.assertRaises(ValueError):
            evaluate(self.gold, {"test-capture": self.prediction})
        with self.assertRaises(ValueError):
            evaluate(self.gold, {"foreign-capture": self.prediction})

    def test_empty_label_sets_have_unknown_not_perfect_f1(self):
        result = evaluate({"empty": {"captureId": "empty", "brands": []}}, {})
        self.assertIsNone(result["metrics"]["brand_sentiment"]["f1"])

    def test_exports_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.json"
            path.write_text(json.dumps(self.prediction), encoding="utf-8")
            self.assertEqual(load_records(path), {"test-capture": self.prediction})
            path.write_text(json.dumps([self.prediction, self.prediction]), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_records(path)


if __name__ == "__main__":
    unittest.main()
