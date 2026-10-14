/**
 * Regressions for the Codex B review (01a4859..34f64ee). Each block maps to one
 * finding and reproduces it through public behaviour only.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chunkFile, LineIndex } from '../src/chunker/index.js';
import type { RuntimeConfig } from '../src/config.js';
import { CodeTrailError } from '../src/errors.js';
import { runGit } from '../src/git.js';
import { Registry } from '../src/registry.js';
import { scanText } from '../src/secrets.js';
import { createSnapshot, readSnapshot } from '../src/snapshot.js';
import { resolveLocalSource } from '../src/sources.js';
import { CANARY, git, makeRepo, readAllBytes, tempDir, DIST } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(DIST, 'cli.js');

/** Every git repository under `dir`, with all of its objects expanded (decompressed). */
function expandAllGitObjects(dir: string): Buffer {
	const parts: Buffer[] = [];
	const walk = (d: string): void => {
		if (existsSync(join(d, 'HEAD')) && existsSync(join(d, 'objects'))) {
			parts.push(execFileSync('git', ['--git-dir', d, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 1 << 30 }));
		}
		for (const name of readdirSync(d)) {
			const full = join(d, name);
			if (statSync(full).isDirectory()) walk(full);
		}
	};
	if (existsSync(dir)) walk(dir);
	return Buffer.concat(parts);
}

function countGitRepos(dir: string): number {
	let n = 0;
	const walk = (d: string): void => {
		if (existsSync(join(d, 'HEAD')) && existsSync(join(d, 'objects'))) n++;
		for (const name of readdirSync(d)) {
			const full = join(d, name);
			if (statSync(full).isDirectory()) walk(full);
		}
	};
	if (existsSync(dir)) walk(dir);
	return n;
}

function runCli(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
		child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
		child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
	});
}

beforeAll(() => {
});

describe('#1 raw git data is quarantined and does not outlive a blocked snapshot', () => {
	it('leaves no git objects containing the canary anywhere under the data dir', async () => {
		const root = tempDir('quarantine');
		const repo = makeRepo(root, 'repo', {
			'src/app.ts': 'export const ok = 1;\n',
			'src/config.ts': `export const k = '${CANARY.awsKey}';\n`,
		});
		const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
		const reg = new Registry(cfg.dataDir);
		reg.addProject('app', 'App');
		reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
		const result = await createSnapshot(cfg, 'app');
		expect(result.status).toBe('blocked');
		expect(expandAllGitObjects(cfg.dataDir).includes(CANARY.awsKey)).toBe(false);
		expect(readAllBytes(cfg.dataDir).includes(CANARY.awsKey)).toBe(false);
		expect(countGitRepos(cfg.dataDir)).toBe(0);
		// the source repository itself is untouched
		expect(git(repo.dir, 'show', 'HEAD:src/config.ts')).toContain(CANARY.awsKey);
	});

	it('also removes raw git data after a successful snapshot', async () => {
		const root = tempDir('quarantine-ok');
		const repo = makeRepo(root, 'repo', { 'src/app.ts': 'export const ok = 1;\n' });
		const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
		const reg = new Registry(cfg.dataDir);
		reg.addProject('app', 'App');
		reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
		expect((await createSnapshot(cfg, 'app')).status).toBe('created');
		expect(countGitRepos(cfg.dataDir)).toBe(0);
	});
});

describe('#1/#4 quarantine crash recovery', () => {
	it('removes staging left by dead processes and never touches a live process staging dir', async () => {
		const root = tempDir('sweep');
		const repo = makeRepo(root, 'repo', { 'src/a.ts': 'export const a = 1;\n' });
		const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
		const reg = new Registry(cfg.dataDir);
		reg.addProject('app', 'App');
		reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
		const q = join(cfg.dataDir, 'quarantine', 'app');
		mkdirSync(q, { recursive: true });
		const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
		const deadDir = join(q, `main.${dead}.0123456789abcdef.git`);
		const liveDir = join(q, `main.${process.pid}.fedcba9876543210.git`);
		const foreign = join(q, 'not-ours');
		for (const d of [deadDir, liveDir, foreign]) mkdirSync(d);
		await createSnapshot(cfg, 'app');
		expect(existsSync(deadDir)).toBe(false);
		expect(existsSync(liveDir)).toBe(true);
		expect(existsSync(foreign)).toBe(true);
	});
});

