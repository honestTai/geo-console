import { PRODUCT_NAME, priorityLabel, reportTypeLabel, reputationLabel } from "./labels";
import { type EvidenceIndexEntry, stripTrackingFragment } from "./report";

type ZipEntry = { name: string; data: Buffer; crc: number; offset: number };

const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function crc32(data: Buffer): number {
	let value = 0xffffffff;
	for (const byte of data) value = (value >>> 8) ^ (crcTable[(value ^ byte) & 0xff] ?? 0);
	return (value ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; content: string }>): Buffer {
	const locals: Buffer[] = [];
	const records: ZipEntry[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = Buffer.from(entry.content, "utf8");
		const crc = crc32(data);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0, 6);
		header.writeUInt16LE(0, 8);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		locals.push(header, name, data);
		records.push({ name: entry.name, data, crc, offset });
		offset += header.length + name.length + data.length;
	}
	const central: Buffer[] = [];
	for (const record of records) {
		const name = Buffer.from(record.name, "utf8");
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(0, 10);
		header.writeUInt32LE(record.crc, 16);
		header.writeUInt32LE(record.data.length, 20);
		header.writeUInt32LE(record.data.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt32LE(record.offset, 42);
		central.push(header, name);
	}
	const centralBuffer = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(records.length, 8);
	end.writeUInt16LE(records.length, 10);
	end.writeUInt32LE(centralBuffer.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBuffer, end]);
}

const xml = (value: unknown): string =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

