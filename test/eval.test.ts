import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import { validateFixture, type EvalFixture, type Evidence } from '../src/eval/fixture.js';
import { aggregate, distribution, retrievesEvidence, scoreQuestion, type ResolvedEvidence } from '../src/eval/metrics.js';
import { scanReferences } from '../src/eval/reference-scan.js';
import { renderMarkdown, runEvaluation } from '../src/eval/run.js';
import { Registry } from '../src/registry.js';
import { buildIndex, loadIndex } from '../src/retrieval/index.js';
import { DEFAULT_TUNING, search } from '../src/retrieval/search.js';
import { ftsQuery } from '../src/retrieval/text.js';
import { createSnapshot, readSnapshot, readSourceTexts, type SourceFileText } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

const ev = (path: string, a: number, b: number, anchor = 'x'): Evidence => ({ source_id: 'main', path, start_line: a, end_line: b, anchor });
const rev = (path: string, line: number, anchor: string): ResolvedEvidence => ({ ...ev(path, line, line, anchor), anchorLines: [line] });
/** A retrieved chunk whose text has `marker` on line `markerLine` (absolute). */
const chunk = (path: string, a: number, b: number, marks: Record<number, string> = {}) => ({
	source_id: 'main',
	path,
	start_line: a,
	end_line: b,
	text: Array.from({ length: b - a + 1 }, (_, i) => marks[a + i] ?? `line ${a + i}`).join('\n'),
});

describe('metrics (hand-computed, anchor-line scoring)', () => {
	it('a chunk retrieves evidence only if it contains the anchor line with the anchor text', () => {
		const e = rev('a.ts', 20, 'ANSWER');
		expect(retrievesEvidence(chunk('a.ts', 18, 25, { 20: 'return ANSWER;' }), e)).toBe(true);
		expect(retrievesEvidence(chunk('a.ts', 1, 3), { ...ev('a.ts', 3, 20, 'ANSWER'), anchorLines: [20] })).toBe(false); // overlap of the range only
		expect(retrievesEvidence(chunk('a.ts', 18, 25), e)).toBe(false); // covers the line but text differs (stale)
		expect(retrievesEvidence(chunk('b.ts', 18, 25, { 20: 'ANSWER' }), e)).toBe(false);
		expect(retrievesEvidence({ ...chunk('a.ts', 18, 25, { 20: 'ANSWER' }), source_id: 'other' }, e)).toBe(false);
		// two chunks are not combined: each alone lacks the anchor line
		const split = rev('a.ts', 20, 'ANSWER');
		expect(scoreQuestion([chunk('a.ts', 10, 19), chunk('a.ts', 21, 30)], [[split]], [], 8).hit).toBe(false);
	});

	it('required groups, alternatives and optional evidence', () => {
		const g1 = [rev('a.ts', 5, 'ALPHA'), rev('b.ts', 7, 'ALPHA_ALT')]; // either alternative satisfies group 1
		const g2 = [rev('c.ts', 2, 'GAMMA')];
		const g3 = [rev('d.ts', 9, 'DELTA')];
		const optional = [rev('e.ts', 1, 'EXTRA')];
		const retrieved = [chunk('z.ts', 1, 5), chunk('b.ts', 1, 10, { 7: 'ALPHA_ALT here' }), chunk('e.ts', 1, 3, { 1: 'EXTRA' }), chunk('c.ts', 1, 4, { 2: 'GAMMA()' })];
		// groups 1 and 2 satisfied, group 3 not → recall 2/3; first satisfying chunk at rank 2
		expect(scoreQuestion(retrieved, [g1, g2, g3], optional, 8)).toEqual({
			hit: true,
			recall: 2 / 3,
			reciprocalRank: 0.5,
			firstRank: 2,
			satisfiedGroups: 2,
			requiredGroups: 3,
			optionalFound: 1,
		});
		// k=3 cuts the GAMMA chunk at rank 4
		expect(scoreQuestion(retrieved, [g1, g2, g3], optional, 3)).toMatchObject({ recall: 1 / 3, satisfiedGroups: 1, optionalFound: 1 });
		// optional evidence alone is never a hit and never in the denominator
		expect(scoreQuestion([chunk('e.ts', 1, 3, { 1: 'EXTRA' })], [g3], optional, 8)).toMatchObject({ hit: false, recall: 0, reciprocalRank: 0, optionalFound: 1 });
		// both alternatives retrieved still count the group once
		expect(scoreQuestion([chunk('a.ts', 1, 9, { 5: 'ALPHA' }), chunk('b.ts', 1, 9, { 7: 'ALPHA_ALT' })], [g1], [], 8).recall).toBe(1);
	});

	it('aggregate means and distribution', () => {
		const base = { satisfiedGroups: 0, requiredGroups: 1, optionalFound: 0 };
		const s = [
			{ ...base, hit: true, recall: 1, reciprocalRank: 1, firstRank: 1 },
			{ ...base, hit: false, recall: 0, reciprocalRank: 0, firstRank: null },
			{ ...base, hit: true, recall: 0.5, reciprocalRank: 0.25, firstRank: 4 },
		];
		expect(aggregate(s)).toEqual({ n: 3, hitAtK: 2 / 3, evidenceRecallAtK: 0.5, mrrAtK: 1.25 / 3 });
		expect(aggregate([])).toEqual({ n: 0, hitAtK: 0, evidenceRecallAtK: 0, mrrAtK: 0 });
		expect(distribution([0.3, 0.1, 0.2, 0.4])).toEqual({ n: 4, min: 0.1, median: 0.25, max: 0.4 });
		expect(distribution([])).toEqual({ n: 0, min: null, median: null, max: null });
	});
});

