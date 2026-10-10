import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CodeTrailError } from './errors.js';
import { isFullSha } from './ids.js';
import { GIT_READ_ATTEMPTS, runGit, runGitText, withRetry } from './git.js';
import { isPidAlive } from './lock.js';

/**
 * Raw Git data is quarantined. A source is cloned (bare) into a unique staging
 * directory under <dataDir>/quarantine/<project>/ for the duration of one
 * snapshot run and deleted afterwards — on success, on a blocked snapshot and
 * on error. Nothing outside quarantine/ ever points at it, so raw history
 * (which may contain secrets the scanner later blocks) never becomes a
 * persistent or served artifact. The source repository is only read.
 *
 * Retention: zero after the run. Crash recovery: staging directories whose
 * owning pid (encoded in the name) is no longer alive are removed at the start
 * of the next run for the same project, under the project snapshot lock.
 */
const STAGING_NAME = /^([a-z0-9-]+)\.(\d+)\.([0-9a-f]{16})\.git$/;

export function quarantineDir(dataDir: string, projectId: string): string {
	return join(dataDir, 'quarantine', projectId);
}

/** Removes staging directories left behind by processes that no longer exist. */
export function sweepStaleStaging(dataDir: string, projectId: string): string[] {
	const dir = quarantineDir(dataDir, projectId);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names) {
		const match = STAGING_NAME.exec(name);
		if (!match || isPidAlive(Number(match[2]))) continue;
		rmSync(join(dir, name), { recursive: true, force: true });
		removed.push(name);
	}
	return removed;
}

export interface StagedSource {
	sourceId: string;
	gitDir: string;
}

/**
 * Clones `location` into a fresh staging directory. Each attempt uses its own
 * directory and only that directory is cleaned up on failure.
 */
export async function cloneToQuarantine(dataDir: string, projectId: string, sourceId: string, location: string, local: boolean): Promise<StagedSource> {
	const dir = quarantineDir(dataDir, projectId);
	mkdirSync(dir, { recursive: true });
	// --no-local: copy objects through the pack protocol instead of hardlinking
	// into the source repo's object store.
	const flags = local ? ['--no-local'] : [];
	const gitDir = await withRetry(GIT_READ_ATTEMPTS, async () => {
		const staging = join(dir, `${sourceId}.${process.pid}.${randomBytes(8).toString('hex')}.git`);
		try {
			await runGit(['clone', '--bare', '--quiet', ...flags, '--', location, staging], { attempts: 1 });
			return staging;
		} catch (err) {
			rmSync(staging, { recursive: true, force: true });
			throw err;
		}
	});
	return { sourceId, gitDir };
}

export function discardStaged(staged: readonly StagedSource[]): void {
	for (const s of staged) rmSync(s.gitDir, { recursive: true, force: true });
}

/** Resolves a branch/tag/sha in the staged clone to a full commit SHA. */
export async function resolveCommit(gitDir: string, ref: string): Promise<string> {
	if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) || ref.startsWith('-') || ref.includes('..')) {
		throw new CodeTrailError('INVALID_REF', 'Invalid ref');
	}
	try {
		const sha = await runGitText(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { gitDir, attempts: 1 });
		if (!isFullSha(sha)) throw new Error('not a sha');
		return sha;
	} catch {
		throw new CodeTrailError('INVALID_REF', `Ref not found as a commit: ${ref}`);
	}
}
