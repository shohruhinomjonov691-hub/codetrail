#!/usr/bin/env node
// Exports the minimum data a pinned public server needs: one registry entry and one snapshot —
// nothing else (no other projects, no caches, no quarantine). Run after `npm run build`.
//
// The index is NOT copied by default: its fingerprint probe must come from the same embedding
// runtime platform that serves queries (a Mac/Metal-built index fails the 0.9999 probe check against
// a Linux CPU server). Build it on the target with `docker compose --profile index run --rm codetrail-index`.
// `--with-index` copies the local index too (only for serving on the same platform it was built on).
// Usage: node scripts/export-serve-data.mjs <project_id> <snapshot_id> <out_dir> [--with-index]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { embeddingSettings } from '../dist/embedding/config.js';
import { assertId, assertSnapshotId } from '../dist/ids.js';
import { indexId, loadIndex } from '../dist/retrieval/index.js';
import { readSnapshot } from '../dist/snapshot.js';

const args = process.argv.slice(2);
const withIndex = args.includes('--with-index');
const [projectId, snapshotId, outArg] = args.filter((a) => a !== '--with-index');
if (!projectId || !snapshotId || !outArg) {
	console.error('usage: node scripts/export-serve-data.mjs <project_id> <snapshot_id> <out_dir>');
	process.exit(64);
}
assertId('project', projectId);
assertSnapshotId(snapshotId);
const src = resolve(process.env.CODETRAIL_DATA_DIR || 'data');
const out = resolve(outArg);
if (existsSync(out) && readdirSync(out).length > 0) {
	console.error(`refusing to write into non-empty ${out}`);
	process.exit(1);
}
const recipe = embeddingSettings().recipe;
const id = indexId(projectId, snapshotId, recipe);
readSnapshot(src, projectId, snapshotId); // fails clearly on a missing/corrupt snapshot
const registry = JSON.parse(readFileSync(join(src, 'registry.json'), 'utf8'));
const project = registry.projects.find((p) => p.id === projectId);
if (!project) throw new Error(`project ${projectId} not in registry`);
mkdirSync(out, { recursive: true });
// Source locations are local paths of the operator's machine; the server never reads them.
writeFileSync(join(out, 'registry.json'), JSON.stringify({ schema: registry.schema, projects: [{ ...project, sources: project.sources.map((s) => ({ ...s, location: `exported:${s.id}` })) }] }, null, 2) + '\n');
cpSync(join(src, 'snapshots', projectId, snapshotId), join(out, 'snapshots', projectId, snapshotId), { recursive: true });
const copied = readSnapshot(out, projectId, snapshotId); // the copy reads back cleanly
let index = null;
if (withIndex) {
	cpSync(join(src, 'indexes', projectId, snapshotId, id), join(out, 'indexes', projectId, snapshotId, id), { recursive: true });
	const loaded = loadIndex(out, projectId, snapshotId, recipe); // verifies hashes against the copied snapshot
	index = { id: loaded.meta.index_id, runtime: loaded.meta.identity.runtime };
	loaded.db.close();
}
console.log(JSON.stringify({ out, project: projectId, snapshot: snapshotId, chunks: copied.chunks.length, index: index ?? 'not copied — build it on the target' }));
