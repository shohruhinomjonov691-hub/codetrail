import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkFile, CHUNK_LIMITS, CHUNKER_VERSION, LineIndex, languageOf, type ChunkKind, type Language } from './chunker/index.js';
import type { RuntimeConfig } from './config.js';
import { CodeTrailError } from './errors.js';
import { catFileBatch, runGit } from './git.js';
import { canonicalJson, hashParts, sha256Hex } from './hash.js';
import { assertId, assertSnapshotId, isFullSha } from './ids.js';
import { cloneToQuarantine, discardStaged, resolveCommit, sweepStaleStaging, type StagedSource } from './mirror.js';
import { LOCK_DEFAULTS, withLock } from './lock.js';
import { normalizeGithubUrl, resolveLocalSource } from './sources.js';
import { classifyContent, classifyPath, FILTER_LIMITS, filterConfigFingerprint, globToRegExp, type ExcludeReason } from './filters.js';
import { Registry, type ProjectRecord } from './registry.js';
import { scannerFingerprint, scanText, type Confidence } from './secrets.js';

/**
 * Schema 2 (2026-10-15): the exact bytes of every included file are stored in
 * `files/<sha256>` so consumers that need whole files (the identifier scan) never
 * rebuild them from chunks. Schema-1 snapshots have no stored files and are
 * refused by those consumers with SNAPSHOT_OUTDATED; the schema is part of the
 * config hash, so a rebuild gets a new snapshot id next to the old one.
 */
export const SNAPSHOT_SCHEMA = 2;

export interface ManifestFile {
	source_id: string;
	path: string;
	mode: string;
	blob: string;
	size: number | null;
	status: 'included' | 'excluded';
	reason: ExcludeReason | null;
	sha256: string | null;
	language: Language | null;
	chunks: number;
}

export interface ManifestSource {
	source_id: string;
	kind: string;
	location: string;
	commit: string;
}

export interface Manifest {
	schema: number;
	project_id: string;
	snapshot_id: string;
	config_hash: string;
	sources: ManifestSource[];
	files: ManifestFile[];
}

export interface ChunkRecord {
	id: string;
	project_id: string;
	snapshot_id: string;
	source_id: string;
	commit: string;
	path: string;
	language: Language;
	kind: ChunkKind;
	symbol: string | null;
	part: { index: number; total: number } | null;
	start_line: number;
	end_line: number;
	text_sha256: string;
	text: string;
}

export interface SecretFindingRecord {
	source_id: string;
	path: string;
	detector: string;
	confidence: Confidence;
	count: number;
}

export interface SnapshotReport {
	schema: number;
	project_id: string;
	snapshot_id: string;
	status: 'ready' | 'blocked';
	created_at: string;
	sources: (ManifestSource & { ref: string })[];
	counts: {
		files_total: number;
		files_included: number;
		files_excluded: Record<string, number>;
		chunks: number;
		max_chunk_lines: number;
		max_chunk_chars: number;
	};
	secret_findings: SecretFindingRecord[];
}

export interface SnapshotResult {
	status: 'created' | 'exists' | 'blocked';
	report: SnapshotReport;
	dir: string;
}

export function snapshotsRoot(dataDir: string, projectId: string): string {
	return join(dataDir, 'snapshots', projectId);
}

export function configHash(project: ProjectRecord): string {
	return sha256Hex(
		canonicalJson({
			snapshot: SNAPSHOT_SCHEMA,
			filters: filterConfigFingerprint(),
			scanner: scannerFingerprint(),
			chunker: { version: CHUNKER_VERSION, limits: CHUNK_LIMITS },
			exclude: [...project.exclude].sort(),
		}),
	);
}

interface TreeEntry {
	mode: string;
	type: string;
	oid: string;
	size: number | null;
	path: string;
}

