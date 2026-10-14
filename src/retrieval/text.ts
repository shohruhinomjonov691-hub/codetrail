/**
 * Code-aware tokenization for the keyword index: identifiers are split on
 * camelCase, PascalCase, snake_case, kebab-case, digits and path separators so
 * "contact agent" finds `contactAgentHandler` and `contact-agent.ts`.
 */
export function splitIdentifiers(text: string): string {
	const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
	const out: string[] = [];
	for (const word of words) {
		for (const part of word.split('_')) {
			const pieces = part.match(/\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+/gu) ?? [];
			for (const p of pieces) if (p.length > 1) out.push(p.toLowerCase());
		}
	}
	return out.join(' ');
}

const MAX_QUERY_TERMS = 32;

/** Generic English question words that carry no code meaning (used when stopwords are enabled). */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set(
	('a an and are as at be by can could do does did for from has have how i in into is it its me my of on or our should so ' +
		'that the their them then there these this those to was we were what when where which who whom why will with would you your')
		.split(' '),
);

/**
 * Builds an FTS5 MATCH expression from free text. Every term is double-quoted,
 * so user input can never inject FTS5 operators or column filters.
 */
export function ftsQuery(question: string, opts: { stopwords?: boolean } = {}): string | null {
	const raw = (question.match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => w.toLowerCase());
	const terms = new Set<string>();
	for (const w of [...raw, ...splitIdentifiers(question).split(' ')]) {
		if (w.length > 1 && !(opts.stopwords && QUERY_STOPWORDS.has(w))) terms.add(w);
		if (terms.size >= MAX_QUERY_TERMS) break;
	}
	if (terms.size === 0) return null;
	return [...terms].map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}
