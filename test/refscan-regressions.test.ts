/**
 * Regressions for the Codex review of 28a202c..816c85f: reference-scan P2 (declaration line
 * dropped / occurrences merged) and P3 (`$` identifier boundaries).
 */
import { describe, expect, it } from 'vitest';
import { validateFixture, type EvalFixture } from '../src/eval/fixture.js';
import { scanReferences } from '../src/eval/reference-scan.js';
import type { ChunkRecord, Manifest } from '../src/snapshot.js';

const chunk = (path: string, text: string, start = 1, source_id = 'fe'): ChunkRecord =>
	({ path, source_id, start_line: start, end_line: start + text.split('\n').length - 1, text }) as ChunkRecord;

/** Occurrence count from either result shape (new `occurrences`, old `usages`). */
function count(r: ReturnType<typeof scanReferences>): number {
	const anyR = r as unknown as { occurrences?: unknown[]; usages?: unknown[] };
	return (anyR.occurrences ?? anyR.usages ?? []).length;
}

const scan = (identifier: string, declared_line = 1, declared_path = 'm.ts') => ({ identifier, source_id: 'fe', declared_path, declared_line, expect_usages: 0, expect_occurrences: 0 });

describe('P2 — every occurrence counts; only the declaration token is excluded', () => {
	it('a use on the declaration line is counted', () => {
		const r = scanReferences([chunk('m.ts', 'export const START_X = 1; consume(START_X);')], scan('START_X'));
		expect(count(r)).toBe(1);
		expect(r.passed).toBe(false);
	});

	it('two uses on one line are two occurrences', () => {
		const r = scanReferences([chunk('m.ts', 'export const START_X = 1;\nuse(START_X, START_X);')], scan('START_X'));
		expect(count(r)).toBe(2);
	});

	it('declaration-only stays at zero', () => {
		const r = scanReferences([chunk('m.ts', 'export const START_X = gql`\n  startX\n`;'), chunk('page.tsx', 'export const Page = () => null;')], scan('START_X'));
		expect(count(r)).toBe(0);
		expect(r.passed).toBe(true);
	});
});

describe('P3 — identifier boundaries follow JavaScript identifiers', () => {
	it('START_X$ and $START_X are different identifiers from START_X', () => {
		const chunks = [chunk('m.ts', 'export const START_X = 1;'), chunk('o.ts', 'const START_X$ = 2;\nconst $START_X = 3;\nf(START_X$, $START_X);')];
		expect(count(scanReferences(chunks, scan('START_X')))).toBe(0);
	});

	it('a $-prefixed declaration is accepted by the validator and scanned exactly', () => {
		const chunks = [chunk('m.ts', 'export const $START_X = 1;'), chunk('o.ts', 'g($START_X);\nh(START_X);')];
		const manifest = { files: [{ source_id: 'fe', path: 'm.ts', status: 'included' }, { source_id: 'fe', path: 'o.ts', status: 'included' }] } as unknown as Manifest;
		const fx = {
			schema: 2,
			project: 'app',
			snapshot_id: 'x'.repeat(24),
			split: 'tuning',
			questions: [
				{ id: 'U', type: 'unused', question: 'Is $START_X used?', required: [[{ source_id: 'fe', path: 'm.ts', start_line: 1, end_line: 1, anchor: '$START_X' }]], optional: [], reference_scan: scan('$START_X') },
			],
		} as unknown as EvalFixture;
		expect(validateFixture(fx, manifest, chunks)).toEqual([]);
		expect(count(scanReferences(chunks, scan('$START_X')))).toBe(1);
	});
});

describe('comments and strings are not code references', () => {
	it('mentions in comments, strings and templates are not counted', () => {
		const text = ['export const START_X = 1;', '// START_X is mentioned here', '/* START_X */', "const a = 'START_X';", 'const b = `START_X ${other}`;', 'const c = <span>START_X</span>;'].join('\n');
		const r = scanReferences([chunk('m.tsx', text)], scan('START_X', 1, 'm.tsx'));
		expect(count(r)).toBe(0);
	});

	it('a reference inside a template substitution is counted', () => {
		const r = scanReferences([chunk('m.ts', 'export const START_X = 1;\nconst t = `${START_X} and ${START_X}`;')], scan('START_X'));
		expect(count(r)).toBe(2);
	});
});
