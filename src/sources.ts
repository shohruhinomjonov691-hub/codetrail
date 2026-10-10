import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { CodeTrailError } from './errors.js';

export type SourceKind = 'local' | 'github';

/**
 * Only plain `https://github.com/<owner>/<repo>[.git]` is accepted: no
 * credentials, ports, query strings, fragments, extra path segments, ssh or
 * file URLs, and no other hosts. The canonical form is what gets cloned.
 */
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

export function normalizeGithubUrl(input: string): string {
	const url = input.trim();
	const match = GITHUB_URL.exec(url);
	if (!match) throw new CodeTrailError('INVALID_GITHUB_URL', 'Only https://github.com/<owner>/<repo> URLs are accepted');
	const owner = match[1] as string;
	const repo = match[2] as string;
	if (repo === '.' || repo === '..' || repo.startsWith('.')) {
		throw new CodeTrailError('INVALID_GITHUB_URL', 'Only https://github.com/<owner>/<repo> URLs are accepted');
	}
	return `https://github.com/${owner}/${repo}.git`;
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !isAbsolute(rel));
}

/**
 * A local source must resolve (after following symlinks) inside one of the
 * operator-configured roots and must be a Git repository. Returns the real path.
 */
export function resolveLocalSource(input: string, localRoots: readonly string[]): string {
	if (!isAbsolute(input)) throw new CodeTrailError('INVALID_LOCAL_PATH', 'Local source path must be absolute');
	if (localRoots.length === 0) {
		throw new CodeTrailError('LOCAL_PATH_OUTSIDE_ROOTS', 'Local sources are disabled: set CODETRAIL_LOCAL_ROOTS');
	}
	let real: string;
	try {
		real = realpathSync(input);
	} catch {
		throw new CodeTrailError('INVALID_LOCAL_PATH', 'Local source path does not exist');
	}
	const realRoots = localRoots.flatMap((root) => {
		try {
			return [realpathSync(root)];
		} catch {
			return [];
		}
	});
	if (!realRoots.some((root) => isInside(real, root))) {
		throw new CodeTrailError('LOCAL_PATH_OUTSIDE_ROOTS', 'Local source path is outside CODETRAIL_LOCAL_ROOTS');
	}
	const isRepo = [`${real}/.git`, `${real}/HEAD`].some((candidate) => {
		try {
			statSync(candidate);
			return true;
		} catch {
			return false;
		}
	});
	if (!isRepo) throw new CodeTrailError('NOT_A_GIT_REPO', 'Local source path is not a Git repository');
	return real;
}
