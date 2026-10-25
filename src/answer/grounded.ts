import { QUERY_STOPWORDS, splitIdentifiers } from '../retrieval/text.js';

/**
 * Grounded-answer building blocks used by the AI explanation (src/answer/explain.ts):
 * compact, line-numbered excerpts of retrieved chunks; the answer schema in
 * which the model cites only an excerpt id and a line range; and a fail-closed
 * validator that rejects the WHOLE answer on any problem and builds every
 * citation (path, lines, exact code) from the snapshot itself. A valid answer is
 * not proof that a claim is correct.
 */

export const EXCERPT_LIMITS = { contextLines: 2, mergeGap: 2, maxLinesPerExcerpt: 30, fallbackLines: 15 } as const;

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

/**
 * Answer schema (cited lines, server-derived quotes): the model names only the
 * excerpt and the line range; the server copies the cited text itself, so the
 * model is never asked to reproduce code. The claim count is bounded by the
 * schema; the claim text length is enforced by validateCitedAnswer.
 */
export const CITED_LIMITS = { maxClaims: 6, maxTextChars: 240, maxCitedLines: 12 } as const;

export const CITED_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['status', 'claims', 'missing'],
	properties: {
		status: { type: 'string', enum: ['answered', 'insufficient_evidence'] },
		// What the question asks that the excerpts do not show ("" when nothing is missing). Never cited,
		// so it may only name a gap; the UI shows it as "not confirmed by the retrieved code".
		missing: { type: 'string' },
		claims: {
			type: 'array',
			maxItems: CITED_LIMITS.maxClaims,
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['text', 'source_id', 'lines'],
				properties: {
					// Length is enforced by validateCitedAnswer: OpenAI strict schemas do not support minLength/maxLength.
					text: { type: 'string' },
					source_id: { type: 'string', pattern: '^S[0-9]{1,2}$' },
					lines: {
						type: 'object',
						additionalProperties: false,
						required: ['start', 'end'],
						properties: { start: { type: 'integer' }, end: { type: 'integer' } },
					},
				},
			},
		},
	},
} as const;

/**
 * Visible-answer budget for CITED_SCHEMA. Pessimistic per claim: 240 chars of
 * text at 2 chars/token = 120 tokens, plus ~50 tokens of keys, ids, numbers and
 * whitespace → ~170; 6 claims + `missing` (≤240 chars ≈ 120) + envelope ≈ 1180
 * tokens. 1536 leaves ~1.3× headroom. Reasoning tokens (if the model reasons) come on top; see
 * generation settings. A response that stops on the length limit is "incomplete".
 */
export const CITED_OUTPUT_BUDGET = 1536;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface CitedClaim {
	text: string;
	source_id: string;
	lines: { start: number; end: number };
	/** Filled in by the server from the cited excerpt lines, never by the model. */
	citation?: { path: string; source: string; start: number; end: number; quote: string };
}

export interface CitedAnswer {
	status: 'answered' | 'insufficient_evidence';
	claims: CitedClaim[];
	/** Uncited note naming what the excerpts do not show; "" when nothing is missing. */
	missing: string;
}

export type CitedValidation = { ok: true; answer: CitedAnswer } | { ok: false; reasons: string[] };

/**
 * Fail-closed check of a model answer. Rejects the WHOLE answer if the generation
 * did not finish (`finishReason` other than "stop"), the JSON is invalid or has
 * the wrong shape, `answered` has no claims or `insufficient_evidence` has
 * claims, or any claim cites an unknown excerpt, lines it did not show, a
 * reversed range or more than maxCitedLines lines. On success every claim gets a
 * server-built citation (path + exact cited text). Valid ≠ correct.
 */
export function validateCitedAnswer(raw: string, finishReason: string | null, excerpts: readonly Excerpt[]): CitedValidation {
	if (finishReason !== 'stop') return { ok: false, reasons: [`incomplete generation (finish_reason ${String(finishReason)})`] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reasons: ['not valid JSON'] };
	}
	// `missing` is required by the schema; an answer without it is read as "nothing missing" (it carries no evidence).
	const keys = isObj(parsed) ? Object.keys(parsed).sort().join() : '';
	if (keys !== 'claims,missing,status' && keys !== 'claims,status') return { ok: false, reasons: ['unexpected top-level shape'] };
	const { status, claims } = parsed as Record<string, unknown>;
	const missing = (parsed as Record<string, unknown>).missing ?? '';
	if (status !== 'answered' && status !== 'insufficient_evidence') return { ok: false, reasons: ['unknown status'] };
	if (!Array.isArray(claims)) return { ok: false, reasons: ['claims is not an array'] };
	const reasons: string[] = [];
	if (typeof missing !== 'string' || missing.length > CITED_LIMITS.maxTextChars) reasons.push('invalid missing note');
	if (status === 'answered' && claims.length === 0) reasons.push('answered without claims');
	if (status === 'insufficient_evidence' && claims.length > 0) reasons.push('insufficient_evidence with claims');
	if (claims.length > CITED_LIMITS.maxClaims) reasons.push(`more than ${CITED_LIMITS.maxClaims} claims`);
	const byId = new Map(excerpts.map((e) => [e.id, e]));
	const out: CitedClaim[] = [];
	claims.forEach((c: unknown, i) => {
		const at = `claim ${i + 1}`;
		if (!isObj(c) || Object.keys(c).sort().join() !== 'lines,source_id,text') return void reasons.push(`${at}: unexpected shape`);
		const { text, source_id, lines } = c;
		if (typeof text !== 'string' || !text.trim() || text.length > CITED_LIMITS.maxTextChars) return void reasons.push(`${at}: invalid text`);
		if (!isObj(lines) || !Number.isInteger(lines.start) || !Number.isInteger(lines.end)) return void reasons.push(`${at}: invalid lines`);
		const start = lines.start as number;
		const end = lines.end as number;
		if (start > end) return void reasons.push(`${at}: start > end`);
		if (end - start + 1 > CITED_LIMITS.maxCitedLines) return void reasons.push(`${at}: cites more than ${CITED_LIMITS.maxCitedLines} lines`);
		const e = typeof source_id === 'string' ? byId.get(source_id) : undefined;
		if (!e) return void reasons.push(`${at}: unknown excerpt ${String(source_id)}`);
		const shown = new Map(e.lines.map((l) => [l.line, l.text]));
		for (let n = start; n <= end; n++) if (!shown.has(n)) return void reasons.push(`${at}: line ${n} was not shown in ${e.id}`);
		const quote = Array.from({ length: end - start + 1 }, (_, k) => shown.get(start + k) as string).join('\n');
		out.push({ text, source_id: e.id, lines: { start, end }, citation: { path: e.path, source: e.source_id, start, end, quote } });
	});
	return reasons.length ? { ok: false, reasons } : { ok: true, answer: { status, claims: out, missing: (missing as string).trim() } };
}
