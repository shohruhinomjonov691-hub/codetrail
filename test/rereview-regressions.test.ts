/**
 * Regressions for the Codex B re-review (34f64ee..ab83c05): 4 open findings.
 * Each test reproduces the reviewer's scenario through public behaviour.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { CodeTrailError } from '../src/errors.js';
import { withLock, withLockSync, type LockOptions } from '../src/lock.js';
import { Registry } from '../src/registry.js';
import { createSnapshot } from '../src/snapshot.js';
import { resolveLocalSource } from '../src/sources.js';
import { git, makeRepo, tempDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const LOCK_JS = join(ROOT, 'dist', 'lock.js');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deadPid(): number {
	return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
}

beforeAll(() => {
	execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'ignore' });
});

describe('#1 nested object alternates cannot escape the local roots', () => {
	it('rejects a shared clone of a shared clone of an outside repository', async () => {
		const root = tempDir('nested-alt');
		const allowed = join(root, 'allowed');
		const outside = join(root, 'outside');
		mkdirSync(allowed);
		mkdirSync(outside);
		const out = makeRepo(outside, 'secret', { 'src/outside.ts': 'export const OUTSIDE_ONLY = 1;\n' });
		git(allowed, 'clone', '-q', '--shared', out.dir, 'first'); // alternates → outside
		git(allowed, 'clone', '-q', '--shared', join(allowed, 'first'), 'second'); // alternates → first (inside) → outside
		expect(() => resolveLocalSource(join(allowed, 'first'), [allowed])).toThrow(CodeTrailError);
		expect(() => resolveLocalSource(join(allowed, 'second'), [allowed])).toThrow(CodeTrailError);

		const dataDir = join(root, 'data');
		const reg = new Registry(dataDir);
		reg.addProject('p', 'P');
		reg.addSource('p', { id: 'main', kind: 'local', location: join(allowed, 'second'), defaultRef: 'HEAD' });
		await expect(createSnapshot({ dataDir, localRoots: [allowed] }, 'p')).rejects.toBeInstanceOf(CodeTrailError);
	});

	it('terminates on an alternates cycle inside the roots', () => {
		const root = tempDir('alt-cycle');
		const a = makeRepo(root, 'a', { 'a.ts': 'export const a = 1;\n' });
		const b = makeRepo(root, 'b', { 'b.ts': 'export const b = 1;\n' });
		writeFileSync(join(a.dir, '.git', 'objects', 'info', 'alternates'), `${join(b.dir, '.git', 'objects')}\n`);
		writeFileSync(join(b.dir, '.git', 'objects', 'info', 'alternates'), `${join(a.dir, '.git', 'objects')}\n`);
		expect(resolveLocalSource(a.dir, [root])).toBe(a.dir);
	});
});

describe('#2 a lock is never held by two owners at once (deterministic schedule)', () => {
	/**
	 * Reviewer schedule: A held the break guard and paused after re-reading a
	 * stale owner; the guard aged out; B took the lock; A resumed, deleted the
	 * lock it had judged stale and entered too. Here the harness plays A's
	 * resumed steps at the exact point where B is inside the critical section.
	 */
	it('A resuming after B acquired cannot enter while B is inside', async () => {
		const dir = tempDir('lock-race');
		mkdirSync(dir, { recursive: true });
		const name = 'race';
		const legacyLock = join(dir, `${name}.lock`);
		writeFileSync(legacyLock, JSON.stringify({ pid: deadPid(), host: hostname(), token: 'stale-owner', created: 0 }));
		const guard = join(dir, `${name}.lock.break`);
		writeFileSync(guard, JSON.stringify({ pid: process.pid, host: hostname(), token: 'paused-A', created: 0 })); // A is alive
		const old = (Date.now() - 120_000) / 1000;
		utimesSync(guard, old, old);

		let inside = 0;
		let maxInside = 0;
		const opts = { timeoutMs: 2_000, staleMs: 1_000 } as LockOptions;
		let aResult: Promise<unknown> = Promise.resolve();
		await withLock(dir, name, opts, async () => {
			inside++;
			maxInside = Math.max(maxInside, inside);
			// A resumes: deletes the lock file it had judged stale, then acquires.
			try {
				unlinkSync(legacyLock);
			} catch {
				/* absent in the new design */
			}
			aResult = withLock(dir, name, { timeoutMs: 1_000, staleMs: 1_000 } as LockOptions, async () => {
				inside++;
				maxInside = Math.max(maxInside, inside);
				await sleep(20);
				inside--;
			});
			await sleep(150);
			inside--;
		});
		await aResult;
		expect(maxInside).toBe(1);
	});

	it('a paused (SIGSTOP) live holder keeps the lock no matter how long; a crashed one releases it', async () => {
		const dir = tempDir('lock-paused');
		const holder = (): { child: ChildProcess; ready: Promise<void> } => {
			const child = spawn(process.execPath, [
				'--input-type=module',
				'-e',
				`import { withLock } from ${JSON.stringify(LOCK_JS)};
				 await withLock(${JSON.stringify(dir)}, 'held', { timeoutMs: 5000, staleMs: 10 }, async () => {
				   process.stdout.write('acquired\\n');
				   await new Promise((r) => setTimeout(r, 60000));
				 });`,
			]);
			const ready = new Promise<void>((resolve) => child.stdout?.on('data', (d: Buffer) => d.toString().includes('acquired') && resolve()));
			return { child, ready };
		};
		const a = holder();
		await a.ready;
		a.child.kill('SIGSTOP');
		await sleep(300); // far longer than the holder's staleMs
		await expect(withLock(dir, 'held', { timeoutMs: 300, staleMs: 10 } as LockOptions, () => 'stolen')).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
		a.child.kill('SIGKILL');
		await new Promise((r) => a.child.on('exit', r));
		expect(await withLock(dir, 'held', { timeoutMs: 2_000, staleMs: 10 } as LockOptions, () => 'after-crash')).toBe('after-crash');
	});
});

