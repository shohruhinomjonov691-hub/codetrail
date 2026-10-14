import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

function realOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/**
 * Locates the repository's git dir without running git inside it: a `.git`
 * directory or symlink, a `gitdir:` file (worktrees/submodules), or a bare repo.
 */
function locateGitDir(workTree: string): string | null {
	const dotGit = join(workTree, '.git');
	let st;
	try {
		st = lstatSync(dotGit);
	} catch {
		st = null;
	}
	if (st) {
		if (st.isFile()) {
			const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
			return match ? realOrNull(resolve(workTree, match[1] as string)) : null;
		}
		return realOrNull(dotGit);
	}
	return existsSync(join(workTree, 'HEAD')) && existsSync(join(workTree, 'objects')) ? workTree : null;
}

/** Upper bound on alternates chain length; git itself stops at 5 levels. */
const MAX_ALTERNATES_DEPTH = 16;

/**
 * Real paths git could read objects from: the object store, every object store
 * reachable through `objects/info/alternates` — followed recursively with cycle
 * and depth protection — and any symlinked pack/loose entries in each store.
 */
function objectSourcePaths(commonDir: string): { paths: string[]; unsupported: boolean } {
	const paths: string[] = [];
	let unsupported = false;
	const visited = new Set<string>();
	/**
	 * Walks the object store. Symlinked FILES must resolve inside the roots (checked
	 * by the caller via `paths`); symlinked DIRECTORIES are rejected outright,
	 * because their entries could point anywhere and git reads through them.
	 */
	const scanStore = (dir: string, depth: number): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			const st = lstatSync(full);
			if (st.isSymbolicLink()) {
				const real = realOrNull(full);
				if (!real || statSync(real).isDirectory()) unsupported = true;
				else paths.push(real);
			} else if (st.isDirectory()) {
				if (depth > 0) scanStore(full, depth - 1);
				else unsupported = true; // deeper than any git object layout
			}
		}
	};
	const visit = (objectsDir: string, depth: number): void => {
		const real = realOrNull(objectsDir);
		if (!real) {
			unsupported = true;
			return;
		}
		if (visited.has(real)) return; // cycle
		if (depth > MAX_ALTERNATES_DEPTH) {
			unsupported = true;
			return;
		}
		visited.add(real);
		paths.push(real);
		if (existsSync(join(real, 'info', 'http-alternates'))) unsupported = true;
		scanStore(real, 3);
		const alternates = join(real, 'info', 'alternates');
		if (!existsSync(alternates)) return;
		for (const line of readFileSync(alternates, 'utf8').split('\n')) {
			const entry = line.trim();
			if (!entry || entry.startsWith('#')) continue;
			// Relative entries are relative to this object store (git semantics).
			visit(resolve(real, entry), depth + 1);
		}
	};
	visit(join(commonDir, 'objects'), 0);
	return { paths, unsupported };
}

/**
 * A local source must resolve (after following symlinks) inside one of the
 * operator-configured roots — and so must its git dir, its common dir (for
 * worktrees), its object store, any object alternates and any symlinked object
 * files. Returns the real work-tree (or bare repo) path. Called when a source
 * is registered and again before every snapshot.
 */
export function resolveLocalSource(input: string, localRoots: readonly string[]): string {
	if (!isAbsolute(input)) throw new CodeTrailError('INVALID_LOCAL_PATH', 'Local source path must be absolute');
	if (localRoots.length === 0) {
		throw new CodeTrailError('LOCAL_PATH_OUTSIDE_ROOTS', 'Local sources are disabled: set CODETRAIL_LOCAL_ROOTS');
	}
	const real = realOrNull(input);
	if (!real) throw new CodeTrailError('INVALID_LOCAL_PATH', 'Local source path does not exist');
	const realRoots = localRoots.map(realOrNull).filter((r): r is string => r !== null);
	const inside = (path: string): boolean => realRoots.some((root) => isInside(path, root));
	if (!inside(real)) {
		throw new CodeTrailError('LOCAL_PATH_OUTSIDE_ROOTS', 'Local source path is outside CODETRAIL_LOCAL_ROOTS');
	}
	if (!statSync(real).isDirectory()) throw new CodeTrailError('NOT_A_GIT_REPO', 'Local source path is not a Git repository');
	const gitDir = locateGitDir(real);
	if (!gitDir || !existsSync(join(gitDir, 'HEAD'))) throw new CodeTrailError('NOT_A_GIT_REPO', 'Local source path is not a Git repository');
	const commonFile = join(gitDir, 'commondir');
	const commonDir = existsSync(commonFile) ? realOrNull(resolve(gitDir, readFileSync(commonFile, 'utf8').trim())) : gitDir;
	if (!commonDir) throw new CodeTrailError('UNSAFE_SOURCE', 'Repository common dir cannot be resolved');
	const objects = objectSourcePaths(commonDir);
	if (objects.unsupported) {
		throw new CodeTrailError('UNSAFE_SOURCE', 'Repository object store uses symlinked directories, unresolvable links or HTTP alternates');
	}
	for (const path of [gitDir, commonDir, ...objects.paths]) {
		if (!inside(path)) {
			throw new CodeTrailError('LOCAL_PATH_OUTSIDE_ROOTS', 'Repository git data resolves outside CODETRAIL_LOCAL_ROOTS');
		}
	}
	return real;
}
