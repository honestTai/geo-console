/** Shared domain queries use bound values. This compiler handles their finite SQL dialect;
 * it never accepts SQL from a model, a renderer, a snapshot, or the cloud. */
export function sqliteSql(source: string): string {
	const literals: string[] = [];
	let sql = source.replace(/'(?:''|[^'])*'/g, (literal) => `__lit${literals.push(literal) - 1}__`);
	sql = sql.replace(/::[a-zA-Z_][\w]*(?:\[\])?/g, "");
	sql = sql.replace(/=\s*ANY\s*\(ARRAY\[([^\]]*)\]\)/gi, " IN ($1)");
	sql = sql.replace(/<>\s*ALL\s*\(ARRAY\[([^\]]*)\]\)/gi, " NOT IN ($1)");
	sql = sql.replace(/=\s*ANY\s*\((\$\d+)\)/gi, " IN (SELECT value FROM json_each($1))");
	sql = sql.replace(/\bFOR\s+(?:UPDATE|SHARE)(?:\s+OF\s+\w+)?(?:\s+SKIP\s+LOCKED)?/gi, "");
	sql = sql.replace(/\bIS\s+DISTINCT\s+FROM\b/gi, "IS NOT");
	sql = sql.replace(/\bIS\s+NOT\s+DISTINCT\s+FROM\b/gi, "IS");
	sql = sql.replace(/\bUPDATE\s+(\w+)\s+(\w+)\s+SET\b/gi, "UPDATE $1 AS $2 SET");
	const updatedAlias = sql.match(/\bUPDATE\s+(\w+)\s+AS\s+(\w+)\s+SET/i);
	if (updatedAlias)
		sql = sql.replace(
			/\bRETURNING\s+([\s\S]+)$/i,
			(_, value: string) => `RETURNING ${value.replaceAll(`${updatedAlias[2]}.`, "")}`,
		);
	sql = sql.replace(/([\w.]+)\s*~\s*(__lit\d+__)/g, "geo_regexp($2,$1)");
	sql = sql.replace(/\bILIKE\b/gi, "LIKE");
	sql = sql.replace(/\bjsonb_array_length\b/gi, "json_array_length").replace(/\bjsonb_typeof\b/gi, "json_type");
	sql = sql.replace(/\bjsonb_build_object\b/gi, "json_object").replace(/\bjsonb_agg\b/gi, "json_group_array");
	sql = sql.replace(/\bjsonb_set\b/gi, "geo_json_set");
	sql = sql.replace(/transcript\s*\|\|\s*(\$\d+)/g, "geo_json_concat(transcript,$1)");
	sql = sql.replace(/(\([^()]*->[^()]*\))\s*-\s*(__lit\d+__)/g, "geo_json_remove($1,$2)");
	// json_each exposes a value column rather than PostgreSQL's bare set alias.
	for (const alias of ["source", "evidence", "item"])
		sql = sql.replace(new RegExp(`\\b${alias}(->>?)`, "g"), `${alias}.value$1`);
	sql = sql.replace(/\bLATERAL\s+(?=jsonb_array_elements)/gi, "");
	sql = sql.replace(/\bjsonb_array_elements\b/gi, "json_each");
	sql = sql.replace(/\bcardinality\b/gi, "json_array_length");
	sql = sql.replace(/\bGREATEST\b/gi, "max").replace(/\bLEAST\b/gi, "min");
	sql = sql.replace(/([\w.]+)\s*@>\s*(__lit\d+__|\$\d+)/g, "geo_json_contains($1,$2)");
	// SQL interval arithmetic is kept in one audited function, not string-concatenated inputs.
	sql = sql.replace(
		/now\(\)\s*([+-])\s*\(\s*(\$\d+|\d+)\s*\*\s*interval\s+(__lit\d+__)\s*\)/gi,
		"geo_date_shift(now(), '$1', $2, $3)",
	);
	sql = sql.replace(/now\(\)\s*([+-])\s*interval\s+(__lit\d+__)/gi, "geo_date_shift(now(), '$1', 1, $2)");
	sql = sql.replace(
		/(COALESCE\([\w.]+,now\(\)\)|now\(\))\s*([+-])\s*\((\$\d+|[\w.]+)\s*\|\|\s*(__lit\d+__)\)/gi,
		"geo_date_shift($1, '$2', 1, $3||$4)",
	);
	sql = sql.replace(/EXTRACT\(EPOCH\s+FROM\s+\(([^()]+)-([^()]+)\)\)/gi, "((julianday($1)-julianday($2))*86400)");
	sql = sql.replace(
		/EXTRACT\(EPOCH\s+FROM\s+(max\(\w+\))\s*-\s*now\(\)\)/gi,
		"((julianday($1)-julianday(now()))*86400)",
	);
	sql = sql.replace(/\bpublic\./g, "").replace(/\s+USING\s+btree\s*/gi, " ");
	return sql.replace(/__lit(\d+)__/g, (_, index: string) => literals[Number(index)]);
}

export function jsonContains(value: unknown, subset: unknown): boolean {
	if (Array.isArray(subset))
		return Array.isArray(value) && subset.every((item) => value.some((candidate) => jsonContains(candidate, item)));
	if (subset !== null && typeof subset === "object")
		return (
			value !== null &&
			typeof value === "object" &&
			Object.entries(subset).every(([key, item]) => jsonContains((value as Record<string, unknown>)[key], item))
		);
	return value === subset;
}
