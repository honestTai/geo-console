export type BrandDefinition = { id: string; name: string; aliases: string[] };

export function matchBrands(
	answer: string,
	brands: BrandDefinition[],
): Array<{ brandId: string; matchedAlias: string; position: number }> {
	const normalizedAnswer = answer.toLocaleLowerCase();
	const found = brands
		.flatMap((brand) => {
			const aliases = [...new Set([brand.name, ...brand.aliases])].filter(Boolean);
			const matches = aliases
				.map((alias) => ({ alias, index: normalizedAnswer.indexOf(alias.toLocaleLowerCase()) }))
				.filter((item) => item.index >= 0)
				.sort((left, right) => left.index - right.index);
			return matches[0] ? [{ brandId: brand.id, matchedAlias: matches[0].alias, index: matches[0].index }] : [];
		})
		.sort((left, right) => left.index - right.index);
	return found.map((item, index) => ({ brandId: item.brandId, matchedAlias: item.matchedAlias, position: index + 1 }));
}
