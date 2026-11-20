#!/usr/bin/env node
// Exports the minimum data a pinned public server needs: the registry entries and snapshots of the
// pinned projects — nothing else (no other projects, no caches, no quarantine). Run after `npm run build`.
//
// The index is NOT copied by default: its fingerprint probe must come from the same embedding
// runtime platform that serves queries (a Mac/Metal-built index fails the 0.9999 probe check against
// a Linux CPU server). Build it on the target with `docker compose --profile index run --rm codetrail-index`.
// `--with-index` copies the local index too (only for serving on the same platform it was built on).
// Usage: node scripts/export-serve-data.mjs <out_dir> <project:snapshot>... [--with-index]
//   (the pins are the same "project:snapshot" pairs as CODETRAIL_PUBLIC_PIN, up to 12)
//   node scripts/export-serve-data.mjs <project_id> <snapshot_id> <out_dir> [--with-index]   (one project, older form)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { embeddingSettings } from '../dist/embedding/config.js';
import { assertId, assertSnapshotId } from '../dist/ids.js';
import { indexId, loadIndex } from '../dist/retrieval/index.js';
import { readSnapshot } from '../dist/snapshot.js';

const args = process.argv.slice(2);
const withIndex = args.includes('--with-index');
const pos = args.filter((a) => a !== '--with-index');
let outArg;
let pins;
if (pos.length === 3 && !pos[1].includes(':')) {
	pins = [{ projectId: pos[0], snapshotId: pos[1] }];
	outArg = pos[2];
} else {
	outArg = pos[0];
	pins = pos.slice(1).map((p) => {
		const at = p.indexOf(':');
		return { projectId: at < 0 ? '' : p.slice(0, at), snapshotId: at < 0 ? '' : p.slice(at + 1) };
	});
}
if (!outArg || pins.length === 0 || pins.length > 12) {
	console.error('usage: node scripts/export-serve-data.mjs <out_dir> <project:snapshot>... [--with-index]   (1-12 pins)');
	process.exit(64);
}
for (const { projectId, snapshotId } of pins) {
	assertId('project', projectId);
	assertSnapshotId(snapshotId);
}
if (new Set(pins.map((p) => p.projectId)).size !== pins.length) {
	console.error('a project is listed twice');
	process.exit(64);
}
const src = resolve(process.env.CODETRAIL_DATA_DIR || 'data');
const out = resolve(outArg);
if (existsSync(out) && readdirSync(out).length > 0) {
	console.error(`refusing to write into non-empty ${out}`);
	process.exit(1);
}
const recipe = embeddingSettings().recipe;
const registry = JSON.parse(readFileSync(join(src, 'registry.json'), 'utf8'));
// Validate every pin before anything is written.
const entries = pins.map(({ projectId, snapshotId }) => {
	readSnapshot(src, projectId, snapshotId); // fails clearly on a missing/corrupt snapshot
	const project = registry.projects.find((p) => p.id === projectId);
	if (!project) throw new Error(`project ${projectId} not in registry`);
	return { projectId, snapshotId, project };
});
mkdirSync(out, { recursive: true });
// Source locations are local paths of the operator's machine; the server never reads them.
writeFileSync(
	join(out, 'registry.json'),
	JSON.stringify({ schema: registry.schema, projects: entries.map((e) => ({ ...e.project, sources: e.project.sources.map((s) => ({ ...s, location: `exported:${s.id}` })) })) }, null, 2) + '\n',
);
const report = [];
for (const { projectId, snapshotId } of entries) {
	cpSync(join(src, 'snapshots', projectId, snapshotId), join(out, 'snapshots', projectId, snapshotId), { recursive: true });
	const copied = readSnapshot(out, projectId, snapshotId); // the copy reads back cleanly
	let index = null;
	if (withIndex) {
		const id = indexId(projectId, snapshotId, recipe);
		cpSync(join(src, 'indexes', projectId, snapshotId, id), join(out, 'indexes', projectId, snapshotId, id), { recursive: true });
		const loaded = loadIndex(out, projectId, snapshotId, recipe); // verifies hashes against the copied snapshot
		index = { id: loaded.meta.index_id, runtime: loaded.meta.identity.runtime };
		loaded.db.close();
	}
	report.push({ project: projectId, snapshot: snapshotId, chunks: copied.chunks.length, index: index ?? 'not copied — build it on the target' });
}
console.log(JSON.stringify({ out, projects: report }));
