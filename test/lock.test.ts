import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { gitEnv } from '../src/git.js';
import { LOCK_DEFAULTS, withLock, withLockSync } from '../src/lock.js';
import { tempDir, DIST } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const fast = { timeoutMs: 300 };

describe('cross-process lock (OS file lock)', () => {
	beforeAll(() => {
	});

	it('excludes a second acquisition in the same process until release', async () => {
		const dir = tempDir('lock-same');
		const order: string[] = [];
		const first = withLock(dir, 'x', fast, async () => {
			order.push('a-in');
			await new Promise((r) => setTimeout(r, 100));
			order.push('a-out');
		});
		await new Promise((r) => setTimeout(r, 10));
		await withLock(dir, 'x', { timeoutMs: 2_000 }, () => order.push('b-in'));
		await first;
		expect(order).toEqual(['a-in', 'a-out', 'b-in']);
	});

	it('releases on error, and writes a diagnostic owner file', async () => {
		const dir = tempDir('lock-release');
		await expect(withLock(dir, 'x', fast, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
		expect(withLockSync(dir, 'x', fast, () => 'free again')).toBe('free again');
		expect(JSON.parse(readFileSync(join(dir, 'x.owner.json'), 'utf8')).pid).toBe(process.pid);
	});

	it('ignores leftover files from the previous lock protocol', async () => {
		const dir = tempDir('lock-legacy');
		writeFileSync(join(dir, 'x.lock'), JSON.stringify({ pid: process.pid, host: 'h', token: 't', created: 0 }));
		writeFileSync(join(dir, 'x.lock.break'), '{}');
		expect(await withLock(dir, 'x', fast, () => 1)).toBe(1);
		expect(existsSync(join(dir, 'x.lock'))).toBe(true); // never deleted by the new lock
	});

	it('rejects invalid lock names', () => {
		expect(() => withLockSync(tempDir('lock-name'), '../x', fast, () => 1)).toThrow(/invalid lock name/);
	});

	it('serializes read–modify–write across separate processes', async () => {
		const dir = tempDir('lock-procs');
		const counter = join(dir, 'counter.txt');
		writeFileSync(counter, '0');
		const script = `
			import { withLock } from ${JSON.stringify(join(DIST, 'lock.js'))};
			import { readFileSync, writeFileSync } from 'node:fs';
			const [dir, counter] = process.argv.slice(1);
			for (let i = 0; i < 5; i++) {
				await withLock(dir, 'counter', { timeoutMs: 20000 }, async () => {
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
		expect(LOCK_DEFAULTS.registry).toEqual({ timeoutMs: 10_000 });
		expect(LOCK_DEFAULTS.snapshot).toEqual({ timeoutMs: 600_000 });
	});
});

describe('git environment', () => {
	it('drops inherited variables that redirect git to other repositories or config', () => {
		const keys = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_SSH_COMMAND'];
		const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
		try {
			for (const k of keys) process.env[k] = '/tmp/evil';
			const env = gitEnv();
			for (const k of keys) expect(env[k]).toBeUndefined();
			expect(env.GIT_TERMINAL_PROMPT).toBe('0');
			expect(env.PATH).toBe(process.env.PATH);
		} finally {
			for (const k of keys) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
	});
});