describe('#2 local sources cannot escape the allowed roots through .git', () => {
	const root = tempDir('gitdir-escape');
	const allowed = join(root, 'allowed');
	const outside = join(root, 'outside');
	mkdirSync(allowed);
	mkdirSync(outside);
	const outRepo = makeRepo(outside, 'secret-repo', { 'src/outside.ts': 'export const outside = 1;\n' });

	it('rejects a .git symlink pointing outside', () => {
		const proj = join(allowed, 'symlinked');
		mkdirSync(proj);
		symlinkSync(join(outRepo.dir, '.git'), join(proj, '.git'));
		expect(() => resolveLocalSource(proj, [allowed])).toThrow(CodeTrailError);
	});

	it('rejects a gitfile (worktree-style) pointing outside', () => {
		const proj = join(allowed, 'gitfile');
		mkdirSync(proj);
		writeFileSync(join(proj, '.git'), `gitdir: ${join(outRepo.dir, '.git')}\n`);
		expect(() => resolveLocalSource(proj, [allowed])).toThrow(CodeTrailError);
	});

	it('rejects object alternates pointing outside', () => {
		const inRepo = makeRepo(allowed, 'alternates', { 'a.ts': 'export const a = 1;\n' });
		writeFileSync(join(inRepo.dir, '.git', 'objects', 'info', 'alternates'), `${join(outRepo.dir, '.git', 'objects')}\n`);
		expect(() => resolveLocalSource(inRepo.dir, [allowed])).toThrow(CodeTrailError);
	});

	it('re-validates registered local sources at snapshot time (roots=[] and escaped .git)', async () => {
		const inRepo = makeRepo(allowed, 'registered', { 'a.ts': 'export const a = 1;\n' });
		const dataDir = join(root, 'data');
		const reg = new Registry(dataDir);
		reg.addProject('p', 'P');
		reg.addSource('p', { id: 'main', kind: 'local', location: inRepo.dir, defaultRef: 'main' });
		await expect(createSnapshot({ dataDir, localRoots: [] }, 'p')).rejects.toMatchObject({ code: 'LOCAL_PATH_OUTSIDE_ROOTS' });

		const proj = join(allowed, 'registered-escape');
		mkdirSync(proj);
		symlinkSync(join(outRepo.dir, '.git'), join(proj, '.git'));
		reg.addProject('q', 'Q');
		reg.addSource('q', { id: 'main', kind: 'local', location: proj, defaultRef: 'main' });
		await expect(createSnapshot({ dataDir, localRoots: [allowed] }, 'q')).rejects.toBeInstanceOf(CodeTrailError);
	});
});

describe('#3 placeholder exclusions only match exact placeholder forms', () => {
	it('detects real credentials that merely contain test/example/mock substrings', () => {
		const pg = ['postgres://app', ':', 'Str0ngTestPassw0rd9', '@db.internal:5432/app'].join('');
		expect(scanText(`const url = '${pg}';`).map((f) => f.detector)).toEqual(['credential-url']);
		const ex = ['mongodb://svc', ':', 'k3yExampleZ9qL', '@mongo:27017/x'].join('');
		expect(scanText(ex).map((f) => f.detector)).toEqual(['credential-url']);
		const mock = 'mockQ7zR9kX2Lm4Np8Vt';
		expect(scanText(`const apiKey = "${mock}";`).map((f) => f.detector)).toEqual(['generic-secret-assignment']);
	});

	it('still ignores exact placeholders', () => {
		const exact = [
			"const url = 'postgres://user:<password>@localhost/db';",
			"const url = 'postgres://user:${DB_PASSWORD}@localhost/db';",
			"const url = 'mongodb://user:password@localhost/db';",
			"const apiKey = 'your-api-key-here';",
			"const token = '{{TOKEN}}';",
			"const secret = 'xxxxxxxxxxxxxxxx';",
		].join('\n');
		expect(scanText(exact)).toEqual([]);
	});
});

describe('#4 parallel snapshot runs in separate processes', () => {
	it('all succeed with one created snapshot and no leftovers', async () => {
		const root = tempDir('parallel-snap');
		const repo = makeRepo(root, 'repo', { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
		const env = { CODETRAIL_DATA_DIR: join(root, 'data'), CODETRAIL_LOCAL_ROOTS: root };
		expect((await runCli(env, ['project', 'add', 'par'])).code).toBe(0);
		expect((await runCli(env, ['source', 'add-local', 'par', 'main', repo.dir, '--ref', 'main'])).code).toBe(0);
		const runs = await Promise.all(Array.from({ length: 6 }, () => runCli(env, ['snapshot', 'create', 'par'])));
		expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0]);
		const parsed = runs.map((r) => JSON.parse(r.stdout) as { result: string; snapshot_id: string });
		expect(parsed.filter((p) => p.result === 'created')).toHaveLength(1);
		expect(new Set(parsed.map((p) => p.snapshot_id)).size).toBe(1);
		expect(countGitRepos(env.CODETRAIL_DATA_DIR)).toBe(0);
		const snapRoot = join(env.CODETRAIL_DATA_DIR, 'snapshots', 'par');
		expect(readdirSync(snapRoot).filter((n) => n.startsWith('.tmp'))).toEqual([]);
	});
});

describe('#5 registry writes from parallel processes', () => {
	it('keeps every project added concurrently', async () => {
		const root = tempDir('parallel-reg');
		const env = { CODETRAIL_DATA_DIR: join(root, 'data') };
		const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
		const runs = await Promise.all(ids.map((id) => runCli(env, ['project', 'add', id])));
		expect(runs.map((r) => r.code)).toEqual(ids.map(() => 0));
		const reg = JSON.parse(readFileSync(join(root, 'data', 'registry.json'), 'utf8')) as { projects: { id: string }[] };
		expect(reg.projects.map((p) => p.id).sort()).toEqual([...ids].sort());
	});
});

