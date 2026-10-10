import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { LineIndex } from '../src/chunker/index.js';
import type { RuntimeConfig } from '../src/config.js';
import { CodeTrailError } from '../src/errors.js';
import { GIT_SAFE_CONFIG, gitArgs } from '../src/git.js';
import { Registry } from '../src/registry.js';
import { createSnapshot, readSnapshot } from '../src/snapshot.js';
import { CANARY, commitFiles, git, makeRepo, readAllBytes, tempDir, writeFiles } from './helpers.js';

const APP_FILES = {
	'src/app.ts': "import { b } from './b';\n\nexport function main(): number {\n\treturn b() + 1;\n}\n",
	'src/b.ts': 'export const b = (): number => 41;\n',
	'README.md': '# Fixture\n\nA tiny app.\n',
	'package.json': '{\n  "name": "fixture"\n}\n',
	'package-lock.json': '{}\n',
	'.env': 'SECRET_TOKEN=dont-index-me\n',
	'node_modules/dep/index.js': 'module.exports = 1;\n',
	'public/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
	'src/data.json': Buffer.from([0x7b, 0x00, 0x7d]),
	'src/link-out.ts': { symlink: '/etc/hosts' },
};

function setup(name: string, files: Record<string, unknown> = APP_FILES): { cfg: RuntimeConfig; registry: Registry; repo: { dir: string; sha: string } } {
	const root = tempDir(name);
	const repo = makeRepo(root, 'repo', files as never);
	const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
	const registry = new Registry(cfg.dataDir);
	registry.addProject('app', 'App');
	registry.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	return { cfg, registry, repo };
}

describe('snapshot pipeline', () => {
	let ctx: ReturnType<typeof setup>;
	let result: Awaited<ReturnType<typeof createSnapshot>>;
	let statusBefore: string;
	let headBefore: string;

	beforeAll(async () => {
		ctx = setup('pipeline');
		// uncommitted + untracked changes that must NOT be indexed
		writeFiles(ctx.repo.dir, { 'src/b.ts': 'export const b = (): number => 999; // uncommitted\n', 'src/untracked.ts': 'export const u = 1;\n' });
		statusBefore = git(ctx.repo.dir, 'status', '--porcelain');
		headBefore = git(ctx.repo.dir, 'rev-parse', 'HEAD');
		result = await createSnapshot(ctx.cfg, 'app');
	});

	it('creates a ready snapshot pinned to the exact commit', () => {
		expect(result.status).toBe('created');
		expect(result.report.status).toBe('ready');
		expect(result.report.sources).toEqual([
			{ source_id: 'main', kind: 'local', location: ctx.repo.dir, commit: ctx.repo.sha, ref: 'main' },
		]);
	});

	it('reads committed blobs only and leaves the source repo untouched', () => {
		const { chunks, manifest } = readSnapshot(ctx.cfg.dataDir, 'app', result.report.snapshot_id);
		const all = chunks.map((c) => c.text).join('\n');
		expect(all).toContain('41');
		expect(all).not.toContain('999');
		expect(manifest.files.some((f) => f.path === 'src/untracked.ts')).toBe(false);
		expect(git(ctx.repo.dir, 'status', '--porcelain')).toBe(statusBefore);
		expect(git(ctx.repo.dir, 'rev-parse', 'HEAD')).toBe(headBefore);
	});

	it('records every exclusion with a reason', () => {
		const { manifest } = readSnapshot(ctx.cfg.dataDir, 'app', result.report.snapshot_id);
		const status = Object.fromEntries(manifest.files.map((f) => [f.path, f.reason ?? f.status]));
		expect(status).toEqual({
			'.env': 'denied-file',
			'README.md': 'included',
			'node_modules/dep/index.js': 'denied-dir',
			'package-lock.json': 'denied-file',
			'package.json': 'included',
			'public/logo.png': 'extension',
			'src/app.ts': 'included',
			'src/b.ts': 'included',
			'src/data.json': 'binary',
			'src/link-out.ts': 'symlink',
		});
		expect(readAllBytes(ctx.cfg.dataDir).includes('dont-index-me')).toBe(false);
	});

	it('stores chunks whose text matches the committed file lines exactly', () => {
		const { chunks, manifest } = readSnapshot(ctx.cfg.dataDir, 'app', result.report.snapshot_id);
		for (const c of chunks) {
			const blob = manifest.files.find((f) => f.path === c.path)?.blob as string;
			const committed = execFileSync('git', ['cat-file', 'blob', blob], { cwd: ctx.repo.dir, encoding: 'utf8' });
			expect(new LineIndex(committed).slice(c.start_line, c.end_line)).toBe(c.text);
			expect(c).toMatchObject({ project_id: 'app', source_id: 'main', commit: ctx.repo.sha, snapshot_id: result.report.snapshot_id });
			expect(c.id).toMatch(/^[0-9a-f]{32}$/);
		}
		expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
	});

	it('does not overwrite an existing snapshot', async () => {
		const manifestPath = join(result.dir, 'manifest.json');
		const before = statSync(manifestPath).mtimeMs;
		const again = await createSnapshot(ctx.cfg, 'app');
		expect(again.status).toBe('exists');
		expect(again.report.snapshot_id).toBe(result.report.snapshot_id);
		expect(statSync(manifestPath).mtimeMs).toBe(before);
	});

	it('produces a byte-identical manifest and chunks in a fresh data dir', async () => {
		const other: RuntimeConfig = { dataDir: join(tempDir('fresh'), 'data'), localRoots: ctx.cfg.localRoots };
		const reg = new Registry(other.dataDir);
		reg.addProject('app', 'App');
		reg.addSource('app', { id: 'main', kind: 'local', location: ctx.repo.dir, defaultRef: 'main' });
		const second = await createSnapshot(other, 'app');
		expect(second.report.snapshot_id).toBe(result.report.snapshot_id);
		for (const file of ['manifest.json', 'chunks.jsonl']) {
			expect(readFileSync(join(second.dir, file))).toEqual(readFileSync(join(result.dir, file)));
		}
	});

	it('creates a new snapshot for a new commit and keeps the old one intact', async () => {
		const oldChunks = readFileSync(join(result.dir, 'chunks.jsonl'));
		const newSha = commitFiles(ctx.repo.dir, { 'src/c.ts': 'export const c = 3;\n' });
		const next = await createSnapshot(ctx.cfg, 'app');
		expect(next.status).toBe('created');
		expect(next.report.snapshot_id).not.toBe(result.report.snapshot_id);
		expect(next.report.sources[0]?.commit).toBe(newSha);
		expect(readFileSync(join(result.dir, 'chunks.jsonl'))).toEqual(oldChunks);
		// the original commit can still be snapshotted exactly by SHA
		const pinned = await createSnapshot(ctx.cfg, 'app', { main: ctx.repo.sha });
		expect(pinned.status).toBe('exists');
	});

	it('rejects refs for unknown sources and unknown refs', async () => {
		await expect(createSnapshot(ctx.cfg, 'app', { nope: 'main' })).rejects.toMatchObject({ code: 'UNKNOWN_SOURCE' });
		await expect(createSnapshot(ctx.cfg, 'app', { main: 'no-such-branch' })).rejects.toMatchObject({ code: 'INVALID_REF' });
		await expect(createSnapshot(ctx.cfg, 'app', { main: '--upload-pack=x' })).rejects.toMatchObject({ code: 'INVALID_REF' });
		await expect(createSnapshot(ctx.cfg, 'app', { main: 'a..b' })).rejects.toBeInstanceOf(CodeTrailError);
	});
});

