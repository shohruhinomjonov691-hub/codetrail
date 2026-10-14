import type { Language } from '../chunker/index.js';

/**
 * The role a chunk plays in its repository, from its path and language only
 * (generic rules, no per-project configuration):
 * - doc: Markdown;
 * - data: JSON, YAML, GraphQL;
 * - test: code under a test directory (`test/`, `tests/`, `__tests__/`, `__mocks__/`,
 *   `spec/`, `specs/`, `e2e/`) or named `*.test.*` / `*.spec.*`;
 * - implementation: every other code file.
 */
export type ChunkRole = 'implementation' | 'test' | 'doc' | 'data';

const TEST_DIR = /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

export function chunkRole(path: string, language: Language): ChunkRole {
	if (language === 'markdown') return 'doc';
	if (language === 'json' || language === 'yaml' || language === 'graphql') return 'data';
	return TEST_DIR.test(path) || TEST_FILE.test(path) ? 'test' : 'implementation';
}

/** Role slots of the `role-slots` selection: k - floor(k/4) implementation, floor(k/4) other (k=8 → 6 + 2). */
export function roleSlots(k: number): { implementation: number; other: number } {
	const other = Math.floor(k / 4);
	return { implementation: k - other, other };
}

/**
 * `role-slots` selection over an already ranked candidate list (best first):
 * take candidates in rank order into their slot (implementation or other) while
 * that slot has room; if fewer than k were taken, fill the remaining places
 * from the leftover candidates in rank order. The result keeps the original
 * rank order — this only decides WHICH candidates make the top k, never reorders them.
 */
export function selectRoleSlots<T>(ranked: readonly T[], k: number, roleOf: (item: T) => ChunkRole): T[] {
	const slots = roleSlots(k);
	const taken = new Set<number>();
	let impl = 0;
	let other = 0;
	ranked.forEach((item, i) => {
		if (roleOf(item) === 'implementation') {
			if (impl < slots.implementation) (impl++, taken.add(i));
		} else if (other < slots.other) (other++, taken.add(i));
	});
	for (let i = 0; i < ranked.length && taken.size < k; i++) taken.add(i);
	return ranked.filter((_, i) => taken.has(i));
}