describe('#6 UTF-8 BOM and CRLF keep chunk text byte-identical to the blob', () => {
	it.each([
		['bom-lf.ts', '﻿export const a = 1;\n\nexport function f() {\n\treturn a;\n}\n'],
		['bom-crlf.ts', '﻿export const a = 1;\r\n\r\nexport function f() {\r\n\treturn a;\r\n}\r\n'],
		['crlf.tsx', 'export const C = () => {\r\n\treturn null;\r\n};\r\n'],
		['bom.md', '﻿# Title\r\n\r\nText.\r\n'],
		['bom.json', '﻿{\n  "a": 1\n}\n'],
	])('%s', async (name, content) => {
		const root = tempDir('bom');
		const repo = makeRepo(root, 'repo', { [name]: content });
		const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
		const reg = new Registry(cfg.dataDir);
		reg.addProject('app', 'App');
		reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
		const result = await createSnapshot(cfg, 'app');
		const { chunks, manifest } = readSnapshot(cfg.dataDir, 'app', result.report.snapshot_id);
		const blob = execFileSync('git', ['cat-file', 'blob', manifest.files[0]!.blob], { cwd: repo.dir });
		const blobLines: Buffer[] = [];
		let start = 0;
		for (let i = 0; i <= blob.length; i++) {
			if (i === blob.length || blob[i] === 0x0a) {
				blobLines.push(blob.subarray(start, i));
				start = i + 1;
			}
		}
		expect(chunks.length).toBeGreaterThan(0);
		for (const c of chunks) {
			const expected = Buffer.concat(blobLines.slice(c.start_line - 1, c.end_line).flatMap((l, i) => (i === 0 ? [l] : [Buffer.from('\n'), l])));
			expect(Buffer.from(c.text, 'utf8').equals(expected)).toBe(true);
		}
	});
});

describe('#7 large class tail comments are covered', () => {
	it('covers a comment between the last method and the closing brace', () => {
		const methods = Array.from({ length: 10 }, (_, m) => `\tm${m}() {\n${Array.from({ length: 14 }, (_, i) => `\t\tconst v${i} = ${i};`).join('\n')}\n\t\treturn 1;\n\t}`).join('\n\n');
		const after = `export function after() {\n${Array.from({ length: 8 }, (_, i) => `\tconst a${i} = ${i};`).join('\n')}\n\treturn 0;\n}\n`;
		const text = `export class Big {\n${methods}\n\n\t// TAIL-COMMENT: keep me\n\t/* and this block */\n}\n\n${after}`;
		const chunks = chunkFile('big.ts', text);
		const idx = new LineIndex(text);
		const covered = new Set(chunks.flatMap((c) => Array.from({ length: c.endLine - c.startLine + 1 }, (_, k) => c.startLine + k)));
		const uncovered: number[] = [];
		for (let line = 1; line <= idx.count; line++) {
			const content = idx.lines[line - 1] as string;
			if (content.trim() && !/^[\s})\];,]*$/.test(content) && !covered.has(line)) uncovered.push(line);
		}
		expect(uncovered).toEqual([]);
		for (const c of chunks) {
			expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(120);
			expect(idx.slice(c.startLine, c.endLine).length).toBeLessThanOrEqual(6000);
		}
	});
});

describe('#8 git retries only transient failures', () => {
	function fakeGit(script: string): { dir: string; log: string } {
		const dir = tempDir('fake-git');
		const log = join(dir, 'calls.log');
		writeFileSync(join(dir, 'git'), `#!/bin/sh\necho call >> "${log}"\n${script}\n`);
		chmodSync(join(dir, 'git'), 0o755);
		return { dir, log };
	}
	const calls = (log: string): number => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);

	async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
		const old = process.env.PATH;
		process.env.PATH = `${dir}:${old ?? ''}`;
		try {
			return await fn();
		} finally {
			process.env.PATH = old;
		}
	}

	it('runs a permanent failure exactly once', async () => {
		const fake = fakeGit('echo "fatal: could not open \'/x\': Permission denied" >&2\nexit 128');
		await withPath(fake.dir, () => expect(runGit(['ls-tree', 'HEAD'])).rejects.toBeInstanceOf(CodeTrailError));
		expect(calls(fake.log)).toBe(1);
	});

	it('retries a SIGBUS crash and then succeeds', async () => {
		const fake = fakeGit('');
		writeFileSync(
			join(fake.dir, 'git'),
			`#!/bin/sh\necho call >> "${fake.log}"\nif [ "$(grep -c call "${fake.log}")" -lt 2 ]; then kill -BUS $$; fi\necho ok\n`,
		);
		const out = await withPath(fake.dir, () => runGit(['ls-tree', 'HEAD']));
		expect(out.toString().trim()).toBe('ok');
		expect(calls(fake.log)).toBe(2);
	});
});
