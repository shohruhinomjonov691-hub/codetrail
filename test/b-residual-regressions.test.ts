/**
 * Regressions for the Codex B re-review of a2b3c08..575a6c2 (2× High, 1× Low).
 */
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { CodeTrailError } from '../src/errors.js';
import * as lock from '../src/lock.js';
import { Registry } from '../src/registry.js';
import { createSnapshot, readSnapshot } from '../src/snapshot.js';
import { resolveLocalSource } from '../src/sources.js';
import { git, makeRepo, tempDir } from './helpers.js';

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	Object.assign(process.env, vars);
	return fn().finally(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

describe('High 1 — user/system git config cannot redirect a local source', () => {
	async function scenario(configVia: 'GIT_CONFIG_GLOBAL' | 'HOME' | 'XDG_CONFIG_HOME'): Promise<string> {
		const root = tempDir(`insteadof-${configVia}`);
		const allowed = join(root, 'allowed');
		const outside = join(root, 'outside');
		mkdirSync(allowed);
		mkdirSync(outside);
		const inRepo = makeRepo(allowed, 'repo', { 'src/inside.ts': 'export const INSIDE_ONLY = 1;\n' });
		const outRepo = makeRepo(outside, 'repo', { 'src/outside.ts': 'export const OUTSIDE_ONLY = 1;\n' });
		const config = `[url "${outRepo.dir}"]\n\tinsteadOf = ${inRepo.dir}\n`;
		const home = join(root, 'home');
		mkdirSync(join(home, '.config', 'git'), { recursive: true });
		const env: Record<string, string> = {};
		if (configVia === 'GIT_CONFIG_GLOBAL') {
			writeFileSync(join(root, 'evil.gitconfig'), config);
			env.GIT_CONFIG_GLOBAL = join(root, 'evil.gitconfig');
		} else if (configVia === 'HOME') {
			writeFileSync(join(home, '.gitconfig'), config);
			env.HOME = home;
		} else {
			writeFileSync(join(home, '.config', 'git', 'config'), config);
			env.XDG_CONFIG_HOME = join(home, '.config');
			env.HOME = join(root, 'empty-home');
		}
		const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [allowed] };
		const reg = new Registry(cfg.dataDir);
		reg.addProject('p', 'P');
		reg.addSource('p', { id: 'main', kind: 'local', location: inRepo.dir, defaultRef: 'main' });
		return withEnv(env, async () => {
			const result = await createSnapshot(cfg, 'p');
			const { chunks, manifest } = readSnapshot(cfg.dataDir, 'p', result.report.snapshot_id);
			expect(result.report.sources[0]?.commit).toBe(inRepo.sha);
			expect(manifest.files.map((f) => f.path)).toEqual(['src/inside.ts']);
			return chunks.map((c) => c.text).join('\n');
		});
	}

	it.each(['GIT_CONFIG_GLOBAL', 'HOME', 'XDG_CONFIG_HOME'] as const)('url.insteadOf via %s is ignored', async (via) => {
		const text = await scenario(via);
		expect(text).toContain('INSIDE_ONLY');
		expect(text).not.toContain('OUTSIDE_ONLY');
	});
});

describe('High 2 — symlinked directories inside the object store', () => {
	it('rejects objects/<xx> symlinked to an in-roots directory whose entries point outside', async () => {
		const root = tempDir('objdir-symlink');
		const allowed = join(root, 'allowed');
		const outside = join(root, 'outside');
		mkdirSync(allowed);
		mkdirSync(outside);
		const outRepo = makeRepo(outside, 'repo', { 'src/outside.ts': 'export const OUTSIDE_ONLY = 1;\n' });
		const inRepo = makeRepo(allowed, 'repo', { 'src/inside.ts': 'export const INSIDE_ONLY = 1;\n' });
		// an outside loose object
		const outObjects = join(outRepo.dir, '.git', 'objects');
		const xx = readdirSync(outObjects).find((d) => /^[0-9a-f]{2}$/.test(d)) as string;
		const objFile = readdirSync(join(outObjects, xx))[0] as string;
		// in-roots staging dir with a symlink to the outside object
		const stash = join(allowed, 'stash', 'zz');
		mkdirSync(stash, { recursive: true });
		symlinkSync(join(outObjects, xx, objFile), join(stash, objFile));
		symlinkSync(stash, join(inRepo.dir, '.git', 'objects', 'zz'));
		expect(() => resolveLocalSource(inRepo.dir, [allowed])).toThrow(CodeTrailError);

		const dataDir = join(root, 'data');
		const reg = new Registry(dataDir);
		reg.addProject('p', 'P');
		reg.addSource('p', { id: 'main', kind: 'local', location: inRepo.dir, defaultRef: 'main' });
		await expect(createSnapshot({ dataDir, localRoots: [allowed] }, 'p')).rejects.toBeInstanceOf(CodeTrailError);
	});

	it('still accepts an ordinary repository and a pack-only repository', () => {
		const root = tempDir('objdir-ok');
		const repo = makeRepo(root, 'repo', { 'a.ts': 'export const a = 1;\n' });
		git(repo.dir, 'gc', '-q');
		expect(resolveLocalSource(repo.dir, [root])).toBe(repo.dir);
	});
});

describe('Low 3 — no lock is granted after the deadline', () => {
	const busyWait = (ms: number): void => {
		const end = performance.now() + ms;
		while (performance.now() < end) {
			/* block the event loop */
		}
	};

	it('async: a waiter whose deadline passed while the loop was blocked does not enter', async () => {
		const dir = tempDir('lock-deadline');
		let waiterEntered = false;
		const holder = lock.withLock(dir, 'x', { timeoutMs: 1_000 }, async () => {
			await new Promise((r) => setTimeout(r, 5));
			busyWait(100); // the owner keeps the loop busy, then releases
		});
		const waiter = lock.withLock(dir, 'x', { timeoutMs: 20 }, () => {
			waiterEntered = true;
		});
		await holder;
		await expect(waiter).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
		expect(waiterEntered).toBe(false);
	});

	it('sync and async share a retry loop that checks the deadline before every retry', async () => {
		const acquireLoop = (lock as unknown as Record<string, unknown>).acquireLoopSync as
			| ((tryAcquire: () => boolean, timeoutMs: number, clock: { now(): number; sleep(ms: number): void }) => void)
			| undefined;
		expect(typeof acquireLoop).toBe('function');
		let t = 0;
		let calls = 0;
		const clock = { now: () => t, sleep: (ms: number) => void (t += ms + 500) }; // every sleep overshoots
		expect(() => acquireLoop!(() => ++calls > 1, 20, clock)).toThrow(expect.objectContaining({ code: 'LOCK_TIMEOUT' }));
		expect(calls).toBe(1); // the late retry was never attempted
		t = 0;
		calls = 0;
		expect(() => acquireLoop!(() => ++calls > 2, 1_000, { now: () => t, sleep: (ms) => void (t += ms) })).not.toThrow();
		expect(calls).toBe(3);
	});
});
