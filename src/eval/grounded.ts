import { QUERY_STOPWORDS, splitIdentifiers } from '../retrieval/text.js';

/**
 * D0b grounded-answer benchmark helpers (experimental; no CodeTrail command uses
 * them). Compact excerpts keep their original line numbers; the model must answer
 * with schema-constrained JSON; validateGroundedAnswer rejects the WHOLE answer
 * when anything about it is invalid (fail-closed — claims are never dropped to
 * keep the rest). A valid answer is still not a correct one: quotes and citations
 * are only mechanical checks and every claim is graded by hand.
 */

export const EXCERPT_LIMITS = { contextLines: 2, mergeGap: 2, maxLinesPerExcerpt: 30, fallbackLines: 15, maxClaims: 6, minQuoteChars: 8 } as const;

export interface ExcerptLine {
	line: number;
	text: string;
}

export interface Excerpt {
	/** S1, S2, … in the order given to the model. */
	id: string;
	source_id: string;
	path: string;
	lines: ExcerptLine[];
}

/** Lower-cased query terms (stopwords removed, identifiers split) used to pick lines. */
export function queryTerms(question: string): string[] {
	const raw = (question.match(/[\p{L}\p{N}_$]+/gu) ?? []).map((w) => w.toLowerCase());
	const split = splitIdentifiers(question).toLowerCase().split(/\s+/);
	return [...new Set([...raw, ...split])].filter((w) => w.length > 2 && !QUERY_STOPWORDS.has(w));
}

/**
 * Compact excerpt of one chunk: lines containing a query term, with
 * `contextLines` around them, merged when the gap is small, at most
 * `maxLinesPerExcerpt` lines (windows with more term hits first), then back in
 * line order. No hit → the first `fallbackLines` lines. Line numbers are kept.
 */
export function compactLines(text: string, startLine: number, terms: readonly string[]): ExcerptLine[] {
	const all = text.split('\n').map((t, i) => ({ line: startLine + i, text: t }));
	const hits = all.filter((l) => terms.some((t) => l.text.toLowerCase().includes(t))).map((l) => l.line);
	if (hits.length === 0) return all.slice(0, EXCERPT_LIMITS.fallbackLines);
	const { contextLines: c, mergeGap, maxLinesPerExcerpt } = EXCERPT_LIMITS;
	const last = startLine + all.length - 1;
	const windows: { a: number; z: number; hits: number }[] = [];
	for (const h of hits) {
		const a = Math.max(startLine, h - c);
		const z = Math.min(last, h + c);
		const prev = windows[windows.length - 1];
		if (prev && a <= prev.z + mergeGap + 1) {
			prev.z = Math.max(prev.z, z);
			prev.hits++;
		} else windows.push({ a, z, hits: 1 });
	}
	const chosen: typeof windows = [];
	let used = 0;
	for (const w of [...windows].sort((x, y) => y.hits - x.hits || x.a - y.a)) {
		const size = w.z - w.a + 1;
		if (used + size > maxLinesPerExcerpt) {
			const room = maxLinesPerExcerpt - used;
			if (room > 0 && chosen.length === 0) chosen.push({ ...w, z: w.a + room - 1 });
			continue;
		}
		chosen.push(w);
		used += size;
	}
	const keep = new Set(chosen.flatMap((w) => Array.from({ length: w.z - w.a + 1 }, (_, i) => w.a + i)));
	return all.filter((l) => keep.has(l.line));
}

/** Lines [a, z] of a full file text (1-based, clipped). */
export function fileLines(text: string, a: number, z: number): ExcerptLine[] {
	const lines = text.split('\n');
	const out: ExcerptLine[] = [];
	for (let n = Math.max(1, a); n <= Math.min(lines.length, z); n++) out.push({ line: n, text: lines[n - 1] as string });
	return out;
}

/** Renders an excerpt for the prompt; skipped lines are shown as `…`. */
export function renderExcerpt(e: Excerpt): string {
	const out: string[] = [`[${e.id}] ${e.source_id}:${e.path}`];
	let prev: number | null = null;
	for (const l of e.lines) {
		if (prev !== null && l.line !== prev + 1) out.push('…');
		out.push(`${l.line}| ${l.text}`);
		prev = l.line;
	}
	return out.join('\n');
}

