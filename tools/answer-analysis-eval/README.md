# 完整回答语义分析：离线人工标注评测

这是**开发/评测工具**，不是线上服务，不被业务 Agent 调用。Python 3.9+、仅标准库，不安装依赖、不访问数据库、不联网、不调用模型。测试夹具仅在 `test_evaluate.py` 中。

1. 在证据中心选择真实回答，生成完整语义分析后点击「导出分析」。每个 captureId 选择一个分析版本。
2. 由人工核对同一份原文，制作 JSON/JSONL 标注；不得将模型自己的结果直接当作金标准。
3. 每条人工标注包含 `captureId`、建议包含导出的 `answerHash`，以及 `brands` 数组（未提及品牌为空数组）。品牌项包含 `brandId`、`sentiment`、`stance`、`aspects`；方面项包含 `aspect` 与 `sentiment`。枚举与 evidence 的 `answerAnalysisSchema` 一致。
4. 运行 `python3 tools/answer-analysis-eval/evaluate.py --gold /absolute/path/gold.jsonl --predictions /absolute/path/export-1.json /absolute/path/export-2.json`。只输出报告，不写回证据或指标。
5. 运行测试：`python3 -m unittest discover -s tools/answer-analysis-eval -p 'test_*.py'`。

输出品牌情感、推荐立场、方面情感的原子标签 precision/recall/F1，以及可用回答覆盖率。缺失、失败、待核对不从金标准分母删除，也不视为中性。没有可计算分母的数值为 null。不同 captureId/回答哈希不允许混测。

维度名仅做空白与大小写归一化，**不**自动把近义词算成相同维度。此工具不测摘要忠实度、引文是否蕴含结论或推荐条件抽取准确性；这些仍需人工审核。没有真实标注集就不能宣称模型精度达标。

导出包含原始回答与项目品牌，按客户证据处理，不提交到仓库或公开目录。