describe('secret handling', () => {
	it('blocks the snapshot on a high-confidence secret and persists no content', async () => {
		const { cfg } = setup('high', {
			'src/app.ts': 'export const ok = 1;\n',
			'src/config.ts': `export const awsKey = '${CANARY.awsKey}';\nexport const other = 2;\n`,
			'docs/keys.md': `${CANARY.privateKeyHeader}\nabc\n`,
		});
		const result = await createSnapshot(cfg, 'app');
		expect(result.status).toBe('blocked');
		expect(result.report.counts.chunks).toBe(0);
		expect(result.report.secret_findings).toEqual([
			{ source_id: 'main', path: 'docs/keys.md', detector: 'private-key', confidence: 'high', count: 1 },
			{ source_id: 'main', path: 'src/config.ts', detector: 'aws-access-key-id', confidence: 'high', count: 1 },
		]);
		const snapRoot = join(cfg.dataDir, 'snapshots', 'app');
		expect(existsSync(join(snapRoot, result.report.snapshot_id))).toBe(false);
		const persisted = readAllBytes(snapRoot);
		expect(persisted.includes(CANARY.awsKey)).toBe(false);
		expect(persisted.includes('PRIVATE KEY')).toBe(false);
		expect(persisted.includes('export const ok')).toBe(false);
	});

	it('excludes a file with a medium-confidence secret but keeps the rest', async () => {
		const { cfg } = setup('medium', {
			'src/app.ts': 'export const ok = 1;\n',
			'src/client.ts': `const apiKey = "${CANARY.genericValue}";\nexport default apiKey;\n`,
		});
		const result = await createSnapshot(cfg, 'app');
		expect(result.status).toBe('created');
		expect(result.report.secret_findings).toEqual([
			{ source_id: 'main', path: 'src/client.ts', detector: 'generic-secret-assignment', confidence: 'medium', count: 1 },
		]);
		const { manifest } = readSnapshot(cfg.dataDir, 'app', result.report.snapshot_id);
		expect(manifest.files.find((f) => f.path === 'src/client.ts')?.reason).toBe('secret-suspected');
		expect(readAllBytes(cfg.dataDir).includes(CANARY.genericValue)).toBe(false);
	});
});

