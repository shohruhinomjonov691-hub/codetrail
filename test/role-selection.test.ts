/**
 * Role tagging and the experimental role-slots selection (hybrid-role eval mode).
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { runEvaluation } from '../src/eval/run.js';
import { Registry } from '../src/registry.js';
import { buildIndex, loadIndex } from '../src/retrieval/index.js';
import { chunkRole, roleSlots, selectRoleSlots, type ChunkRole } from '../src/retrieval/role.js';
import { search } from '../src/retrieval/search.js';
import { createSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

describe('chunkRole — generic path/language rules', () => {
	it.each([
		['README.md', 'markdown', 'doc'],
		['docs/ai/DECISIONS.md', 'markdown', 'doc'],
		['locales/en/common.json', 'json', 'data'],
		['.github/workflows/ci.yml', 'yaml', 'data'],
		['src/schema.graphql', 'graphql', 'data'],
		['test/retry.ts', 'typescript', 'test'],
		['packages/a/tests/x.js', 'javascript', 'test'],
		['src/__tests__/Button.tsx', 'tsx', 'test'],
		['src/__mocks__/api.ts', 'typescript', 'test'],
		['apps/web/e2e/login.ts', 'typescript', 'test'],
		['spec/helpers.js', 'javascript', 'test'],
		['src/tour.service.spec.ts', 'typescript', 'test'],
		['src/useGoTripAI.test.js', 'javascript', 'test'],
		['src/inspector.spec.mjs', 'javascript', 'test'],
		['source/core/Ky.ts', 'typescript', 'implementation'],
		['src/latest/foo.ts', 'typescript', 'implementation'],
		['src/contest.ts', 'typescript', 'implementation'],
		['src/testing-utils.ts', 'typescript', 'implementation'],
		['src/specification.tsx', 'tsx', 'implementation'],
		['vite.config.ts', 'typescript', 'implementation'],
	] as const)('%s → %s', (path, language, role) => {
		expect(chunkRole(path, language)).toBe(role);
	});
});

describe('roleSlots / selectRoleSlots', () => {
	it('k=8 gives 6 implementation + 2 other slots', () => {
		expect(roleSlots(8)).toEqual({ implementation: 6, other: 2 });
		expect(roleSlots(1)).toEqual({ implementation: 1, other: 0 });
		expect(roleSlots(4)).toEqual({ implementation: 3, other: 1 });
		expect(roleSlots(20)).toEqual({ implementation: 15, other: 5 });
	});

	const items = (spec: string): { id: string; role: ChunkRole }[] =>
		spec.split(' ').map((s, i) => ({ id: `${s}${i}`, role: ({ I: 'implementation', T: 'test', D: 'doc', J: 'data' } as const)[s as 'I' | 'T' | 'D' | 'J'] }));
	const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join(' ');

	it('caps other roles at 2 and keeps rank order', () => {
		const ranked = items('D T T J I I D I I I I I');
		expect(ids(selectRoleSlots(ranked, 8, (x) => x.role))).toBe('D0 T1 I4 I5 I7 I8 I9 I10');
	});

	it('fills short implementation slots from the remaining candidates in rank order', () => {
		const ranked = items('T T T I D D T I');
		expect(ids(selectRoleSlots(ranked, 8, (x) => x.role))).toBe('T0 T1 T2 I3 D4 D5 T6 I7');
		expect(ids(selectRoleSlots(items('T T T T I T'), 4, (x) => x.role))).toBe('T0 T1 T2 I4');
	});

	it('reserves the other slots even for a lower-ranked other role; spare slots go by rank', () => {
		// 6 implementation slots + D9 in an other slot; the one spare slot goes to the next by rank (I6).
		expect(ids(selectRoleSlots(items('I I I I I I I I I D'), 8, (x) => x.role))).toBe('I0 I1 I2 I3 I4 I5 I6 D9');
		// no other roles at all → plain top-k
		expect(ids(selectRoleSlots(items('I I I I I I I I I'), 8, (x) => x.role))).toBe('I0 I1 I2 I3 I4 I5 I6 I7');
	});

	it('returns everything when there are fewer than k candidates', () => {
		expect(ids(selectRoleSlots(items('D I T'), 8, (x) => x.role))).toBe('D0 I1 T2');
		expect(selectRoleSlots([], 8, () => 'implementation')).toEqual([]);
	});

	it('with only implementation candidates it equals plain top-k', () => {
		const ranked = items('I I I I I I I I I I');
		expect(selectRoleSlots(ranked, 8, (x) => x.role)).toEqual(ranked.slice(0, 8));
	});
});

describe('role-slots through search and evaluation', () => {
	let server: FakeLlama;
	let recipe: EmbeddingRecipe;
	let cfg: RuntimeConfig;
	let snapshotId: string;
	const files: Record<string, string> = {
		'src/impl.ts': 'export function retryRequest() {\n\treturn "retry";\n}\n',
		'src/backoff.ts': 'export function backoff(retry: number) {\n\treturn retry * 2;\n}\n',
		'src/limit.ts': 'export const retryLimit = 2;\n',
	};
	for (let i = 0; i < 4; i++) files[`docs/retry-${i}.md`] = `# retry retry retry ${i}\n\nretry retry retry docs\n`;
	for (let i = 0; i < 4; i++) files[`test/retry-${i}.ts`] = `test("retry retry retry ${i}", () => retry());\n`;

	beforeAll(async () => {
		server = await startFakeLlama();
		const lock: ModelsLock = {
			schema: 1,
			runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
			embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
		};
		recipe = embeddingRecipeFromLock(lock);
		const root = tempDir('roles');
		const repo = makeRepo(root, 'repo', files);
		cfg = { dataDir: join(root, 'data'), localRoots: [root] };
		const reg = new Registry(cfg.dataDir);
		reg.addProject('app', 'App');
		reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
		snapshotId = (await createSnapshot(cfg, 'app')).report.snapshot_id;
		await buildIndex(cfg, 'app', snapshotId, new LlamaCppEmbedding({ url: server.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }));
	});
	afterAll(async () => server.close());

	it('default selection is unchanged rank order; role-slots limits other roles to floor(k/4)', async () => {
		const index = loadIndex(cfg.dataDir, 'app', snapshotId, recipe);
		try {
			const q = 'retry retry retry';
			const def = await search(index, q, { mode: 'bm25', k: 4 });
			const rank = await search(index, q, { mode: 'bm25', k: 4, selection: 'rank' });
			const roles = await search(index, q, { mode: 'bm25', k: 4, selection: 'role-slots' });
			expect(def).toEqual(rank);
			expect(def.every((h) => h.role !== 'implementation')).toBe(true); // docs/tests outrank the code here
			expect(roles.filter((h) => h.role !== 'implementation')).toHaveLength(1);
			expect(roles.filter((h) => h.role === 'implementation')).toHaveLength(3);
			expect(roles.map((h) => h.path)).toContain('src/impl.ts');
			// kept in rank order
			expect([...roles].sort((a, b) => b.scores.rrf - a.scores.rrf)).toEqual(roles);
			await expect(search(index, q, { mode: 'bm25', selection: 'bogus' as never })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
		} finally {
			index.db.close();
		}
	});

	it('hybrid-role is a separate evaluation mode next to hybrid', async () => {
		const fx = {
			schema: 2,
			project: 'app',
			snapshot_id: snapshotId,
			split: 'tuning',
			questions: [{ id: 'Q', type: 'locate', question: 'retry retry retry', required: [[{ source_id: 'main', path: 'src/impl.ts', start_line: 1, end_line: 3, anchor: 'retryRequest' }]], optional: [] }],
		};
		const provider = new LlamaCppEmbedding({ url: server.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE });
		const r = await runEvaluation(cfg, 'app', snapshotId, fx as never, recipe, { modes: ['hybrid', 'hybrid-role'], k: 2, provider });
		expect(r.modes.map((m) => m.mode)).toEqual(['hybrid', 'hybrid-role']);
		expect(r.perQuestion.map((q) => q.mode)).toEqual(['hybrid', 'hybrid-role']);
	});
});
