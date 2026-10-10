/**
 * Repository-relative paths come from Git trees, which an attacker controls for
 * an imported repo. Anything that could escape the snapshot directory or
 * confuse downstream tooling is rejected instead of being "cleaned up".
 */
export function isSafeRepoPath(path: string): boolean {
	if (path.length === 0 || path.length > 1024) return false;
	if (path.startsWith('/') || path.includes('\\')) return false;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(path)) return false;
	if (/^[A-Za-z]:/.test(path)) return false;
	const segments = path.split('/');
	return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
