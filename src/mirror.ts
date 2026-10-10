import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CodeTrailError } from './errors.js';
import { isFullSha } from './ids.js';
import { GIT_READ_ATTEMPTS, runGit, runGitText, withRetry } from './git.js';
import type { SourceRecord } from './registry.js';

/**
 * Each source gets a bare mirror under <dataDir>/mirrors/<project>/<source>.git.
 * The source repository itself is only ever read (clone/fetch from it); its
 * working tree, index and refs are never touched.
 */
export function mirrorPath(dataDir: string, projectId: string, sourceId: string): string {
	return join(dataDir, 'mirrors', projectId, `${sourceId}.git`);
}

export async function syncMirror(dataDir: string, projectId: string, source: SourceRecord): Promise<string> {
	const gitDir = mirrorPath(dataDir, projectId, source.id);
	if (!existsSync(gitDir)) {
		mkdirSync(join(dataDir, 'mirrors', projectId), { recursive: true });
		// --no-local: copy objects through the pack protocol instead of hardlinking
		// into the source repo's object store.
		const localFlags = source.kind === 'local' ? ['--no-local'] : [];
		const clear = (): void => rmSync(gitDir, { recursive: true, force: true });
		await withRetry(GIT_READ_ATTEMPTS, () => runGit(['clone', '--bare', '--quiet', ...localFlags, '--', source.location, gitDir], { attempts: 1 }), clear).catch(
			(err: unknown) => {
				clear();
				throw err;
			},
		);
	}
	await runGit(['fetch', '--quiet', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/heads/*'], { gitDir });
	return gitDir;
}

/** Resolves a branch/tag/sha in the mirror to a full commit SHA. */
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
