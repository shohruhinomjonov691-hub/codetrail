#!/usr/bin/env node
// Downloads the pinned runtime and embedding model into CODETRAIL_MODELS_DIR
// (outside the repository) and verifies every file against models.lock.json.
// Usage: CODETRAIL_MODELS_DIR=~/Developer/codetrail-models node scripts/fetch-models.mjs [macos-arm64|ubuntu-x64]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const lock = JSON.parse(readFileSync(resolve('models.lock.json'), 'utf8'));
const dir = resolve(process.env.CODETRAIL_MODELS_DIR || 'models');
const platform = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined) || (process.platform === 'darwin' ? 'macos-arm64' : 'ubuntu-x64');

const sha256 = (path) =>
	new Promise((ok, fail) => {
		const h = createHash('sha256');
		createReadStream(path).on('data', (d) => h.update(d)).on('error', fail).on('end', () => ok(h.digest('hex')));
	});

async function fetchVerified(url, dest, expected) {
	if (existsSync(dest) && (await sha256(dest)) === expected) return console.log(`ok (cached) ${dest}`);
	const tmp = `${dest}.part`;
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${url}`);
	await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
	const got = await sha256(tmp);
	if (got !== expected) {
		rmSync(tmp, { force: true });
		throw new Error(`sha256 mismatch for ${url}`);
	}
	renameSync(tmp, dest);
	console.log(`ok ${dest}`);
}

const asset = lock.runtime.assets[platform];
if (!asset) throw new Error(`no runtime asset for ${platform}`);
mkdirSync(join(dir, 'downloads'), { recursive: true });
mkdirSync(join(dir, 'models'), { recursive: true });
const archive = join(dir, 'downloads', asset.url.split('/').pop());
await fetchVerified(asset.url, archive, asset.sha256);
const runtimeDir = join(dir, 'runtime', lock.runtime.release);
mkdirSync(runtimeDir, { recursive: true });
execFileSync('tar', ['-xzf', archive, '-C', runtimeDir]);
await fetchVerified(lock.embedding.url, join(dir, 'models', lock.embedding.file), lock.embedding.sha256);
// The D0 generation benchmark model is fetched only on request: node scripts/fetch-models.mjs <platform> --generation
if (lock.generation && process.argv.includes('--generation')) {
	await fetchVerified(lock.generation.url, join(dir, 'models', lock.generation.file), lock.generation.sha256);
}
