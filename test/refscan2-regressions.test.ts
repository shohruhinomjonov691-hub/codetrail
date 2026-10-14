/**
 * Regressions for the Codex review of 816c85f..ae74edb (reference scan): P2 reconstruction
 * creates false declarations, P2 escaped identifiers skipped, P3 declaration kinds missing.
 * Everything goes through the public runEvaluation path on a real snapshot.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { runEvaluation } from '../src/eval/run.js';
import { Registry } from '../src/registry.js';
import { buildIndex } from '../src/retrieval/index.js';
import { createSnapshot, readSnapshot, snapshotsRoot } from '../src/snapshot.js';
import { sha256Hex } from '../src/hash.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { CANARY, makeRepo, readAllBytes, tempDir } from './helpers.js';

// Codex reproducer: one-line methods, the class's lone `}` is covered by no chunk.
const methods = Array.from({ length: 125 }, (_, i) => `m${i}() { return ${i}; }`).join('\n');
const FILES: Record<string, string> = {
	// A class large enough to be split (its lone closing brace is not part of any chunk),
	// followed by a multi-line CALL of START_X — not a declaration.
	'src/big.ts': `class Big {\n${methods}\n}\nSTART_X(\n1,\n2,\n3,\n4,\n5\n);\n`,
	'src/client.ts': `const apiKey = "${CANARY.genericValue}";\nexport default apiKey;\n`,
	'.env': 'X=1\n',
	'src/decl.ts': 'export const START_X = 1;\nexport const START_Y = 2;\n',
	'src/use.ts': 'consume(\\u0053TART_Y);\n',
	'src/kinds.ts': [
		'namespace START_N {}',
		'class Holder {',
		'\tget START_G() {',
		'\t\treturn 1;',
		'\t}',
		'\tset START_S(v: number) {}',
		'}',
		'import START_I = require("lib");',
		'export function generic<START_T>(v: START_T): START_T {',
		'\treturn v;',
		'}',
		'declare module START_M {}',
		'const obj = { START_P: 1 };',
		'obj.START_P;',
		'callIt(START_C);',
		'export function START_C() {}',
	].join('\n') + '\n',
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
		embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 1024 },
	};
	recipe = embeddingRecipeFromLock(lock);
	const root = tempDir('refscan2');
	const repo = makeRepo(root, 'repo', FILES);
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	reg.addProject('app', 'App');
	reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	snapshotId = (await createSnapshot(cfg, 'app')).report.snapshot_id;
	await buildIndex(cfg, 'app', snapshotId, new LlamaCppEmbedding({ url: server.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }));
});
afterAll(async () => server.close());

function fixture(identifier: string, path: string, line: number, expect = 0) {
	return {
		schema: 2,
		project: 'app',
		snapshot_id: snapshotId,
		split: 'tuning',
		questions: [
			{
				id: 'U',
				type: 'unused',
				question: `Is ${identifier} used?`,
				required: [[{ source_id: 'main', path: 'src/decl.ts', start_line: 1, end_line: 1, anchor: 'START_X' }]],
				optional: [],
				reference_scan: { identifier, source_id: 'main', declared_path: path, declared_line: line, expect_occurrences: expect, expect_usages: expect },
			},
		],
	};
}

const scan = async (fx: ReturnType<typeof fixture>) => {
	const r = await runEvaluation(cfg, 'app', snapshotId, fx as never, recipe, { modes: ['bm25'], k: 8 });
	const s = r.referenceScans[0] as unknown as { passed: boolean; occurrences?: unknown[]; usages?: unknown[] };
	return { passed: s.passed, count: (s.occurrences ?? s.usages ?? []).length };
};

describe('P2 — the parser sees the exact file text, not a gap-filled reconstruction', () => {
	it('a multi-line call after a split class is not accepted as the declaration', async () => {
		// START_X( … ) at src/big.ts line 128 is a call; the real declaration is in src/decl.ts.
		const bigCallLine = 1 + 125 + 1 + 1; // class header + methods + closing brace → call line
		const { chunks } = readSnapshot(cfg.dataDir, 'app', snapshotId);
		const covered = new Set(chunks.filter((c) => c.path === 'src/big.ts').flatMap((c) => Array.from({ length: c.end_line - c.start_line + 1 }, (_, i) => c.start_line + i)));
		expect(covered.has(127)).toBe(false); // the precondition of the bug: the class's `}` is in no chunk
		await expect(runEvaluation(cfg, 'app', snapshotId, fixture('START_X', 'src/big.ts', bigCallLine) as never, recipe, { modes: ['bm25'], k: 8 })).rejects.toMatchObject({
			code: 'USAGE',
			message: expect.stringContaining('expects one declaration of START_X'),
		});
		// With the real declaration, the call is an occurrence.
		expect(await scan(fixture('START_X', 'src/decl.ts', 1))).toEqual({ passed: false, count: 1 });
	});
});

describe('P2 — escaped identifiers are the same identifier', () => {
	it('consume(\\u0053TART_Y) in another file counts as START_Y', async () => {
		expect(await scan(fixture('START_Y', 'src/decl.ts', 2))).toEqual({ passed: false, count: 1 });
	});
});

describe('P3 — all named declaration kinds are declarations; calls and property uses are not', () => {
	it.each([
		['START_N', 1, 0],
		['START_G', 3, 0],
		['START_S', 6, 0],
		['START_I', 8, 0],
		['START_T', 9, 2],
		['START_M', 12, 0],
		['START_C', 16, 1],
		['START_P', 13, 1],
	])('%s declared on line %i has %i other occurrence(s)', async (identifier, line, others) => {
		expect(await scan(fixture(identifier as string, 'src/kinds.ts', line as number, others as number))).toEqual({ passed: true, count: others });
	});

	it('a property access or call is not accepted as the declaration', async () => {
		await expect(runEvaluation(cfg, 'app', snapshotId, fixture('START_P', 'src/kinds.ts', 14) as never, recipe, { modes: ['bm25'], k: 8 })).rejects.toMatchObject({ code: 'USAGE' });
		await expect(runEvaluation(cfg, 'app', snapshotId, fixture('START_C', 'src/kinds.ts', 15) as never, recipe, { modes: ['bm25'], k: 8 })).rejects.toMatchObject({ code: 'USAGE' });
	});
});

describe('P2 — full texts come only from the snapshot store, verified, fail-closed', () => {
	const sid = () => snapshotId;
	const dirOf = (c: RuntimeConfig) => join(snapshotsRoot(c.dataDir, 'app'), sid());
	function tampered(name: string, mutate: (dir: string) => void): RuntimeConfig {
		const copy = { ...cfg, dataDir: join(tempDir(`refscan2-${name}`), 'data') };
		cpSync(cfg.dataDir, copy.dataDir, { recursive: true });
		mutate(dirOf(copy));
		return copy;
	}
	const evalWith = (c: RuntimeConfig) => runEvaluation(c, 'app', sid(), fixture('START_X', 'src/decl.ts', 1, 1) as never, recipe, { modes: ['bm25'], k: 8 });
	const fileSha = (path: string) => (JSON.parse(readFileSync(join(dirOf(cfg), 'manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] }).files.find((f) => f.path === path)!.sha256;

	it('stores exactly the included files (no excluded, no secret-suspected file)', () => {
		const manifest = JSON.parse(readFileSync(join(dirOf(cfg), 'manifest.json'), 'utf8')) as { schema: number; files: { status: string; sha256: string | null; reason: string | null }[] };
		expect(manifest.schema).toBe(2);
		const included = manifest.files.filter((f) => f.status === 'included').map((f) => f.sha256);
		expect(readdirSync(join(dirOf(cfg), 'files')).sort()).toEqual([...new Set(included)].sort());
		expect(manifest.files.filter((f) => f.reason === 'secret-suspected')).toHaveLength(1);
		expect(readAllBytes(cfg.dataDir).includes(CANARY.genericValue)).toBe(false);
		for (const sha of included) expect(sha256Hex(readFileSync(join(dirOf(cfg), 'files', sha as string)))).toBe(sha);
	});

	it('an old (schema 1) snapshot without stored files is refused with a rebuild command', async () => {
		const c = tampered('old', (dir) => {
			const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
			writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, schema: 1 }));
			rmSync(join(dir, 'files'), { recursive: true, force: true });
		});
		await expect(evalWith(c)).rejects.toMatchObject({ code: 'SNAPSHOT_OUTDATED', message: expect.stringContaining('codetrail snapshot create app') });
	});

	it('a stored file whose bytes do not match the manifest checksum is refused', async () => {
		const c = tampered('sha', (dir) => {
			mkdirSync(join(dir, 'files'), { recursive: true });
			writeFileSync(join(dir, 'files', fileSha('src/use.ts')), 'consume(START_Z);\n');
		});
		await expect(evalWith(c)).rejects.toMatchObject({ code: 'SNAPSHOT_CORRUPT', message: expect.stringContaining('checksum') });
	});

	it('a missing stored file is refused', async () => {
		const c = tampered('missing', (dir) => rmSync(join(dir, 'files', fileSha('src/use.ts')), { force: true }));
		await expect(evalWith(c)).rejects.toMatchObject({ code: 'SNAPSHOT_CORRUPT', message: expect.stringContaining('missing') });
	});

	it('chunks that disagree with the stored file (text or commit) are refused', async () => {
		const edit = (name: string, change: (c: Record<string, unknown>) => void) =>
			tampered(name, (dir) => {
				const lines = readFileSync(join(dir, 'chunks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
				change(lines.find((c: { path: string }) => c.path === 'src/decl.ts'));
				writeFileSync(join(dir, 'chunks.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
			});
		await expect(evalWith(edit('text', (c) => (c.text = String(c.text).replace('START_X', 'START_Q'))))).rejects.toMatchObject({ code: 'SNAPSHOT_CORRUPT' });
		await expect(evalWith(edit('commit', (c) => (c.commit = 'f'.repeat(40))))).rejects.toMatchObject({ code: 'SNAPSHOT_CORRUPT' });
	});
});
