import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import { validateFixture, type EvalFixture, type Evidence } from '../src/eval/fixture.js';
import { aggregate, distribution, overlaps, scoreQuestion } from '../src/eval/metrics.js';
import { renderMarkdown, runEvaluation } from '../src/eval/run.js';
import { Registry } from '../src/registry.js';
import { buildIndex, loadIndex } from '../src/retrieval/index.js';
import { DEFAULT_TUNING, search } from '../src/retrieval/search.js';
import { ftsQuery } from '../src/retrieval/text.js';
import { createSnapshot, readSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

const ev = (path: string, a: number, b: number, anchor = 'x'): Evidence => ({ source_id: 'main', path, start_line: a, end_line: b, anchor });
const hit = (path: string, a: number, b: number) => ({ source_id: 'main', path, start_line: a, end_line: b });

describe('metrics (hand-computed)', () => {
	it('overlap is inclusive and requires the same source and path', () => {
		expect(overlaps(hit('a.ts', 10, 20), ev('a.ts', 20, 25))).toBe(true);
		expect(overlaps(hit('a.ts', 10, 20), ev('a.ts', 21, 25))).toBe(false);
		expect(overlaps(hit('a.ts', 10, 20), ev('b.ts', 10, 20))).toBe(false);
		expect(overlaps({ ...hit('a.ts', 10, 20), source_id: 'other' }, ev('a.ts', 10, 20))).toBe(false);
	});

	it('Hit@k, evidence Recall@k and reciprocal rank', () => {
		const expected = [ev('a.ts', 1, 5), ev('b.ts', 10, 12), ev('c.ts', 3, 3)];
		const retrieved = [hit('z.ts', 1, 9), hit('b.ts', 8, 11), hit('a.ts', 4, 30), hit('c.ts', 3, 3)];
		expect(scoreQuestion(retrieved, expected, 8)).toEqual({ hit: true, recall: 1, reciprocalRank: 0.5, firstRank: 2, foundEvidence: 3 });
		// only the top k count: with k=2 just b.ts is found
		expect(scoreQuestion(retrieved, expected, 2)).toEqual({ hit: true, recall: 1 / 3, reciprocalRank: 0.5, firstRank: 2, foundEvidence: 1 });
		expect(scoreQuestion([hit('z.ts', 1, 9)], expected, 8)).toEqual({ hit: false, recall: 0, reciprocalRank: 0, firstRank: null, foundEvidence: 0 });
		// two chunks covering the same evidence count it once
		expect(scoreQuestion([hit('a.ts', 1, 2), hit('a.ts', 3, 5)], [ev('a.ts', 1, 5)], 8).recall).toBe(1);
	});

	it('aggregate means and distribution', () => {
		const s = [
			{ hit: true, recall: 1, reciprocalRank: 1, firstRank: 1, foundEvidence: 1 },
			{ hit: false, recall: 0, reciprocalRank: 0, firstRank: null, foundEvidence: 0 },
			{ hit: true, recall: 0.5, reciprocalRank: 0.25, firstRank: 4, foundEvidence: 1 },
		];
		expect(aggregate(s)).toEqual({ n: 3, hitAtK: 2 / 3, evidenceRecallAtK: 0.5, mrrAtK: 1.25 / 3 });
		expect(aggregate([])).toEqual({ n: 0, hitAtK: 0, evidenceRecallAtK: 0, mrrAtK: 0 });
		expect(distribution([0.3, 0.1, 0.2, 0.4])).toEqual({ n: 4, min: 0.1, median: 0.25, max: 0.4 });
		expect(distribution([])).toEqual({ n: 0, min: null, median: null, max: null });
	});
});

const FILES = {
	'src/auth.ts': 'export function checkToken(token: string) {\n\tif (!token) throw new Error("no token");\n\treturn token.length > 3;\n}\n',
	'src/tour.ts': 'export function createTour(title: string) {\n\treturn { title, status: "draft" };\n}\n',
	'.env': 'X=1\n',
};

async function snapshotFixture(name: string): Promise<{ cfg: RuntimeConfig; snapshotId: string; root: string }> {
	const root = tempDir(name);
	const repo = makeRepo(root, 'repo', FILES);
	const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	reg.addProject('app', 'App');
	reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	return { cfg, root, snapshotId: (await createSnapshot(cfg, 'app')).report.snapshot_id };
}

function fixture(snapshotId: string, questions: EvalFixture['questions']): EvalFixture {
	return { schema: 1, project: 'app', snapshot_id: snapshotId, split: 'tuning', questions };
}

describe('expected-range validation against the real snapshot', () => {
	it('accepts real ranges and reports every kind of mismatch', async () => {
		const c = await snapshotFixture('fx-validate');
		const { manifest, chunks } = readSnapshot(c.cfg.dataDir, 'app', c.snapshotId);
		const good = fixture(c.snapshotId, [
			{ id: 'Q1', type: 'auth', question: 'How is the token checked?', expected: [ev('src/auth.ts', 1, 4, 'checkToken')] },
			{ id: 'Q2', type: 'abstention', question: 'How is payment handled?', expected: [], absence_evidence: [ev('src/tour.ts', 2, 2, 'draft')] },
		]);
		expect(validateFixture(good, manifest, chunks)).toEqual([]);
		const bad = fixture(c.snapshotId, [
			{ id: 'B1', type: 'auth', question: 'q', expected: [ev('src/missing.ts', 1, 2, 'abc')] },
			{ id: 'B2', type: 'auth', question: 'q', expected: [ev('.env', 1, 1, 'X=1')] },
			{ id: 'B3', type: 'auth', question: 'q', expected: [ev('src/auth.ts', 3, 2, 'abc')] },
			{ id: 'B4', type: 'auth', question: 'q', expected: [ev('src/auth.ts', 1, 40, 'checkToken')] },
			{ id: 'B5', type: 'auth', question: 'q', expected: [ev('src/auth.ts', 3, 4, 'checkToken')] },
			{ id: 'B6', type: 'abstention', question: 'q', expected: [ev('src/auth.ts', 1, 1, 'checkToken')] },
			{ id: 'B7', type: 'locate', question: 'q', expected: [] },
			{ id: 'B7', type: 'locate', question: 'q', expected: [ev('src/auth.ts', 1, 1, '')] },
			{ id: 'B9', type: 'bogus' as never, question: '  ', expected: [ev('src/auth.ts', 1, 1, 'checkToken')] },
		]);
		const problems = validateFixture(bad, manifest, chunks).join('\n');
		for (const fragment of [
			'B1 expected main:src/missing.ts:L1-2: file not in snapshot',
			'B2 expected main:.env:L1-1: file is excluded',
			'B3 expected main:src/auth.ts:L3-2: invalid line range',
			'B4 expected main:src/auth.ts:L1-40: range beyond end of file',
			'B5 expected main:src/auth.ts:L3-4: anchor "checkToken" not found in range',
			'B6: abstention question must not have expected evidence',
			'B7: answerable question needs expected evidence',
			'B7: duplicate id',
			'missing anchor',
			'B9: unknown type bogus',
			'B9: empty question',
		]) {
			expect(problems).toContain(fragment);
		}
	});
});

describe('evaluation runner (fake local embedding server)', () => {
	let server: FakeLlama;
	beforeAll(async () => {
		server = await startFakeLlama();
	});
	afterAll(async () => server.close());

	it('scores answerable questions, keeps abstention out of recall, and renders a report', async () => {
		const c = await snapshotFixture('fx-run');
		const lock: ModelsLock = {
			schema: 1,
			runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
			embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
		};
		const recipe = embeddingRecipeFromLock(lock);
		const provider = new LlamaCppEmbedding({ url: server.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE });
		await buildIndex(c.cfg, 'app', c.snapshotId, provider);
		const fx = fixture(c.snapshotId, [
			{ id: 'Q1', type: 'auth', question: 'How is the token checked?', expected: [ev('src/auth.ts', 1, 4, 'checkToken')] },
			{ id: 'Q2', type: 'locate', question: 'Where is a tour created?', expected: [ev('src/tour.ts', 1, 3, 'createTour')] },
			{ id: 'QA', type: 'abstention', question: 'How are refunds issued?', expected: [] },
		]);
		const result = await runEvaluation(c.cfg, 'app', c.snapshotId, fx, recipe, { modes: ['bm25', 'vector', 'hybrid'], k: 8, provider });
		expect(result.questions).toEqual({ total: 3, answerable: 2, abstention: 1 });
		for (const m of result.modes) {
			expect(m.overall.n).toBe(2);
			expect(m.abstention.n).toBe(1);
			expect(m.overall.hitAtK).toBe(1); // a 2-file repo: both files are always in the top 8
		}
		expect(result.perQuestion.filter((q) => q.id === 'QA').every((q) => q.score === null)).toBe(true);
		expect(renderMarkdown(result)).toContain('| hybrid | 1.000 |');
		// a fixture that does not match the snapshot is refused
		const wrong = fixture(c.snapshotId, [{ id: 'X', type: 'auth', question: 'q', expected: [ev('src/auth.ts', 1, 2, 'notthere')] }]);
		await expect(runEvaluation(c.cfg, 'app', c.snapshotId, wrong, recipe, { modes: ['bm25'], k: 8 })).rejects.toMatchObject({ code: 'USAGE' });
		await expect(runEvaluation(c.cfg, 'other', c.snapshotId, fx, recipe, { modes: ['bm25'], k: 8 })).rejects.toMatchObject({ code: 'USAGE' });
	});
});

describe('search tuning parameters', () => {
	it('stopwords drop question words but keep code words', () => {
		expect(ftsQuery('How does the AuthGuard read the token', { stopwords: true })).toBe('"authguard" OR "read" OR "token" OR "auth" OR "guard"');
		expect(ftsQuery('how does the', { stopwords: true })).toBeNull();
		expect(ftsQuery('How does it work')).toContain('"how"');
	});

	it('rejects invalid tuning values and documents the tuned defaults', async () => {
		const c = await snapshotFixture('fx-tuning');
		const { recipe } = { recipe: embeddingRecipeFromLock({ schema: 1, runtime: { name: 'f', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} }, embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 } }) };
		const server = await startFakeLlama();
		await buildIndex(c.cfg, 'app', c.snapshotId, new LlamaCppEmbedding({ url: server.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }));
		const index = loadIndex(c.cfg.dataDir, 'app', c.snapshotId, recipe);
		for (const tuning of [{ bm25Weights: [1, 1, 1] as never }, { bm25Weights: [1, 0, 1, 1] as const }, { rrfK: 0 }, { candidatePool: 2 }, { rrfWeights: [0, 0] as const }, { rrfWeights: [-1, 1] as const }]) {
			await expect(search(index, 'token', { mode: 'bm25', tuning })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
		}
		// rrfWeights only affect hybrid: a zero bm25 weight leaves bm25 mode intact
		const a = await search(index, 'token', { mode: 'bm25', tuning: { rrfWeights: [0, 1] } });
		const b = await search(index, 'token', { mode: 'bm25' });
		expect(a.map((h) => h.chunk_id)).toEqual(b.map((h) => h.chunk_id));
		expect(DEFAULT_TUNING).toEqual({ bm25Weights: [3, 3, 1, 2], rrfK: 30, candidatePool: 100, bm25Stopwords: false, rrfWeights: [1, 1] });
		index.db.close();
		await server.close();
	});
});

describe('repository fixtures', () => {
	it('ship only tuning splits', async () => {
		const { loadFixture } = await import('../src/eval/fixture.js');
		for (const f of ['gotrip', 'ky']) {
			const fx = loadFixture(join(import.meta.dirname, '..', 'eval', `${f}.tuning.json`));
			expect(fx.split).toBe('tuning');
			expect(fx.questions.filter((q) => q.type !== 'abstention').length).toBeGreaterThanOrEqual(8);
			expect(fx.questions.filter((q) => q.type === 'abstention').length).toBeGreaterThanOrEqual(2);
		}
	});
});