describe('identifier-occurrence scan', () => {
	// Full file texts of one source (what readSourceTexts returns).
	const f = (path: string, text: string): SourceFileText => ({ path, text });
	it('counts identifier tokens outside the declaration token', () => {
		const files = [f('m.ts', '\n'.repeat(9) + 'export const START_X = gql`\n  startX\n`;'), f('page.tsx', "import { START_X as S } from './m';\nconst START_XY = 1;")];
		const r = scanReferences(files, { identifier: 'START_X', source_id: 'fe', declared_path: 'm.ts', declared_line: 10, expect_occurrences: 0 });
		expect(r.kind).toBe('identifier-occurrences');
		expect(r.declaration).toEqual({ path: 'm.ts', line: 10, column: 14 });
		expect(r.occurrences).toEqual([{ path: 'page.tsx', line: 1, column: 10 }]); // START_XY is another identifier
		expect(r.passed).toBe(false);
		expect(scanReferences(files.slice(0, 1), { identifier: 'START_X', source_id: 'fe', declared_path: 'm.ts', declared_line: 10, expect_occurrences: 0 }).passed).toBe(true);
	});

	it('fails when the declaration token is not found', () => {
		const r = scanReferences([f('m.ts', 'use(START_X);')], { identifier: 'START_X', source_id: 'fe', declared_path: 'm.ts', declared_line: 1, expect_occurrences: 1 });
		expect(r.declaration).toBeNull();
		expect(r.passed).toBe(false);
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

type Q = { id: string; type: EvalFixture['questions'][number]['type']; question: string; required: Evidence[][]; optional?: Evidence[]; absence_evidence?: Evidence[]; reference_scan?: EvalFixture['questions'][number]['reference_scan'] };
function fixture(snapshotId: string, questions: Q[]): EvalFixture {
	return { schema: 2, project: 'app', snapshot_id: snapshotId, split: 'tuning', questions: questions.map((q) => ({ optional: [], ...q })) };
}

describe('expected-range validation against the real snapshot', () => {
	it('accepts real ranges and reports every kind of mismatch', async () => {
		const c = await snapshotFixture('fx-validate');
		const { manifest, chunks } = readSnapshot(c.cfg.dataDir, 'app', c.snapshotId);
		const good = fixture(c.snapshotId, [
			{ id: 'Q1', type: 'auth', question: 'How is the token checked?', required: [[ev('src/auth.ts', 1, 4, 'checkToken')]], optional: [ev('src/tour.ts', 1, 1, 'createTour')] },
			{ id: 'Q2', type: 'abstention', question: 'How is payment handled?', required: [], absence_evidence: [ev('src/tour.ts', 2, 2, 'draft')] },
			{ id: 'Q3', type: 'unused', question: 'Is createTour used?', required: [[ev('src/tour.ts', 1, 1, 'createTour')]], reference_scan: { identifier: 'createTour', source_id: 'main', declared_path: 'src/tour.ts', declared_line: 1, expect_occurrences: 0 } },
		]);
		expect(validateFixture(good, manifest, chunks, (src) => readSourceTexts(c.cfg.dataDir, 'app', c.snapshotId, src))).toEqual([]);
		const bad = fixture(c.snapshotId, [
			{ id: 'B1', type: 'auth', question: 'q', required: [[ev('src/missing.ts', 1, 2, 'abc')]] },
			{ id: 'B2', type: 'auth', question: 'q', required: [[ev('.env', 1, 1, 'X=1')]] },
			{ id: 'B3', type: 'auth', question: 'q', required: [[ev('src/auth.ts', 3, 2, 'abc')]] },
			{ id: 'B4', type: 'auth', question: 'q', required: [[ev('src/auth.ts', 1, 40, 'checkToken')]] },
			{ id: 'B5', type: 'auth', question: 'q', required: [[ev('src/auth.ts', 3, 4, 'checkToken')]] },
			{ id: 'B6', type: 'abstention', question: 'q', required: [[ev('src/auth.ts', 1, 1, 'checkToken')]] },
			{ id: 'B7', type: 'locate', question: 'q', required: [] },
			{ id: 'B7', type: 'locate', question: 'q', required: [[ev('src/auth.ts', 1, 1, '')]] },
			{ id: 'B9', type: 'bogus' as never, question: '  ', required: [[ev('src/auth.ts', 1, 1, 'checkToken')]] },
			{ id: 'B10', type: 'locate', question: 'q', required: [[]] },
			{ id: 'B11', type: 'locate', question: 'q', required: [[ev('src/auth.ts', 1, 1, 'checkToken')]], optional: [ev('src/auth.ts', 1, 1, 'nope-not-here')] },
			{ id: 'B12', type: 'unused', question: 'q', required: [[ev('src/auth.ts', 1, 1, 'checkToken')]], reference_scan: { identifier: 'checkToken', source_id: 'main', declared_path: 'src/auth.ts', declared_line: 2, expect_usages: 0 } },
		]);
		const problems = validateFixture(bad, manifest, chunks, (src) => readSourceTexts(c.cfg.dataDir, 'app', c.snapshotId, src)).join('\n');
		for (const fragment of [
			'B1 required[1] main:src/missing.ts:L1-2: file not in snapshot',
			'B2 required[1] main:.env:L1-1: file is excluded',
			'B3 required[1] main:src/auth.ts:L3-2: invalid line range',
			'B4 required[1] main:src/auth.ts:L1-40: range beyond end of file',
			'B5 required[1] main:src/auth.ts:L3-4: anchor "checkToken" not found in range',
			'B6: abstention question must not have required or optional evidence',
			'B7: answerable question needs at least one required group',
			'B10: required group 1 is empty',
			'B11 optional main:src/auth.ts:L1-1: anchor "nope-not-here" not found in range',
			'B12: reference_scan expects one declaration of checkToken at src/auth.ts:2, found 0',
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
			{ id: 'Q1', type: 'auth', question: 'How is the token checked?', required: [[ev('src/auth.ts', 1, 4, 'checkToken')]] },
			{ id: 'Q2', type: 'locate', question: 'Where is a tour created?', required: [[ev('src/tour.ts', 1, 3, 'createTour')]] },
			{ id: 'QA', type: 'abstention', question: 'How are refunds issued?', required: [] },
			{ id: 'QU', type: 'unused', question: 'Is createTour used anywhere?', required: [[ev('src/tour.ts', 1, 1, 'createTour')]], reference_scan: { identifier: 'createTour', source_id: 'main', declared_path: 'src/tour.ts', declared_line: 1, expect_usages: 0 } },
		]);
		const result = await runEvaluation(c.cfg, 'app', c.snapshotId, fx, recipe, { modes: ['bm25', 'vector', 'hybrid'], k: 8, provider });
		expect(result.questions).toEqual({ total: 4, answerable: 3, abstention: 1 });
		expect(result.scoring).toBe('anchor-line/required-groups v2');
		expect(result.referenceScans).toEqual([{ id: 'QU', kind: 'identifier-occurrences', identifier: 'createTour', source_id: 'main', declaration: { path: 'src/tour.ts', line: 1, column: 17 }, expect_occurrences: 0, occurrences: [], passed: true }]);
		for (const m of result.modes) {
			expect(m.overall.n).toBe(3);
			expect(m.abstention.n).toBe(1);
			expect(m.overall.hitAtK).toBe(1); // a 2-file repo: both files are always in the top 8
		}
		expect(result.perQuestion.filter((q) => q.id === 'QA').every((q) => q.score === null)).toBe(true);
		expect(renderMarkdown(result)).toContain('| hybrid | 1.000 |');
		expect(renderMarkdown(result)).toContain('| QU | `createTour` | main | src/tour.ts:1:17 | 0 (none) | 0 | pass |');
		// a fixture that does not match the snapshot is refused
		const wrong = fixture(c.snapshotId, [{ id: 'X', type: 'auth', question: 'q', required: [[ev('src/auth.ts', 1, 2, 'notthere')]] }]);
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
			expect(fx.schema).toBe(2);
			expect(fx.questions.filter((q) => q.type !== 'abstention').length).toBeGreaterThanOrEqual(8);
			expect(fx.questions.filter((q) => q.type === 'abstention').length).toBeGreaterThanOrEqual(2);
		}
	});
});
