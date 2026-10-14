/**
 * Regressions for the Codex C3 review (91d8022..28a202c): three P2 findings.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { loadFixture } from '../src/eval/fixture.js';
import { runEvaluation } from '../src/eval/run.js';
import { Registry } from '../src/registry.js';
import { buildIndex } from '../src/retrieval/index.js';
import { createSnapshot, readSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { DIST, makeRepo, tempDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');

// Line 1-3: alpha (one chunk). Line 5-24: beta (another chunk), the decisive line is 20.
const BETA_BODY = Array.from({ length: 18 }, (_, i) => (i === 14 ? '\treturn DECISIVE_ANSWER;' : `\tconst filler${i} = ${i};`)).join('\n');
const FILES = {
	'src/mod.ts': `export function alphaToken(token: string) {\n\treturn token;\n}\n\nexport function betaToken() {\n${BETA_BODY}\n}\n`,
};

let server: FakeLlama;
let recipe: EmbeddingRecipe;
let cfg: RuntimeConfig;
let snapshotId: string;

beforeAll(async () => {
	server = await startFakeLlama();
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
		embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
	};
	recipe = embeddingRecipeFromLock(lock);
	const root = tempDir('c3-review');
	const repo = makeRepo(root, 'repo', FILES);
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	reg.addProject('app', 'App');
	reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	snapshotId = (await createSnapshot(cfg, 'app')).report.snapshot_id;
	await buildIndex(cfg, 'app', snapshotId, new LlamaCppEmbedding({ url: server.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }));
});
afterAll(async () => server.close());

describe('P2-1 — a one-line overlap is not evidence', () => {
	it('expected L3–20 with the anchor on L20, retrieved chunk L1–3 only → no hit', async () => {
		const { chunks } = readSnapshot(cfg.dataDir, 'app', snapshotId);
		const alpha = chunks.find((c) => c.symbol === 'alphaToken');
		const beta = chunks.find((c) => c.symbol === 'betaToken');
		expect([alpha?.start_line, alpha?.end_line]).toEqual([1, 3]);
		expect(beta!.start_line).toBeGreaterThan(3);
		// schema-1 shape (still accepted): one expected range, anchor on line 20
		const fx = {
			schema: 1,
			project: 'app',
			snapshot_id: snapshotId,
			split: 'tuning',
			questions: [{ id: 'R1', type: 'locate', question: 'alphaToken token', expected: [{ source_id: 'main', path: 'src/mod.ts', start_line: 3, end_line: 20, anchor: 'DECISIVE_ANSWER' }] }],
		};
		const result = await runEvaluation(cfg, 'app', snapshotId, fx as never, recipe, { modes: ['bm25'], k: 1 });
		const q = result.perQuestion.find((r) => r.id === 'R1');
		expect(q?.top1?.citation).toContain(':L1-3'); // only the alpha chunk was retrieved
		expect(q?.score?.hit).toBe(false);
		expect(q?.score?.recall).toBe(0);
		expect(q?.score?.reciprocalRank).toBe(0);
	});
});

describe('P2-3 — the fixture must belong to the evaluated snapshot', () => {
	it('a fixture for another snapshot id is refused before any evaluation', async () => {
		const fx = {
			schema: 1,
			project: 'app',
			snapshot_id: 'ffffffffffffffffffffffff',
			split: 'tuning',
			questions: [{ id: 'R1', type: 'locate', question: 'alpha', expected: [{ source_id: 'main', path: 'src/mod.ts', start_line: 1, end_line: 3, anchor: 'alphaToken' }] }],
		};
		await expect(runEvaluation(cfg, 'app', snapshotId, fx as never, recipe, { modes: ['bm25'], k: 8 })).rejects.toMatchObject({
			code: 'USAGE',
			message: expect.stringContaining('ffffffffffffffffffffffff'),
		});
	});
});

describe('P2-3 — CLI writes no report on a snapshot mismatch', () => {
	it('exits with an error and leaves the output directory absent', () => {
		const dir = tempDir('c3-cli');
		const fixturePath = join(dir, 'fx.json');
		writeFileSync(fixturePath, JSON.stringify({ schema: 1, project: 'app', snapshot_id: 'ffffffffffffffffffffffff', split: 'tuning', questions: [{ id: 'R1', type: 'locate', question: 'alpha', expected: [{ source_id: 'main', path: 'src/mod.ts', start_line: 1, end_line: 3, anchor: 'alphaToken' }] }] }));
		const lockPath = join(dir, 'models.lock.json');
		writeFileSync(lockPath, JSON.stringify({
			schema: 1,
			runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
			embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
		}));
		const out = join(dir, 'reports');
		const res = spawnSync(process.execPath, [join(DIST, 'cli.js'), 'eval', 'app', snapshotId, fixturePath, '--mode', 'bm25', '--out', out], {
			encoding: 'utf8',
			env: { ...process.env, CODETRAIL_DATA_DIR: cfg.dataDir, CODETRAIL_MODELS_LOCK: lockPath, CODETRAIL_EMBED_MODEL_FILE: FAKE_MODEL_FILE },
		});
		expect(res.stderr).toContain('ffffffffffffffffffffffff');
		expect(res.status).not.toBe(0);
		expect(existsSync(out)).toBe(false);
	});
});

describe('P2-2 — required / alternative / optional evidence in the repository fixtures', () => {
	const fx = (name: string) => loadFixture(join(ROOT, 'eval', `${name}.tuning.json`)) as unknown as {
		questions: { id: string; type: string; required?: { path: string; anchor: string }[][]; optional?: { path: string; anchor: string }[]; reference_scan?: { identifier: string; expect_usages: number } }[];
	};

	it('K4: the timeout implementation is required, the error class is optional', () => {
		const k4 = fx('ky').questions.find((q) => q.id === 'K4');
		expect([...new Set(k4?.required?.flat().map((e) => e.path))]).toEqual(['source/utils/timeout.ts']);
		expect(k4?.optional?.map((e) => e.path)).toContain('source/errors/TimeoutError.ts');
	});

	it('T16: declaration presence is not a usage proof — a reference scan is declared', () => {
		const t16 = fx('gotrip').questions.find((q) => q.id === 'T16');
		expect(t16?.reference_scan).toMatchObject({ identifier: 'START_CONVERSATION', expect_usages: 0 });
		expect(t16?.optional?.map((e) => e.path)).toContain('apps/gotrip-api/src/components/message/message.resolver.ts');
	});
});