const paragraph = (text: unknown, style?: "Title" | "Heading1" | "Heading2"): string =>
	`<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;

const percentage = (value: unknown): string => (typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "不可用");

export function renderReportDocx(snapshot: Record<string, unknown>): Buffer {
	const payload = snapshot.payload as Record<string, unknown>;
	const batch = payload.batch as { metrics?: { overall?: Record<string, unknown> } };
	const report = payload.report as { analysis?: { executive?: Record<string, unknown> } };
	const narrative = payload.agentNarrative as
		| {
				executiveSummary?: string;
				reputation?: {
					overall?: string;
					summary?: string;
					positiveSignals?: Array<Record<string, unknown>>;
					negativeSignals?: Array<Record<string, unknown>>;
				};
				geoRecommendations?: Array<Record<string, unknown>>;
				limitations?: string[];
		  }
		| undefined;
	const overall = batch.metrics?.overall ?? {};
	const reputation = narrative?.reputation;
	const evidenceIndex = ((report.analysis as { evidenceIndex?: EvidenceIndexEntry[] } | undefined)?.evidenceIndex ??
		[]) as EvidenceIndexEntry[];
	const byId = new Map(evidenceIndex.map((entry) => [entry.id, entry]));
	const marks = (ids: unknown): string =>
		Array.isArray(ids) && ids.length
			? ` ${ids.map((id) => `[${byId.get(String(id))?.n ?? String(id).slice(0, 8)}]`).join("")}`
			: "";
	const sourceLine = (signal: Record<string, unknown>): string =>
		Array.isArray(signal.sourceUrls) && signal.sourceUrls.length
			? [...new Set(signal.sourceUrls.map((url) => stripTrackingFragment(String(url))))].join("、")
			: "平台未展示最终引用 URL";
	const paired =
		(
			payload.comparison as
				| {
						pairedResults?: Array<{
							provider_id: string;
							metric: string;
							result: {
								previous: number | null;
								current: number | null;
								delta: number | null;
								interval: [number, number] | null;
								status: string;
								promptIds: string[];
							};
						}>;
				  }
				| undefined
		)?.pairedResults ?? [];
	const body = [
		paragraph(snapshot.title, "Title"),
		paragraph(`${PRODUCT_NAME} · ${reportTypeLabel(snapshot.report_type)} · 报告快照 ${snapshot.id}`),
		paragraph("执行摘要", "Heading1"),
		paragraph(narrative?.executiveSummary ?? report.analysis?.executive?.summary ?? ""),
		paragraph("核心指标（V2）", "Heading1"),
		paragraph(report.analysis?.executive?.validityNote ?? ""),
		paragraph(
			`采集覆盖：${percentage(overall.captureCoverage)}；解析覆盖：${percentage(overall.parseCoverage)}；问题覆盖：${percentage(overall.promptCoverage)}`,
		),
		paragraph(`品牌提及率：${percentage(overall.brandMentionRate)}`),
		paragraph(`首位推荐率：${percentage(overall.firstRecommendationRate)}`),
		paragraph(`监测品牌出现份额：${percentage(overall.monitoredBrandShare)}`),
		paragraph(`达到正式门槛的平台覆盖率：${percentage(overall.dataCoverage)}（不是采集覆盖率；快审不形成正式结论）`),
		...(paired.length
			? [
					paragraph("共同有效问题的配对变化", "Heading1"),
					...paired.map((p) =>
						paragraph(
							`${p.provider_id} / ${p.metric}：${percentage(p.result.previous)} → ${percentage(p.result.current)}；差值 ${p.result.delta === null ? "不可用" : (p.result.delta * 100).toFixed(1)} 个百分点；95% 区间 ${p.result.interval?.map((v) => (v * 100).toFixed(1)).join(" – ") ?? "不可用"}；共同问题 ${p.result.promptIds.length}；${p.result.status}`,
						),
					),
				]
			: []),
		paragraph("AI 口碑检测", "Heading1"),
		paragraph(`总体：${reputationLabel(reputation?.overall ?? "not_observed")}`),
		paragraph(reputation?.summary ?? "AI 搜索回答中未观察到可报告的口碑评价。"),
		paragraph("正面信号", "Heading2"),
		...((reputation?.positiveSignals ?? []).length
			? (reputation?.positiveSignals ?? []).map(
					(signal) =>
						`${paragraph(`- ${signal.statement}${marks(signal.evidenceIds)}`)}${paragraph(`来源：${sourceLine(signal)}`)}`,
				)
			: [paragraph("未观察到正面口碑信号。")]),
		paragraph("负面信号", "Heading2"),
		...((reputation?.negativeSignals ?? []).length
			? (reputation?.negativeSignals ?? []).map(
					(signal) =>
						`${paragraph(`- ${signal.statement}${marks(signal.evidenceIds)}`)}${paragraph(`来源：${sourceLine(signal)}`)}`,
				)
			: [paragraph("未观察到负面口碑信号。")]),
		paragraph("GEO 优化建议", "Heading1"),
		...(narrative?.geoRecommendations ?? []).map((item) =>
			paragraph(`${priorityLabel(item.priority)}｜${item.title}：${item.action}${marks(item.evidenceIds)}`),
		),
		paragraph("证据局限", "Heading1"),
		...(narrative?.limitations ?? []).map((item) => paragraph(item)),
		paragraph(String(payload.blackBoxStatement ?? "")),
		...(evidenceIndex.length
			? [
					paragraph("证据索引", "Heading1"),
					paragraph("正文中的 [n] 对应以下编号。"),
					...evidenceIndex.map((entry) =>
						paragraph(
							entry.kind === "capture"
								? `[${entry.n}] ${entry.platformLabel ?? entry.platform ?? ""} · “${entry.question ?? ""}” · 第 ${entry.attempt ?? 1} 次采样 · ${entry.capturedAt ?? ""}${entry.sourceUrls.length ? ` · 引用：${entry.sourceUrls.slice(0, 5).join("、")}` : ""}`
								: `[${entry.n}] ${entry.platformLabel ?? ""} · ${entry.title ?? entry.url ?? ""}`,
						),
					),
				]
			: []),
	].join("");
	const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1020" w:left="850"/></w:sectPr></w:body></w:document>`;
	const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:color w:val="0D584A"/><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="25"/></w:rPr></w:style></w:styles>`;
	return zip([
		{
			name: "[Content_Types].xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
		},
		{
			name: "_rels/.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		},
		{ name: "word/document.xml", content: document },
		{
			name: "word/_rels/document.xml.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
		},
		{ name: "word/styles.xml", content: styles },
	]);
}