describe('#3 the timeout always fires (async and sync)', () => {
	/** Runs `code` in a child with a hard kill so a hang fails the test instead of the suite. */
	function runBounded(code: string, killAfterMs = 4_000): Promise<{ status: string; ms: number }> {
		return new Promise((resolve) => {
			const started = Date.now();
			const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
			let out = '';
			child.stdout.on('data', (d: Buffer) => (out += d.toString()));
			const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
			child.on('exit', (_code, signal) => {
				clearTimeout(timer);
				resolve({ status: signal === 'SIGKILL' ? 'HUNG' : out.trim(), ms: Date.now() - started });
			});
		});
	}

	for (const variant of ['async', 'sync'] as const) {
		it(`${variant}: dead-pid lock + fresh .break guard (reviewer reproducer) finishes promptly`, async () => {
			const dir = tempDir(`lock-legacy-${variant}`);
			writeFileSync(join(dir, 'x.lock'), JSON.stringify({ pid: deadPid(), host: hostname(), token: 'dead', created: 0 }));
			writeFileSync(join(dir, 'x.lock.break'), JSON.stringify({ pid: process.pid, host: hostname(), token: 'fresh', created: Date.now() }));
			const call =
				variant === 'async'
					? `await withLock(dir, 'x', { timeoutMs: 50, staleMs: 60000 }, () => 1)`
					: `withLockSync(dir, 'x', { timeoutMs: 50, staleMs: 60000 }, () => 1)`;
			const res = await runBounded(`
				import { withLock, withLockSync } from ${JSON.stringify(LOCK_JS)};
				const dir = ${JSON.stringify(dir)};
				try { ${call}; console.log('ok'); } catch (e) { console.log(e.code ?? 'error'); }`);
			expect(res.status).not.toBe('HUNG');
			expect(['ok', 'LOCK_TIMEOUT']).toContain(res.status);
			expect(res.ms).toBeLessThan(3_000);
		});

		it(`${variant}: times out against a live holder`, async () => {
			const dir = tempDir(`lock-live-${variant}`);
			const holder = spawn(process.execPath, [
				'--input-type=module',
				'-e',
				`import { withLock } from ${JSON.stringify(LOCK_JS)};
				 await withLock(${JSON.stringify(dir)}, 'x', { timeoutMs: 5000, staleMs: 60000 }, async () => {
				   process.stdout.write('acquired\\n'); await new Promise((r) => setTimeout(r, 10000)); });`,
			]);
			await new Promise<void>((resolve) => holder.stdout.on('data', (d: Buffer) => d.toString().includes('acquired') && resolve()));
			const call =
				variant === 'async'
					? `await withLock(dir, 'x', { timeoutMs: 200, staleMs: 60000 }, () => 1)`
					: `withLockSync(dir, 'x', { timeoutMs: 200, staleMs: 60000 }, () => 1)`;
			const res = await runBounded(`
				import { withLock, withLockSync } from ${JSON.stringify(LOCK_JS)};
				const dir = ${JSON.stringify(dir)};
				try { ${call}; console.log('ok'); } catch (e) { console.log(e.code ?? 'error'); }`);
			holder.kill('SIGKILL');
			expect(res.status).toBe('LOCK_TIMEOUT');
			expect(res.ms).toBeLessThan(3_000);
		});
	}

	it('sync acquisition in the same process times out while an async holder is inside', async () => {
		const dir = tempDir('lock-same-process');
		await withLock(dir, 'x', { timeoutMs: 1_000, staleMs: 60_000 } as LockOptions, async () => {
			const started = Date.now();
			expect(() => withLockSync(dir, 'x', { timeoutMs: 100, staleMs: 60_000 } as LockOptions, () => 1)).toThrow(
				expect.objectContaining({ code: 'LOCK_TIMEOUT' }),
			);
			expect(Date.now() - started).toBeLessThan(2_000);
		});
	});
});

describe('#4 crash-left quarantine is cleaned before source validation', () => {
	it.each([
		['roots removed', (root: string) => ({ localRoots: [] as string[], location: join(root, 'repo') })],
		['source gone', (root: string) => ({ localRoots: [root], location: join(root, 'vanished') })],
	])('%s: validation fails but the dead staging dir is removed', async (_label, scenario) => {
		const root = tempDir('sweep-first');
		makeRepo(root, 'repo', { 'a.ts': 'export const a = 1;\n' });
		const { localRoots, location } = scenario(root);
		const dataDir = join(root, 'data');
		const reg = new Registry(dataDir);
		reg.addProject('p', 'P');
		reg.addSource('p', { id: 'main', kind: 'local', location, defaultRef: 'main' });
		const staging = join(dataDir, 'quarantine', 'p', `main.${deadPid()}.0123456789abcdef.git`);
		mkdirSync(staging, { recursive: true });
		writeFileSync(join(staging, 'HEAD'), 'ref: refs/heads/main\n');
		const cfg: RuntimeConfig = { dataDir, localRoots };
		await expect(createSnapshot(cfg, 'p')).rejects.toBeInstanceOf(CodeTrailError);
		expect(existsSync(staging)).toBe(false);
		expect(readFileSync(join(dataDir, 'registry.json'), 'utf8')).toContain('"p"');
	});
});
