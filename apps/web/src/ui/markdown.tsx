import type { ReactNode } from "react";

export function answerInline(value: string, keyPrefix: string): ReactNode[] {
	const pattern = /(\*\*[^*]+\*\*|`[^`]+`|!?\[[^\]]*\]\(https?:\/\/[^\s)]+\))/g;
	const parts: ReactNode[] = [];
	let offset = 0;
	for (const [index, match] of [...value.matchAll(pattern)].entries()) {
		const token = match[0];
		const start = match.index ?? 0;
		if (start > offset) parts.push(value.slice(offset, start));
		if (token.startsWith("**")) parts.push(<strong key={`${keyPrefix}-b-${index}`}>{token.slice(2, -2)}</strong>);
		else if (token.startsWith("`")) parts.push(<code key={`${keyPrefix}-c-${index}`}>{token.slice(1, -1)}</code>);
		else {
			const image = token.startsWith("!");
			const link = token.match(/^!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/);
			if (link)
				parts.push(
					<a key={`${keyPrefix}-a-${index}`} href={link[2]} target="_blank" rel="noreferrer">
						{image ? `图片：${link[1] || link[2]}` : link[1] || link[2]}
					</a>,
				);
			else parts.push(token);
		}
		offset = start + token.length;
	}
	if (offset < value.length) parts.push(value.slice(offset));
	return parts;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A single pass keeps Markdown block precedence explicit without injecting HTML.
export function FormattedAnswer({ value }: { value: string }) {
	const lines = value.replaceAll("\r\n", "\n").split("\n");
	const blocks: ReactNode[] = [];
	for (let index = 0; index < lines.length; ) {
		const line = lines[index]?.trimEnd() ?? "";
		if (!line.trim()) {
			index += 1;
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			const level = Math.min(4, heading[1].length + 1);
			const content = answerInline(heading[2], `h-${index}`);
			blocks.push(
				level === 2 ? (
					<h2 key={`h-${index}`}>{content}</h2>
				) : level === 3 ? (
					<h3 key={`h-${index}`}>{content}</h3>
				) : (
					<h4 key={`h-${index}`}>{content}</h4>
				),
			);
			index += 1;
			continue;
		}
		if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
			blocks.push(<hr key={`hr-${index}`} />);
			index += 1;
			continue;
		}
		if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")) {
			const rows: string[][] = [];
			const header = line
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim());
			index += 2;
			while (index < lines.length && (lines[index] ?? "").includes("|")) {
				rows.push(
					(lines[index] ?? "")
						.replace(/^\||\|$/g, "")
						.split("|")
						.map((cell) => cell.trim()),
				);
				index += 1;
			}
			blocks.push(
				<div className="answer-table-wrap" key={`table-${index}`}>
					<table>
						<thead>
							<tr>
								{header.map((cell, cellIndex) => (
									<th key={cell}>{answerInline(cell, `th-${index}-${cellIndex}`)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row, rowIndex) => (
								<tr key={row.join("|")}>
									{row.map((cell, cellIndex) => (
										<td key={cell}>{answerInline(cell, `td-${rowIndex}-${cellIndex}`)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>,
			);
			continue;
		}
		const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
		if (listMatch) {
			const ordered = /^\s*\d/.test(line);
			const items: string[] = [];
			while (index < lines.length) {
				const item = (lines[index] ?? "").match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
				if (!item || /^\s*\d/.test(lines[index] ?? "") !== ordered) break;
				items.push(item[1]);
				index += 1;
			}
			const children = items.map((item, itemIndex) => (
				<li key={item}>{answerInline(item, `li-${index}-${itemIndex}`)}</li>
			));
			blocks.push(ordered ? <ol key={`ol-${index}`}>{children}</ol> : <ul key={`ul-${index}`}>{children}</ul>);
			continue;
		}
		const paragraph: string[] = [line.trim()];
		index += 1;
		while (
			index < lines.length &&
			(lines[index] ?? "").trim() &&
			!/^#{1,6}\s+/.test(lines[index] ?? "") &&
			!/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index] ?? "") &&
			!((lines[index] ?? "").includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? ""))
		) {
			paragraph.push((lines[index] ?? "").trim());
			index += 1;
		}
		blocks.push(<p key={`p-${index}`}>{answerInline(paragraph.join(" "), `p-${index}`)}</p>);
	}
	return <div className="formatted-answer">{blocks}</div>;
}
