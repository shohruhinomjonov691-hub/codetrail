/**
 * Grounded-answer helpers used by the AI explanation: compact excerpts keep line
 * numbers; the validator rejects the whole answer on any problem (fail-closed)
 * and builds every citation from the excerpt, never from the model.
 */
import { describe, expect, it } from 'vitest';
import { CITED_LIMITS, CITED_OUTPUT_BUDGET, CITED_SCHEMA, compactLines, EXCERPT_LIMITS, queryTerms, renderExcerpt, validateCitedAnswer, type Excerpt } from '../src/answer/grounded.js';

describe('queryTerms / compactLines', () => {
	it('drops stopwords and short words, splits identifiers', () => {
		expect(queryTerms('How is the requestTimeout implemented?')).toEqual(expect.arrayContaining(['requesttimeout', 'implemented', 'request', 'timeout']));
		expect(queryTerms('How is the requestTimeout implemented?')).not.toContain('the');
	});

	it('keeps matching lines with context, original line numbers, merged windows', () => {
		const text = Array.from({ length: 40 }, (_, i) => (i === 9 || i === 12 ? `const timeout = ${i};` : `line ${i}`)).join('\n');
		const lines = compactLines(text, 100, ['timeout']);
		expect(lines.map((l) => l.line)).toEqual([107, 108, 109, 110, 111, 112, 113, 114]); // 109±2 and 112±2 merged
		expect(lines.find((l) => l.line === 109)?.text).toBe('const timeout = 9;');
	});

	it('caps the excerpt and falls back to the first lines without hits', () => {
		const many = Array.from({ length: 200 }, (_, i) => `hit ${i}`).join('\n');
		expect(compactLines(many, 1, ['hit'])).toHaveLength(EXCERPT_LIMITS.maxLinesPerExcerpt);
		expect(compactLines('a\nb\nc', 5, ['zzz']).map((l) => l.line)).toEqual([5, 6, 7]);
		expect(compactLines(Array(50).fill('x').join('\n'), 1, ['zzz'])).toHaveLength(EXCERPT_LIMITS.fallbackLines);
	});

	it('renders gaps between kept lines', () => {
		const e: Excerpt = { id: 'S1', source_id: 'lib', path: 'a.ts', lines: [{ line: 3, text: 'x' }, { line: 4, text: 'y' }, { line: 9, text: 'z' }] };
		expect(renderExcerpt(e)).toBe('[S1] lib:a.ts\n3| x\n4| y\n…\n9| z');
	});
});

