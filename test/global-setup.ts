import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Builds the CLI/library ONCE, before any test worker starts, into a separate
 * dist-test/ directory. Previously several test files ran `tsc` into the shared
 * dist/ in parallel while other files' child processes imported from it.
 */
export default function setup(): void {
	const root = join(import.meta.dirname, '..');
	const out = join(root, 'dist-test');
	rmSync(out, { recursive: true, force: true });
	execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', out], { cwd: root, stdio: 'inherit' });
}
