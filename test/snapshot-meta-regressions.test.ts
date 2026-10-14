/**
 * Regressions for the non-blocking P3 of the 66b0640 review: an existing snapshot
 * whose metadata files are missing or malformed must fail with SNAPSHOT_CORRUPT,
 * while a snapshot that does not exist stays UNKNOWN_SNAPSHOT and a schema-1
 * snapshot stays SNAPSHOT_OUTDATED.
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { createSnapshot, readSnapshot, readSourceTexts, snapshotsRoot } from '../src/snapshot.js';
import { makeRepo, tempDir } from './helpers.js';

let cfg: RuntimeConfig;
let snapshotId: string;

beforeAll(async () => {
	const root = tempDir('snapmeta');
	const repo = makeRepo(root, 'repo', { 'src/a.ts': 'export const A = 1;\n' });
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	reg.addProject('app', 'App');
	reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	snapshotId = (await createSnapshot(cfg, 'app')).report.snapshot_id;
});

function tampered(name: string, mutate: (dir: string) => void): string {
	const dataDir = join(tempDir(`snapmeta-${name}`), 'data');
	cpSync(cfg.dataDir, dataDir, { recursive: true });
	mutate(join(snapshotsRoot(dataDir, 'app'), snapshotId));
	return dataDir;
}

const read = (dataDir: string) => () => readSnapshot(dataDir, 'app', snapshotId);

describe('missing or malformed metadata of an existing snapshot is SNAPSHOT_CORRUPT', () => {
	it.each([
		['missing chunks.jsonl', (dir: string) => rmSync(join(dir, 'chunks.jsonl'))],
		['missing report.json', (dir: string) => rmSync(join(dir, 'report.json'))],
		['missing manifest.json', (dir: string) => rmSync(join(dir, 'manifest.json'))],
		['malformed manifest.json (not JSON)', (dir: string) => writeFileSync(join(dir, 'manifest.json'), '{"schema": 2,')],
		['malformed manifest.json (wrong shape)', (dir: string) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 2 }))],
		['malformed chunks.jsonl line', (dir: string) => writeFileSync(join(dir, 'chunks.jsonl'), readFileSync(join(dir, 'chunks.jsonl'), 'utf8') + '{oops\n')],
	])('%s', (name, mutate) => {
		expect(read(tampered(name.replace(/\W+/g, '-'), mutate))).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CORRUPT', message: expect.stringContaining('codetrail snapshot create app') }));
	});
});

describe('other errors are kept', () => {
	it('a snapshot that does not exist is UNKNOWN_SNAPSHOT', () => {
		expect(() => readSnapshot(cfg.dataDir, 'app', 'f'.repeat(24))).toThrow(expect.objectContaining({ code: 'UNKNOWN_SNAPSHOT' }));
	});

	it('a schema-1 snapshot is SNAPSHOT_OUTDATED for whole-file readers', () => {
		const dataDir = tampered('schema1', (dir) => {
			const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
			writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, schema: 1 }));
			rmSync(join(dir, 'files'), { recursive: true, force: true });
		});
		expect(() => readSnapshot(dataDir, 'app', snapshotId)).not.toThrow();
		expect(() => readSourceTexts(dataDir, 'app', snapshotId, 'main')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_OUTDATED' }));
	});

	it('an intact snapshot reads normally', () => {
		expect(read(cfg.dataDir)().chunks.length).toBeGreaterThan(0);
	});
});