async function listTree(gitDir: string, commit: string): Promise<TreeEntry[]> {
	const out = await runGit(['ls-tree', '-r', '-z', '-l', '--full-tree', commit], { gitDir });
	const entries: TreeEntry[] = [];
	for (const record of out.toString('utf8').split('\u0000')) {
		if (!record) continue;
		const tab = record.indexOf('\t');
		const [mode, type, oid, size] = record.slice(0, tab).split(/\s+/);
		entries.push({
			mode: mode as string,
			type: type as string,
			oid: oid as string,
			size: size && size !== '-' ? Number(size) : null,
			path: record.slice(tab + 1),
		});
	}
	return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function resolveSourceCommit(gitDir: string, ref: string): Promise<string> {
	try {
		return await resolveCommit(gitDir, ref);
	} catch (err) {
		// An exact SHA that is not on any branch head: fetch just that commit.
		if (!isFullSha(ref)) throw err;
		await runGit(['fetch', '--quiet', '--no-tags', 'origin', ref], { gitDir }).catch(() => undefined);
		return resolveCommit(gitDir, ref);
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
	renameSync(tmp, path);
}

/**
 * Creates an immutable snapshot for a project: every source pinned to an exact
 * commit, read from a quarantined bare clone (never a working tree), filtered,
 * secret scanned and chunked. Nothing is written for a blocked snapshot except a
 * report with paths, detector names and counts. Runs under a per-project
 * cross-process lock; quarantined clones are always deleted afterwards.
 */
export async function createSnapshot(
	config: RuntimeConfig,
	projectId: string,
	refs: Record<string, string> = {},
	now: () => Date = () => new Date(),
): Promise<SnapshotResult> {
	assertId('project', projectId);
	return withLock(join(config.dataDir, 'locks'), `snapshot-${projectId}`, LOCK_DEFAULTS.snapshot, async () => {
		// Crash recovery first: it touches only our own staging dirs of dead pids and
		// must not depend on the sources still being valid.
		sweepStaleStaging(config.dataDir, projectId);
		const project = new Registry(config.dataDir).getProject(projectId);
		if (project.sources.length === 0) throw new CodeTrailError('USAGE', 'Project has no sources');
		for (const sourceId of Object.keys(refs)) {
			if (!project.sources.some((s) => s.id === sourceId)) throw new CodeTrailError('UNKNOWN_SOURCE', `Unknown source: ${sourceId}`);
		}
		// Re-validate every source against the current configuration before reading anything.
		const locations = project.sources.map((source) => {
			const current = source.kind === 'local' ? resolveLocalSource(source.location, config.localRoots) : normalizeGithubUrl(source.location);
			if (current !== source.location) throw new CodeTrailError('UNSAFE_SOURCE', `Source ${source.id} no longer resolves to its registered location`);
			return current;
		});
		const staged: StagedSource[] = [];
		try {
			const resolved: Resolved[] = [];
			for (const [i, source] of project.sources.entries()) {
				const clone = await cloneToQuarantine(config.dataDir, projectId, source.id, locations[i] as string, source.kind === 'local');
				staged.push(clone);
				const ref = refs[source.id] ?? source.defaultRef;
				resolved.push({ source, gitDir: clone.gitDir, ref, commit: await resolveSourceCommit(clone.gitDir, ref) });
			}
			return await buildSnapshot(config, project, resolved, now);
		} finally {
			discardStaged(staged);
		}
	});
}

interface Resolved {
	source: ProjectRecord['sources'][number];
	gitDir: string;
	ref: string;
	commit: string;
}

async function buildSnapshot(config: RuntimeConfig, project: ProjectRecord, resolved: Resolved[], now: () => Date): Promise<SnapshotResult> {
	const projectId = project.id;
	const cfgHash = configHash(project);
	const snapshotId = hashParts([projectId, ...resolved.map((r) => `${r.source.id}@${r.commit}`), cfgHash]).slice(0, 24);
	const root = snapshotsRoot(config.dataDir, projectId);
	const dir = join(root, snapshotId);
	if (existsSync(join(dir, 'manifest.json'))) {
		return { status: 'exists', dir, report: JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as SnapshotReport };
	}

	const excludes = project.exclude.map(globToRegExp);
	const files: ManifestFile[] = [];
	const chunks: ChunkRecord[] = [];
	const findings: SecretFindingRecord[] = [];
	// Included files only: they passed the content filters and the secret scan.
	const stored = new Map<string, Buffer>();
	let blocked = false;

	for (const { source, gitDir, commit } of resolved) {
		const entries = await listTree(gitDir, commit);
		const candidates: TreeEntry[] = [];
		const record = (entry: TreeEntry, reason: ExcludeReason): void => {
			files.push({
				source_id: source.id,
				path: entry.path,
				mode: entry.mode,
				blob: entry.oid,
				size: entry.size,
				status: 'excluded',
				reason,
				sha256: null,
				language: null,
				chunks: 0,
			});
		};
		for (const entry of entries) {
			if (entry.mode === '120000') record(entry, 'symlink');
			else if (entry.mode === '160000' || entry.type === 'commit') record(entry, 'submodule');
			else {
				const reason = classifyPath(entry.path, excludes);
				if (reason) record(entry, reason);
				else if ((entry.size ?? 0) > FILTER_LIMITS.maxFileBytes) record(entry, 'too-large');
				else if (candidates.length >= FILTER_LIMITS.maxFilesPerSource) record(entry, 'file-limit');
				else candidates.push(entry);
			}
		}

		const blobs = await catFileBatch(gitDir, [...new Set(candidates.map((c) => c.oid))]);
		for (const entry of candidates) {
			const bytes = blobs.get(entry.oid) as Buffer;
			const content = classifyContent(bytes);
			if ('reason' in content) {
				record(entry, content.reason);
				continue;
			}
			const hits = scanText(content.text);
			if (hits.length > 0) {
				for (const hit of hits) findings.push({ source_id: source.id, path: entry.path, ...hit });
				if (hits.some((h) => h.confidence === 'high')) blocked = true;
				record(entry, 'secret-suspected');
				continue;
			}
			const language = languageOf(entry.path) as Language;
			const idx = new LineIndex(content.text);
			const raw = chunkFile(entry.path, content.text);
			for (const c of raw) {
				const text = idx.slice(c.startLine, c.endLine);
				if (c.endLine - c.startLine + 1 > CHUNK_LIMITS.maxLines || text.length > CHUNK_LIMITS.maxChars) {
					throw new Error(`chunk limit violated in ${source.id}:${entry.path}:${c.startLine}`);
				}
				chunks.push({
					id: hashParts([projectId, source.id, commit, entry.path, c.startLine, c.endLine]).slice(0, 32),
					project_id: projectId,
					snapshot_id: snapshotId,
					source_id: source.id,
					commit,
					path: entry.path,
					language,
					kind: c.kind,
					symbol: c.symbol,
					part: c.part,
					start_line: c.startLine,
					end_line: c.endLine,
					text_sha256: sha256Hex(text),
					text,
				});
			}
			const fileSha = sha256Hex(bytes);
			stored.set(fileSha, bytes);
			files.push({
				source_id: source.id,
				path: entry.path,
				mode: entry.mode,
				blob: entry.oid,
				size: entry.size,
				status: 'included',
				reason: null,
				sha256: fileSha,
				language,
				chunks: raw.length,
			});
		}
	}

	const byKey = (a: { source_id: string; path: string }, b: { source_id: string; path: string }): number =>
		a.source_id === b.source_id ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.source_id < b.source_id ? -1 : 1;
	files.sort(byKey);
	findings.sort((a, b) => byKey(a, b) || (a.detector < b.detector ? -1 : 1));
	chunks.sort((a, b) => byKey(a, b) || a.start_line - b.start_line);

	const excluded: Record<string, number> = {};
	for (const f of files) if (f.reason) excluded[f.reason] = (excluded[f.reason] ?? 0) + 1;
	const report: SnapshotReport = {
		schema: SNAPSHOT_SCHEMA,
		project_id: projectId,
		snapshot_id: snapshotId,
		status: blocked ? 'blocked' : 'ready',
		created_at: now().toISOString(),
		sources: resolved.map((r) => ({ source_id: r.source.id, kind: r.source.kind, location: r.source.location, commit: r.commit, ref: r.ref })),
		counts: {
			files_total: files.length,
			files_included: files.filter((f) => f.status === 'included').length,
			files_excluded: Object.fromEntries(Object.entries(excluded).sort()),
			chunks: blocked ? 0 : chunks.length,
			max_chunk_lines: blocked ? 0 : Math.max(0, ...chunks.map((c) => c.end_line - c.start_line + 1)),
			max_chunk_chars: blocked ? 0 : Math.max(0, ...chunks.map((c) => c.text.length)),
		},
		secret_findings: findings,
	};

	mkdirSync(root, { recursive: true });
	if (blocked) {
		const blockedDir = join(root, 'blocked');
		mkdirSync(blockedDir, { recursive: true });
		writeJsonAtomic(join(blockedDir, `${snapshotId}.json`), report);
		return { status: 'blocked', dir: blockedDir, report };
	}

	const manifest: Manifest = {
		schema: SNAPSHOT_SCHEMA,
		project_id: projectId,
		snapshot_id: snapshotId,
		config_hash: cfgHash,
		sources: report.sources.map(({ ref: _ref, ...s }) => s),
		files,
	};
	const tmp = join(root, `.tmp-${snapshotId}-${process.pid}`);
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp);
	mkdirSync(join(tmp, 'files'));
	for (const [fileSha, bytes] of stored) writeFileSync(join(tmp, 'files', fileSha), bytes);
	writeFileSync(join(tmp, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + (chunks.length ? '\n' : ''));
	writeFileSync(join(tmp, 'report.json'), JSON.stringify(report, null, 2) + '\n');
	writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
	try {
		renameSync(tmp, dir);
	} catch {
		rmSync(tmp, { recursive: true, force: true });
		if (existsSync(join(dir, 'manifest.json'))) {
			return { status: 'exists', dir, report: JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as SnapshotReport };
		}
		throw new Error('could not finalize snapshot directory');
	}
	return { status: 'created', dir, report };
}

export function listSnapshots(dataDir: string, projectId: string): SnapshotReport[] {
	assertId('project', projectId);
	const root = snapshotsRoot(dataDir, projectId);
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((name) => /^[0-9a-f]{24}$/.test(name) && existsSync(join(root, name, 'manifest.json')))
		.map((name) => JSON.parse(readFileSync(join(root, name, 'report.json'), 'utf8')) as SnapshotReport)
		.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Reads a snapshot's metadata. A snapshot directory that does not exist is
 * UNKNOWN_SNAPSHOT; an existing one whose manifest, report or chunks are missing,
 * unparsable or of the wrong shape (or that names another project/snapshot) is
 * SNAPSHOT_CORRUPT. Schema-specific checks (SNAPSHOT_OUTDATED) are left to readers.
 */
export function readSnapshot(dataDir: string, projectId: string, snapshotId: string): { manifest: Manifest; report: SnapshotReport; chunks: ChunkRecord[] } {
	assertId('project', projectId);
	assertSnapshotId(snapshotId);
	const dir = join(snapshotsRoot(dataDir, projectId), snapshotId);
	if (!existsSync(dir)) throw new CodeTrailError('UNKNOWN_SNAPSHOT', `Unknown snapshot: ${snapshotId}`);
	const corrupt = (detail: string): CodeTrailError => new CodeTrailError('SNAPSHOT_CORRUPT', `snapshot ${snapshotId}: ${detail}; rebuild it with: codetrail snapshot create ${projectId}`);
	const read = (name: string): string => {
		try {
			return readFileSync(join(dir, name), 'utf8');
		} catch {
			throw corrupt(`${name} is missing or unreadable`);
		}
	};
	const parse = (name: string, text: string): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			throw corrupt(`${name} is not valid JSON`);
		}
	};
	const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
	const manifest = parse('manifest.json', read('manifest.json'));
	if (!isObject(manifest) || !Number.isInteger(manifest.schema) || !Array.isArray(manifest.sources) || !Array.isArray(manifest.files) || !manifest.files.every(isObject)) {
		throw corrupt('manifest.json has an unexpected shape');
	}
	if (manifest.project_id !== projectId || manifest.snapshot_id !== snapshotId) throw corrupt('manifest.json belongs to another project or snapshot');
	const report = parse('report.json', read('report.json'));
	if (!isObject(report) || report.snapshot_id !== snapshotId) throw corrupt('report.json has an unexpected shape');
	const chunks = read('chunks.jsonl')
		.split('\n')
		.filter(Boolean)
		.map((line, i) => {
			const c = parse(`chunks.jsonl line ${i + 1}`, line);
			if (!isObject(c) || typeof c.text !== 'string' || typeof c.path !== 'string') throw corrupt(`chunks.jsonl line ${i + 1} has an unexpected shape`);
			return c as unknown as ChunkRecord;
		});
	return { manifest: manifest as unknown as Manifest, report: report as unknown as SnapshotReport, chunks };
}

export interface SourceFileText {
	path: string;
	text: string;
}

/**
 * The full text of every included file of one source, read from the snapshot's
 * own `files/` store (the exact committed bytes, stored after the content filters
 * and the secret scan — no git access, nothing re-filtered). Fails closed:
 * - a schema-1 snapshot (no stored files) → SNAPSHOT_OUTDATED with the rebuild command;
 * - a manifest of another project/snapshot, an unknown source, a missing or
 *   unreadable file, a SHA-256 that differs from the manifest, or chunks that
 *   disagree with the file (commit, snapshot, text or count) → SNAPSHOT_CORRUPT.
 */
export function readSourceTexts(dataDir: string, projectId: string, snapshotId: string, sourceId: string): SourceFileText[] {
	const { manifest, chunks } = readSnapshot(dataDir, projectId, snapshotId);
	const dir = join(snapshotsRoot(dataDir, projectId), snapshotId);
	const where = `snapshot ${snapshotId}`;
	if (manifest.schema !== SNAPSHOT_SCHEMA) {
		throw new CodeTrailError(
			'SNAPSHOT_OUTDATED',
			`${where} has schema ${manifest.schema} without stored source files (need ${SNAPSHOT_SCHEMA}); rebuild it with: codetrail snapshot create ${projectId}`,
		);
	}
	const corrupt = (detail: string): CodeTrailError => new CodeTrailError('SNAPSHOT_CORRUPT', `${where}: ${detail}`);
	const source = manifest.sources.find((s) => s.source_id === sourceId);
	if (!source) throw new CodeTrailError('UNKNOWN_SOURCE', `Unknown source in ${where}: ${sourceId}`);
	if (!isFullSha(source.commit)) throw corrupt(`source ${sourceId} has no exact commit`);
	const chunksByPath = new Map<string, ChunkRecord[]>();
	for (const c of chunks) {
		if (c.source_id !== sourceId) continue;
		const list = chunksByPath.get(c.path) ?? [];
		list.push(c);
		chunksByPath.set(c.path, list);
	}
	const out: SourceFileText[] = [];
	for (const f of manifest.files) {
		if (f.source_id !== sourceId || f.status !== 'included') continue;
		const label = `${sourceId}:${f.path}`;
		if (!f.sha256 || !/^[0-9a-f]{64}$/.test(f.sha256)) throw corrupt(`${label} has no checksum`);
		let bytes: Buffer;
		try {
			bytes = readFileSync(join(dir, 'files', f.sha256));
		} catch {
			throw corrupt(`stored text of ${label} is missing; rebuild the snapshot`);
		}
		if (sha256Hex(bytes) !== f.sha256) throw corrupt(`stored text of ${label} does not match its checksum`);
		const content = classifyContent(bytes);
		if (!('text' in content)) throw corrupt(`stored text of ${label} is not an included text file`);
		const idx = new LineIndex(content.text);
		const own = chunksByPath.get(f.path) ?? [];
		chunksByPath.delete(f.path);
		if (own.length !== f.chunks) throw corrupt(`${label} has ${own.length} chunks, manifest says ${f.chunks}`);
		for (const c of own) {
			if (c.commit !== source.commit || c.snapshot_id !== snapshotId || c.project_id !== projectId) throw corrupt(`chunk of ${label} belongs to another commit or snapshot`);
			if (c.start_line < 1 || c.end_line > idx.count || idx.slice(c.start_line, c.end_line) !== c.text) throw corrupt(`chunk ${label}:${c.start_line} differs from the stored file`);
		}
		out.push({ path: f.path, text: content.text });
	}
	if (chunksByPath.size > 0) throw corrupt(`chunks for files that are not included: ${[...chunksByPath.keys()].slice(0, 3).join(', ')}`);
	return out;
}
