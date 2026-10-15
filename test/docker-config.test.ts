/**
 * Static consistency checks for the Docker deployment files (no Docker needed):
 * pinned runtime and server flags match models.lock.json, the model path is
 * identical in both containers (the embedding identity check compares
 * realpaths), the app port is loopback-only, data is mounted read-only for the
 * server, and no secret, data or weights can enter an image.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const lock = JSON.parse(read('models.lock.json')) as {
	runtime: { release: string; serverArgs: string[]; assets: Record<string, { sha256: string; url: string }> };
	embedding: { file: string };
};
const embedDockerfile = read('docker/embed.Dockerfile');
const appDockerfile = read('Dockerfile');
const compose = read('compose.yaml');
const dockerignore = read('.dockerignore').split('\n').map((l) => l.trim());

const arg = (name: string) => new RegExp(`ARG ${name}=(\\S+)`).exec(embedDockerfile)?.[1];
/** The JSON-ish array that follows `key:` in compose.yaml (single/multi-line). */
function composeArray(key: string, from = 0): string[] {
	const i = compose.indexOf(`${key}: [`, from);
	expect(i).toBeGreaterThanOrEqual(0);
	const body = compose.slice(compose.indexOf('[', i) + 1, compose.indexOf(']', i));
	return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);
}

describe('embedding image and server flags follow models.lock.json', () => {
	it('release and archive checksums are the pinned ones', () => {
		expect(arg('LLAMA_RELEASE')).toBe(lock.runtime.release);
		expect(arg('LLAMA_SHA256_AMD64')).toBe(lock.runtime.assets['ubuntu-x64']?.sha256);
		expect(arg('LLAMA_SHA256_ARM64')).toBe(lock.runtime.assets['ubuntu-arm64']?.sha256);
		expect(embedDockerfile).toMatch(/sha256sum -c -/);
		for (const from of embedDockerfile.matchAll(/^FROM (\S+)/gm)) expect(from[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
		for (const from of appDockerfile.matchAll(/^FROM (\S+)/gm)) expect(from[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
	});

	it('llama-server runs with the lock serverArgs (only the bind host differs) and the locked model file', () => {
		const cmd = composeArray('command', compose.indexOf('llama-embed:'));
		expect(cmd.slice(0, 2)).toEqual(['-m', `/models/models/${lock.embedding.file}`]);
		const expected = [...lock.runtime.serverArgs];
		expected[expected.indexOf('--host') + 1] = '0.0.0.0';
		expect(cmd.slice(2)).toEqual(expected);
	});

	it('both containers see the model at the same path (identity compares realpaths)', () => {
		const modelFile = /CODETRAIL_EMBED_MODEL_FILE: (\S+)/g;
		const paths = [...compose.matchAll(modelFile)].map((m) => m[1]);
		expect(paths.length).toBeGreaterThanOrEqual(2);
		for (const p of paths) expect(p).toBe(`/models/models/${lock.embedding.file}`);
		expect(compose.match(/:\/models:ro"/g)?.length).toBeGreaterThanOrEqual(3);
	});
});

describe('exposure and secrets', () => {
	it('the app port is published on loopback only; the embedding server is not published', () => {
		expect(compose).toMatch(/- "127\.0\.0\.1:\$\{CODETRAIL_HTTP_PORT:-8080\}:8080"/);
		const embed = compose.slice(compose.indexOf('  llama-embed:'), compose.indexOf('  codetrail:'));
		expect(embed).not.toMatch(/ports:/);
		expect(compose).toMatch(/internal: \{ internal: true \}/);
	});

	it('the index job uses a small batch and a long document timeout (2-CPU container)', () => {
		const job = compose.slice(compose.indexOf('  codetrail-index:'));
		expect(job).toMatch(/CODETRAIL_EMBED_BATCH_SIZE: "\$\{CODETRAIL_EMBED_BATCH_SIZE:-1\}"/);
		expect(job).toMatch(/CODETRAIL_EMBED_DOC_TIMEOUT_MS: "\$\{CODETRAIL_EMBED_DOC_TIMEOUT_MS:-300000\}"/);
		expect(compose).not.toMatch(/QUERY_TIMEOUT/);
	});

	it('the server mounts data read-only; only the one-off index job writes', () => {
		const server = compose.slice(compose.indexOf('  codetrail:'), compose.indexOf('  codetrail-index:'));
		expect(server).toMatch(/:\/data:ro"/);
		expect(compose.slice(compose.indexOf('  codetrail-index:'))).toMatch(/profiles: \[index\]/);
	});

	it('no key value in compose; secrets only via the runtime env file; nothing secret in the build context', () => {
		expect(compose).not.toMatch(/OPENAI_API_KEY\s*[:=]/);
		expect(compose).toMatch(/env_file:/);
		for (const entry of ['.env', '.env.*', 'data', 'models', '*.gguf', 'deploy-data', '.git']) expect(dockerignore).toContain(entry);
		expect(appDockerfile).not.toMatch(/COPY\s+(\.env|data|deploy-data|models)\b/);
		expect(appDockerfile).toMatch(/^USER node$/m);
		expect(embedDockerfile).toMatch(/^USER llama$/m);
	});
});