describe('cited-lines answers — server-derived citations, fail-closed', () => {
	const ex: Excerpt[] = [
		{ id: 'S1', source_id: 'lib', path: 'timeout.ts', lines: [{ line: 22, text: 'a' }, { line: 23, text: 'b' }, { line: 27, text: 'reject(new TimeoutError(request));' }] },
	];
	const ok = { status: 'answered', claims: [{ text: 'TimeoutError is raised.', source_id: 'S1', lines: { start: 27, end: 27 } }] };
	const v = (x: unknown, finish: string | null = 'stop') => validateCitedAnswer(typeof x === 'string' ? x : JSON.stringify(x), finish, ex);

	it('builds the citation text from the excerpt, not from the model', () => {
		const r = v(ok);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.answer.claims[0]?.citation).toEqual({ path: 'timeout.ts', source: 'lib', start: 27, end: 27, quote: 'reject(new TimeoutError(request));' });
		const two = v({ status: 'answered', claims: [{ text: 'x', source_id: 'S1', lines: { start: 22, end: 23 } }] });
		if (two.ok) expect(two.answer.claims[0]?.citation?.quote).toBe('a\nb');
		expect(v({ status: 'insufficient_evidence', claims: [] }).ok).toBe(true);
	});

	it.each([
		['incomplete generation', ok, 'length'],
		['missing finish reason', ok, null],
		['not JSON', '{"status":', 'stop'],
		['a quote field (model must not copy text)', { status: 'answered', claims: [{ ...ok.claims[0], quote: 'x' }] }, 'stop'],
		['answered without claims', { status: 'answered', claims: [] }, 'stop'],
		['abstention with claims', { status: 'insufficient_evidence', claims: ok.claims }, 'stop'],
		['unknown excerpt', { status: 'answered', claims: [{ ...ok.claims[0], source_id: 'S2' }] }, 'stop'],
		['line not shown', { status: 'answered', claims: [{ ...ok.claims[0], lines: { start: 23, end: 27 } }] }, 'stop'],
		['reversed range', { status: 'answered', claims: [{ ...ok.claims[0], lines: { start: 27, end: 22 } }] }, 'stop'],
		['too many lines', { status: 'answered', claims: [{ ...ok.claims[0], lines: { start: 1, end: CITED_LIMITS.maxCitedLines + 1 } }] }, 'stop'],
		['text too long', { status: 'answered', claims: [{ ...ok.claims[0], text: 'x'.repeat(CITED_LIMITS.maxTextChars + 1) }] }, 'stop'],
		['too many claims', { status: 'answered', claims: Array(CITED_LIMITS.maxClaims + 1).fill(ok.claims[0]) }, 'stop'],
	])('rejects: %s', (_, input, finish) => {
		expect(v(input, finish as string | null).ok).toBe(false);
	});

	it('"partial" is a boolean flag: required by the schema, validated, never text', () => {
		expect(CITED_SCHEMA.required).toEqual(['status', 'claims', 'partial']);
		const r = v({ ...ok, partial: true });
		expect(r.ok && r.answer.partial).toBe(true);
		const none = v(ok); // older/mock answers without the field read as "not partial"
		expect(none.ok && none.answer.partial).toBe(false);
		expect(v({ ...ok, partial: 'true' })).toMatchObject({ ok: false, codes: ['invalid_partial'] });
		expect(v({ ...ok, partial: false, extra: 1 }).ok).toBe(false);
		// a bad citation still rejects the whole answer, whatever the flag says
		expect(v({ status: 'answered', claims: [{ ...ok.claims[0], lines: { start: 23, end: 27 } }], partial: true }).ok).toBe(false);
	});

	it('codes carry no model text (reasons may)', () => {
		const r = v({ status: 'answered', claims: [{ ...ok.claims[0], source_id: 'SECRET words here' }] });
		expect(r).toMatchObject({ ok: false, codes: ['claim 1: unknown_excerpt'] });
		expect(v(ok, 'some_model_reason')).toMatchObject({ ok: false, codes: ['incomplete'] });
		expect(v('{"status":')).toMatchObject({ ok: false, codes: ['invalid_json'] });
	});

	it('one bad claim rejects the whole answer', () => {
		const r = v({ status: 'answered', claims: [ok.claims[0], { ...ok.claims[0], source_id: 'S9' }] });
		expect(r).toEqual({ ok: false, reasons: ['claim 2: unknown excerpt S9'], codes: ['claim 2: unknown_excerpt'] });
	});

	it('the schema bounds strings and arrays, and the output budget covers the bound', () => {
		const item = CITED_SCHEMA.properties.claims.items;
		expect(item.required).toEqual(['text', 'source_id', 'lines']);
		// OpenAI strict schemas reject minLength/maxLength; the validator enforces the length instead.
		expect(JSON.stringify(CITED_SCHEMA)).not.toMatch(/minLength|maxLength/);
		expect(CITED_SCHEMA.properties.claims.maxItems).toBe(CITED_LIMITS.maxClaims);
		// pessimistic: 2 chars/token for text + 50 tokens of structure per claim, + 40 envelope
		const worst = CITED_LIMITS.maxClaims * (CITED_LIMITS.maxTextChars / 2 + 50) + 40;
		expect(CITED_OUTPUT_BUDGET).toBeGreaterThanOrEqual(Math.ceil(worst * 1.4));
	});
});
