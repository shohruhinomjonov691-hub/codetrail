import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CodeTrailError } from './errors.js';

/**
 * Cross-process lock built on an atomic `link(2)` of a fully written owner file:
 * the lock file either does not exist or contains a complete owner record.
 *
 * Rules:
 * - Acquire: link a temp owner file to `<name>.lock`; EEXIST → wait with backoff.
 * - Timeout: give up after `timeoutMs` with LOCK_TIMEOUT (owner pid in message).
 * - Stale: a lock is stale only if its owner is on this host and the pid is no
 *   longer alive, or (other host / unreadable record) it is older than `staleMs`.
 * - Breaking a stale lock happens under a short-lived `<name>.lock.break` guard
 *   and re-checks the owner token, so two waiters can never both break it or
 *   delete a fresh lock. A break guard older than BREAK_GUARD_STALE_MS is removed.
 * - Release only deletes the lock if it still carries this holder's token.
 */
export interface LockOptions {
	timeoutMs: number;
	staleMs: number;
}

export const LOCK_DEFAULTS = {
	registry: { timeoutMs: 10_000, staleMs: 60_000 },
	snapshot: { timeoutMs: 10 * 60_000, staleMs: 60 * 60_000 },
} as const satisfies Record<string, LockOptions>;

const BREAK_GUARD_STALE_MS = 30_000;

interface Owner {
	pid: number;
	host: string;
	token: string;
	created: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function readOwner(path: string): Owner | null {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Owner;
		return typeof parsed.pid === 'number' && typeof parsed.token === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

function ageMs(path: string): number {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

export function isStale(owner: Owner | null, path: string, staleMs: number): boolean {
	if (owner && owner.host === hostname()) return !isPidAlive(owner.pid);
	return ageMs(path) > staleMs;
}

function tryLink(target: string, owner: Owner): boolean {
	const tmp = `${target}.${owner.pid}.${owner.token}.tmp`;
	writeFileSync(tmp, JSON.stringify(owner));
	try {
		linkSync(tmp, target);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw err;
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* already gone */
		}
	}
}

function tryBreakStale(path: string, seen: Owner | null): void {
	const guard = `${path}.break`;
	const me: Owner = { pid: process.pid, host: hostname(), token: randomBytes(8).toString('hex'), created: Date.now() };
	if (!tryLink(guard, me)) {
		if (ageMs(guard) > BREAK_GUARD_STALE_MS) {
			try {
				unlinkSync(guard);
			} catch {
				/* someone else removed it */
			}
		}
		return;
	}
	try {
		const current = readOwner(path);
		const sameOwner = current === null ? seen === null : seen !== null && current.token === seen.token;
		if (sameOwner) {
			try {
				unlinkSync(path);
			} catch {
				/* released meanwhile */
			}
		}
	} finally {
		try {
			unlinkSync(guard);
		} catch {
			/* ignore */
		}
	}
}

function prepare(locksDir: string, name: string): { path: string; me: Owner } {
	if (!/^[a-z0-9][a-z0-9.-]{0,120}$/.test(name)) throw new CodeTrailError('USAGE', 'invalid lock name');
	mkdirSync(locksDir, { recursive: true });
	return {
		path: join(locksDir, `${name}.lock`),
		me: { pid: process.pid, host: hostname(), token: randomBytes(12).toString('hex'), created: Date.now() },
	};
}

/** One acquisition attempt; returns the wait (ms) before the next attempt, or null when acquired. */
function attempt(path: string, me: Owner, name: string, opts: LockOptions, deadline: number, delay: number): number | null {
	if (tryLink(path, me)) return null;
	const owner = readOwner(path);
	if (isStale(owner, path, opts.staleMs)) {
		tryBreakStale(path, owner);
		return 0;
	}
	if (Date.now() >= deadline) {
		throw new CodeTrailError('LOCK_TIMEOUT', `Timed out waiting for lock ${name} (held by pid ${owner?.pid ?? 'unknown'})`);
	}
	return delay + Math.floor(Math.random() * delay);
}

function release(path: string, me: Owner): void {
	if (readOwner(path)?.token === me.token) {
		try {
			unlinkSync(path);
		} catch {
			/* ignore */
		}
	}
}

export async function withLock<T>(locksDir: string, name: string, opts: LockOptions, fn: () => Promise<T> | T): Promise<T> {
	const { path, me } = prepare(locksDir, name);
	const deadline = Date.now() + opts.timeoutMs;
	let delay = 10;
	for (let wait = attempt(path, me, name, opts, deadline, delay); wait !== null; wait = attempt(path, me, name, opts, deadline, delay)) {
		if (wait > 0) {
			await sleep(wait);
			delay = Math.min(delay * 2, 250);
		}
	}
	try {
		return await fn();
	} finally {
		release(path, me);
	}
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous variant for short critical sections (registry read–modify–write). */
export function withLockSync<T>(locksDir: string, name: string, opts: LockOptions, fn: () => T): T {
	const { path, me } = prepare(locksDir, name);
	const deadline = Date.now() + opts.timeoutMs;
	let delay = 10;
	for (let wait = attempt(path, me, name, opts, deadline, delay); wait !== null; wait = attempt(path, me, name, opts, deadline, delay)) {
		if (wait > 0) {
			Atomics.wait(sleeper, 0, 0, wait);
			delay = Math.min(delay * 2, 250);
		}
	}
	try {
		return fn();
	} finally {
		release(path, me);
	}
}
