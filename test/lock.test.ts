import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOCK_DEFAULTS, withLock, withLockSync } from '../src/lock.js';
import { tempDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const fast = { timeoutMs: 300, staleMs: 1_000 };

function deadPid(): number {
	const res = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
	return Number(res.stdout);
}

function writeLock(dir: string, name: string, owner: { pid: number; host: string; token: string }): string {
	const path = join(dir, `${name}.lock`);
	writeFileSync(path, JSON.stringify({ ...owner, created: Date.now() }));
	return path;
}

describe('cross-process lock', () => {
	beforeAll(() => {
		execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'ignore' });
	});

	it('times out while a live owner holds the lock', async () => {
		const dir = tempDir('lock-timeout');
		writeLock(dir, 'x', { pid: process.pid, host: hostname(), token: 'someone-else' });
		const started = Date.now();
		await expect(withLock(dir, 'x', fast, () => 1)).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(() => withLockSync(dir, 'x', fast, () => 1)).toThrow(/Timed out/);
		// a foreign lock is never removed by a waiter that timed out
		expect(JSON.parse(readFileSync(join(dir, 'x.lock'), 'utf8')).token).toBe('someone-else');
	});

	it('recovers a stale lock whose owner process is dead (same host)', async () => {
		const dir = tempDir('lock-stale');
		writeLock(dir, 'x', { pid: deadPid(), host: hostname(), token: 'dead' });
		expect(await withLock(dir, 'x', fast, () => 'got it')).toBe('got it');
		expect(existsSync(join(dir, 'x.lock'))).toBe(false);
	});

	it('treats other-host locks as stale only after staleMs', async () => {
		const dir = tempDir('lock-host');
		const path = writeLock(dir, 'x', { pid: 1, host: 'some-other-host', token: 'remote' });
		await expect(withLock(dir, 'x', fast, () => 1)).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
		const old = (Date.now() - 5_000) / 1000;
		utimesSync(path, old, old);
		expect(await withLock(dir, 'x', fast, () => 2)).toBe(2);
	});

	it('releases on error and does not delete a lock it no longer owns', async () => {
		const dir = tempDir('lock-release');
		await expect(withLock(dir, 'x', fast, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
		expect(existsSync(join(dir, 'x.lock'))).toBe(false);
		await withLock(dir, 'x', fast, () => {
			writeLock(dir, 'x', { pid: process.pid, host: hostname(), token: 'replaced' });
		});
		expect(JSON.parse(readFileSync(join(dir, 'x.lock'), 'utf8')).token).toBe('replaced');
	});

	it('serializes read–modify–write across separate processes', async () => {
		const dir = tempDir('lock-procs');
		const counter = join(dir, 'counter.txt');
		writeFileSync(counter, '0');
		const script = `
			import { withLock } from ${JSON.stringify(join(ROOT, 'dist', 'lock.js'))};
			import { readFileSync, writeFileSync } from 'node:fs';
			const [dir, counter] = process.argv.slice(1);
			for (let i = 0; i < 5; i++) {
				await withLock(dir, 'counter', { timeoutMs: 20000, staleMs: 60000 }, async () => {
					const n = Number(readFileSync(counter, 'utf8'));
					await new Promise((r) => setTimeout(r, 5));
					writeFileSync(counter, String(n + 1));
				});
			}`;
		const runs = Array.from({ length: 6 }, () =>
			new Promise<number | null>((resolvePromise) => {
				const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, counter], { stdio: 'ignore' });
				child.on('close', resolvePromise);
			}),
		);
		expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0, 0]);
		expect(readFileSync(counter, 'utf8')).toBe('30');
	});

	it('documents the default timeouts', () => {
		expect(LOCK_DEFAULTS.registry).toEqual({ timeoutMs: 10_000, staleMs: 60_000 });
		expect(LOCK_DEFAULTS.snapshot.timeoutMs).toBe(600_000);
	});
});
