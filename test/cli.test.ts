import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CANARY, makeRepo, tempDir } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli.js');

function run(env: NodeJS.ProcessEnv, ...args: string[]): { code: number | null; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
	return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('cli', () => {
	beforeAll(() => {
		execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'ignore' });
	});

	it('onboards a local repo, blocks on a secret and never prints it', () => {
		const root = tempDir('cli');
		const repo = makeRepo(root, 'repo', {
			'src/a.ts': 'export const a = 1;\n',
			'src/leak.ts': `export const t = '${CANARY.githubToken}';\n`,
		});
		const env = { CODETRAIL_DATA_DIR: join(root, 'data'), CODETRAIL_LOCAL_ROOTS: root };
		expect(run(env, 'project', 'add', 'demo').code).toBe(0);
		expect(run(env, 'source', 'add-local', 'demo', 'main', repo.dir, '--ref', 'main').code).toBe(0);
		const snap = run(env, 'snapshot', 'create', 'demo');
		expect(snap.code).toBe(2);
		const out = JSON.parse(snap.stdout) as { result: string; secret_findings: unknown[] };
		expect(out.result).toBe('blocked');
		expect(out.secret_findings).toEqual([{ source_id: 'main', path: 'src/leak.ts', detector: 'github-token', confidence: 'high', count: 1 }]);
		expect(snap.stdout + snap.stderr).not.toContain(CANARY.githubToken);
	});

	it('rejects bad input with stable error codes', () => {
		const root = tempDir('cli-bad');
		const env = { CODETRAIL_DATA_DIR: join(root, 'data'), CODETRAIL_LOCAL_ROOTS: join(root, 'allowed') };
		expect(run(env, 'project', 'add', 'Bad_Id').stderr).toContain('INVALID_ID');
		expect(run(env, 'project', 'add', 'demo').code).toBe(0);
		const credentialUrl = ['https://user', ':', 'pw', '@github.com/a/b'].join('');
		const url = run(env, 'source', 'add-github', 'demo', 'gh', credentialUrl);
		expect(url.code).toBe(1);
		expect(url.stderr).toContain('INVALID_GITHUB_URL');
		expect(url.stderr).not.toContain('pw@');
		expect(run(env, 'source', 'add-local', 'demo', 'loc', '/etc').stderr).toContain('LOCAL_PATH_OUTSIDE_ROOTS');
		expect(run(env, 'snapshot', 'show', 'demo', '../../etc').stderr).toContain('INVALID_ID');
		expect(run(env, 'bogus').code).toBe(64);
	});
});