describe('submodules', () => {
	it('records gitlinks as excluded submodules', async () => {
		const { cfg, repo } = setup('submodule', { 'src/a.ts': 'export const a = 1;\n' });
		git(repo.dir, 'update-index', '--add', '--cacheinfo', `160000,${repo.sha},vendor-lib`);
		git(repo.dir, 'commit', '-q', '-m', 'add gitlink');
		const result = await createSnapshot(cfg, 'app');
		const { manifest } = readSnapshot(cfg.dataDir, 'app', result.report.snapshot_id);
		expect(manifest.files.find((f) => f.path === 'vendor-lib')?.reason).toBe('submodule');
	});
});

describe('project isolation', () => {
	it('keeps two projects over the same source fully separate', async () => {
		const { cfg, registry, repo } = setup('isolation', { 'src/a.ts': 'export const a = 1;\n' });
		registry.addProject('other', 'Other');
		registry.addSource('other', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
		const a = await createSnapshot(cfg, 'app');
		const b = await createSnapshot(cfg, 'other');
		expect(a.report.snapshot_id).not.toBe(b.report.snapshot_id);
		expect(a.dir).not.toBe(b.dir);
		const chunksA = readSnapshot(cfg.dataDir, 'app', a.report.snapshot_id).chunks;
		const chunksB = readSnapshot(cfg.dataDir, 'other', b.report.snapshot_id).chunks;
		expect(chunksA.every((c) => c.project_id === 'app')).toBe(true);
		expect(chunksB.every((c) => c.project_id === 'other')).toBe(true);
		const idsA = new Set(chunksA.map((c) => c.id));
		expect(chunksB.some((c) => idsA.has(c.id))).toBe(false);
		expect(() => readSnapshot(cfg.dataDir, 'other', a.report.snapshot_id)).toThrow(CodeTrailError);
	});
});

describe('multi-source projects', () => {
	it('pins each source to its own commit in one snapshot', async () => {
		const root = tempDir('multi');
		const fe = makeRepo(root, 'fe', { 'pages/index.tsx': 'export default function Home() {\n\treturn null;\n}\n' });
		const be = makeRepo(root, 'be', { 'src/main.ts': 'export async function bootstrap() {}\n' });
		const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
		const reg = new Registry(cfg.dataDir);
		reg.addProject('shop', 'Shop');
		reg.addSource('shop', { id: 'frontend', kind: 'local', location: fe.dir, defaultRef: 'main' });
		reg.addSource('shop', { id: 'backend', kind: 'local', location: be.dir, defaultRef: 'main' });
		const result = await createSnapshot(cfg, 'shop');
		expect(result.report.sources.map((s) => [s.source_id, s.commit])).toEqual([
			['backend', be.sha],
			['frontend', fe.sha],
		]);
		const { chunks } = readSnapshot(cfg.dataDir, 'shop', result.report.snapshot_id);
		expect(new Set(chunks.map((c) => `${c.source_id}@${c.commit}`))).toEqual(new Set([`backend@${be.sha}`, `frontend@${fe.sha}`]));
	});
});

describe('git invocation', () => {
	it('always applies the SIGBUS workaround and disables repo hooks', () => {
		const args = gitArgs(['ls-tree', 'HEAD'], '/x.git');
		expect(args.slice(0, GIT_SAFE_CONFIG.length)).toEqual([...GIT_SAFE_CONFIG]);
		expect(args).toContain('core.packedGitWindowSize=1m');
		expect(args).toContain('core.hooksPath=/dev/null');
	});
});

describe('git retry', () => {
	it('retries only retryable errors, with backoff, and stops at the attempt limit', async () => {
		const { withRetry, GitError, isTransientGitFailure } = await import('../src/git.js');
		const transient = new GitError('clone', { exitCode: null, signal: 'SIGBUS', transient: true, attempts: 1 });
		const permanent = new GitError('clone', { exitCode: 128, signal: null, transient: false, attempts: 1 });
		let calls = 0;
		let cleaned = 0;
		const value = await withRetry(
			3,
			async () => {
				calls++;
				if (calls < 3) throw transient;
				return 'ok';
			},
			{ beforeRetry: () => cleaned++, baseMs: 1 },
		);
		expect([value, calls, cleaned]).toEqual(['ok', 3, 2]);
		calls = 0;
		await expect(withRetry(3, async () => (calls++, Promise.reject(permanent)), { baseMs: 1 })).rejects.toBe(permanent);
		expect(calls).toBe(1);
		calls = 0;
		await expect(withRetry(2, async () => (calls++, Promise.reject(transient)), { baseMs: 1 })).rejects.toBe(transient);
		expect(calls).toBe(2);
		await expect(withRetry(3, async () => Promise.reject(new Error('EACCES')), { baseMs: 1 })).rejects.toThrow('EACCES');
		expect(isTransientGitFailure(null, 'SIGBUS', '')).toBe(true);
		expect(isTransientGitFailure(128, null, 'fatal: git upload-pack: git-pack-objects died with error.')).toBe(true);
		expect(isTransientGitFailure(128, null, "fatal: could not read '/x': Permission denied")).toBe(false);
		expect(isTransientGitFailure(128, null, 'fatal: not a git repository')).toBe(false);
	});
});
