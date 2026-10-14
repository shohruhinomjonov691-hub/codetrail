/**
 * D0b grounded-answer helpers: compact excerpts keep line numbers; the validator
 * rejects the whole answer on any problem (fail-closed).
 */
import { describe, expect, it } from 'vitest';
import { CITED_LIMITS, CITED_OUTPUT_BUDGET, CITED_SCHEMA, compactLines, EXCERPT_LIMITS, fileLines, GROUNDED_SCHEMA, queryTerms, renderExcerpt, validateCitedAnswer, validateGroundedAnswer, type Excerpt } from '../src/eval/grounded.js';

describe('queryTerms / compactLines / fileLines', () => {
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

	it('fileLines clips to the file', () => {
		expect(fileLines('a\nb\nc', 0, 9).map((l) => l.line)).toEqual([1, 2, 3]);
	});

	it('renders gaps between kept lines', () => {
		const e: Excerpt = { id: 'S1', source_id: 'lib', path: 'a.ts', lines: [{ line: 3, text: 'x' }, { line: 4, text: 'y' }, { line: 9, text: 'z' }] };
		expect(renderExcerpt(e)).toBe('[S1] lib:a.ts\n3| x\n4| y\n…\n9| z');
	});

	it('the schema requires status and claims only', () => {
		expect(GROUNDED_SCHEMA.required).toEqual(['status', 'claims']);
		expect(GROUNDED_SCHEMA.properties.claims.items.required).toEqual(['text', 'source_id', 'lines', 'quote']);
	});
});

describe('validateGroundedAnswer — fail-closed', () => {
	const ex: Excerpt[] = [
		{ id: 'S1', source_id: 'lib', path: 'timeout.ts', lines: [{ line: 22, text: '\ttimeoutId = setTimeout(() => {' }, { line: 27, text: '\t\treject(new TimeoutError(request));' }] },
		{ id: 'S2', source_id: 'lib', path: 'Ky.ts', lines: [{ line: 218, text: 'const d = ({timeout = 10_000}) => timeout;' }] },
	];
	const claim = (o: Partial<{ text: string; source_id: string; lines: { start: number; end: number }; quote: string }> = {}) => ({
		text: 'A TimeoutError is raised.',
		source_id: 'S1',
		lines: { start: 27, end: 27 },
		quote: 'new TimeoutError(request)',
		...o,
	});
	const v = (x: unknown) => validateGroundedAnswer(typeof x === 'string' ? x : JSON.stringify(x), ex);

	it('accepts a well-formed answer and a well-formed abstention', () => {
		expect(v({ status: 'answered', claims: [claim(), claim({ source_id: 'S2', lines: { start: 218, end: 218 }, quote: 'timeout = 10_000', text: 'Default is 10 s.' })] }).ok).toBe(true);
		expect(v({ status: 'insufficient_evidence', claims: [] }).ok).toBe(true);
	});

	it('quote matching ignores whitespace differences only', () => {
		expect(v({ status: 'answered', claims: [claim({ quote: 'reject(new   TimeoutError(request));' })] }).ok).toBe(true);
		expect(v({ status: 'answered', claims: [claim({ quote: 'new timeouterror(request)' })] }).ok).toBe(false);
	});

	it.each([
		['not JSON', '{"status": "answered", '],
		['extra top-level field', { status: 'answered', claims: [claim()], note: 'x' }],
		['unknown status', { status: 'maybe', claims: [] }],
		['answered without claims', { status: 'answered', claims: [] }],
		['abstention with claims', { status: 'insufficient_evidence', claims: [claim()] }],
		['too many claims', { status: 'answered', claims: Array(EXCERPT_LIMITS.maxClaims + 1).fill(claim()) }],
		['unknown excerpt', { status: 'answered', claims: [claim({ source_id: 'S9' })] }],
		['line not shown (gap inside excerpt)', { status: 'answered', claims: [claim({ lines: { start: 22, end: 27 } })] }],
		['start > end', { status: 'answered', claims: [claim({ lines: { start: 27, end: 22 } })] }],
		['quote not on cited lines', { status: 'answered', claims: [claim({ lines: { start: 22, end: 22 } })] }],
		['quote too short', { status: 'answered', claims: [claim({ quote: 'new' })] }],
		['empty text', { status: 'answered', claims: [claim({ text: ' ' })] }],
		['claim with extra field', { status: 'answered', claims: [{ ...claim(), confidence: 1 }] }],
	])('rejects: %s', (_, input) => {
		expect(v(input).ok).toBe(false);
	});

	it('one bad claim rejects the whole answer (good claims are not kept)', () => {
		const r = v({ status: 'answered', claims: [claim(), claim({ quote: 'something the code never says' })] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reasons).toEqual(['claim 2: quote not found in S1:L27-L27']);
	});
});

describe('D0c cited-lines protocol — server-derived citations, fail-closed', () => {
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

	it('one bad claim rejects the whole answer', () => {
		const r = v({ status: 'answered', claims: [ok.claims[0], { ...ok.claims[0], source_id: 'S9' }] });
		expect(r).toEqual({ ok: false, reasons: ['claim 2: unknown excerpt S9'] });
	});

	it('the schema bounds strings and arrays, and the output budget covers the bound', () => {
		const item = CITED_SCHEMA.properties.claims.items;
		expect(item.required).toEqual(['text', 'source_id', 'lines']);
		expect(item.properties.text.maxLength).toBe(CITED_LIMITS.maxTextChars);
		expect(CITED_SCHEMA.properties.claims.maxItems).toBe(CITED_LIMITS.maxClaims);
		// pessimistic: 2 chars/token for text + 50 tokens of structure per claim, + 40 envelope
		const worst = CITED_LIMITS.maxClaims * (CITED_LIMITS.maxTextChars / 2 + 50) + 40;
		expect(CITED_OUTPUT_BUDGET).toBeGreaterThanOrEqual(Math.ceil(worst * 1.4));
	});
});