export const GROUNDED_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['status', 'claims'],
	properties: {
		status: { type: 'string', enum: ['answered', 'insufficient_evidence'] },
		claims: {
			type: 'array',
			maxItems: EXCERPT_LIMITS.maxClaims,
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['text', 'source_id', 'lines', 'quote'],
				properties: {
					text: { type: 'string' },
					source_id: { type: 'string', pattern: '^S[0-9]+$' },
					lines: {
						type: 'object',
						additionalProperties: false,
						required: ['start', 'end'],
						properties: { start: { type: 'integer' }, end: { type: 'integer' } },
					},
					quote: { type: 'string' },
				},
			},
		},
	},
} as const;

export interface GroundedClaim {
	text: string;
	source_id: string;
	lines: { start: number; end: number };
	quote: string;
}

export interface GroundedAnswer {
	status: 'answered' | 'insufficient_evidence';
	claims: GroundedClaim[];
}

export type Validation = { ok: true; answer: GroundedAnswer } | { ok: false; reasons: string[]; answer: GroundedAnswer | null };

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Mechanical, fail-closed check of a model answer against the excerpts it was
 * given. Any problem rejects the whole answer:
 * - not JSON / wrong shape / extra fields / unknown status;
 * - `answered` with no claims, `insufficient_evidence` with claims, too many claims;
 * - a claim citing an unknown excerpt, lines outside the lines that excerpt showed,
 *   start > end, an empty text, a quote shorter than minQuoteChars, or a quote that
 *   does not occur (whitespace-normalised) in the cited lines.
 */
export function validateGroundedAnswer(raw: string, excerpts: readonly Excerpt[]): Validation {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reasons: ['not valid JSON'], answer: null };
	}
	const reasons: string[] = [];
	if (!isObj(parsed) || Object.keys(parsed).sort().join() !== 'claims,status') return { ok: false, reasons: ['unexpected top-level shape'], answer: null };
	const { status, claims } = parsed;
	if (status !== 'answered' && status !== 'insufficient_evidence') return { ok: false, reasons: ['unknown status'], answer: null };
	if (!Array.isArray(claims)) return { ok: false, reasons: ['claims is not an array'], answer: null };
	const answer = parsed as unknown as GroundedAnswer;
	if (status === 'answered' && claims.length === 0) reasons.push('answered without claims');
	if (status === 'insufficient_evidence' && claims.length > 0) reasons.push('insufficient_evidence with claims');
	if (claims.length > EXCERPT_LIMITS.maxClaims) reasons.push(`more than ${EXCERPT_LIMITS.maxClaims} claims`);
	const byId = new Map(excerpts.map((e) => [e.id, e]));
	claims.forEach((c: unknown, i) => {
		const at = `claim ${i + 1}`;
		if (!isObj(c) || Object.keys(c).sort().join() !== 'lines,quote,source_id,text') return void reasons.push(`${at}: unexpected shape`);
		const { text, source_id, lines, quote } = c;
		if (typeof text !== 'string' || !text.trim()) reasons.push(`${at}: empty text`);
		if (!isObj(lines) || !Number.isInteger(lines.start) || !Number.isInteger(lines.end)) return void reasons.push(`${at}: invalid lines`);
		const start = lines.start as number;
		const end = lines.end as number;
		if (start > end) return void reasons.push(`${at}: start > end`);
		const e = typeof source_id === 'string' ? byId.get(source_id) : undefined;
		if (!e) return void reasons.push(`${at}: unknown excerpt ${String(source_id)}`);
		const shown = new Map(e.lines.map((l) => [l.line, l.text]));
		for (let n = start; n <= end; n++) if (!shown.has(n)) return void reasons.push(`${at}: line ${n} was not shown in ${e.id}`);
		if (typeof quote !== 'string' || norm(quote).length < EXCERPT_LIMITS.minQuoteChars) return void reasons.push(`${at}: quote too short`);
		const cited = norm(Array.from({ length: end - start + 1 }, (_, k) => shown.get(start + k) as string).join('\n'));
		if (!cited.includes(norm(quote))) reasons.push(`${at}: quote not found in ${e.id}:L${start}-L${end}`);
	});
	return reasons.length ? { ok: false, reasons, answer } : { ok: true, answer };
}
