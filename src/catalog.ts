import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServedProject } from './answer/service.js';
import { Registry } from './registry.js';

/** The six live projects a user can pick. Ids are stable (used in paths, the API and caches). */
export const PROJECT_CATALOG: readonly { id: string; name: string }[] = [
	{ id: 'gotrip', name: 'GoTrip' },
	{ id: 'kervan', name: 'Kervan' },
	{ id: 'camera-studio', name: 'Camera Studio' },
	{ id: 'codetrail', name: 'CodeTrail' },
	{ id: 'findit', name: 'FindIt' },
	{ id: 'food-lens', name: 'Food Lens' },
];

export type IndexState = 'ready' | 'indexing' | 'error';

/** What `codetrail index` records about a project's index build (no paths, no secrets). */
export interface IndexStatusFile {
	state: 'indexing' | 'ready' | 'error';
	snapshot_id: string;
	pid: number;
	started_at: string;
	finished_at: string | null;
	/** Stable error code only (never a message that could hold paths or content). */
	error_code: string | null;
}

export interface ProjectStatus {
	project_id: string;
	name: string;
	state: IndexState;
	/** Why the state is not `ready` (stable code): NOT_CONFIGURED, NOT_INDEXED, NOT_SERVED, an error code, or null. */
	reason: string | null;
	snapshot_id: string | null;
	chunks: number | null;
	sources: { source_id: string; commit: string }[];
}

export function statusFile(dataDir: string, projectId: string): string {
	return join(dataDir, 'status', `${projectId}.json`);
}

export function writeIndexStatus(dataDir: string, projectId: string, status: IndexStatusFile): void {
	const file = statusFile(dataDir, projectId);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(status) + '\n');
	renameSync(tmp, file);
}

export function readIndexStatus(dataDir: string, projectId: string): IndexStatusFile | null {
	try {
		const v = JSON.parse(readFileSync(statusFile(dataDir, projectId), 'utf8')) as Partial<IndexStatusFile>;
		if ((v.state === 'indexing' || v.state === 'ready' || v.state === 'error') && typeof v.pid === 'number' && typeof v.snapshot_id === 'string') return v as IndexStatusFile;
	} catch {
		/* missing or unreadable: no status */
	}
	return null;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * State of each catalog project (plus any other served project):
 * - ready: this server loaded a verified index for it;
 * - indexing: an index build is running (its status file names a live pid);
 * - error: not configured (no sources registered), not indexed, not served by this
 *   server, or the last index build failed (`reason` says which).
 */
export function projectStatuses(dataDir: string, served: readonly ServedProject[], opts: { only?: readonly string[]; skipped?: readonly { project_id: string; reason: string }[] } = {}): ProjectStatus[] {
	const servedBy = new Map(served.map((p) => [p.project_id, p]));
	const skippedBy = new Map((opts.skipped ?? []).map((s) => [s.project_id, s.reason]));
	let registered: Map<string, number>;
	try {
		registered = new Map(new Registry(dataDir).listProjects().map((p) => [p.id, p.sources.length]));
	} catch {
		registered = new Map();
	}
	const rows: { id: string; name: string }[] = [...PROJECT_CATALOG];
	for (const p of served) if (!rows.some((r) => r.id === p.project_id)) rows.push({ id: p.project_id, name: p.name });
	return rows
		.filter((r) => !opts.only || opts.only.includes(r.id))
		.map((r): ProjectStatus => {
			const s = servedBy.get(r.id);
			if (s) return { project_id: r.id, name: s.name, state: 'ready', reason: null, snapshot_id: s.snapshot_id, chunks: s.chunks, sources: s.sources };
			const base = { project_id: r.id, name: r.name, snapshot_id: null, chunks: null, sources: [] };
			const skipped = skippedBy.get(r.id);
			if (skipped) return { ...base, state: 'error', reason: skipped };
			const st = existsSync(statusFile(dataDir, r.id)) ? readIndexStatus(dataDir, r.id) : null;
			if (st?.state === 'indexing' && alive(st.pid)) return { ...base, state: 'indexing', reason: null, snapshot_id: st.snapshot_id };
			if (st?.state === 'error') return { ...base, state: 'error', reason: st.error_code ?? 'INDEX_FAILED', snapshot_id: st.snapshot_id };
			if (st?.state === 'indexing') return { ...base, state: 'error', reason: 'INDEX_INTERRUPTED', snapshot_id: st.snapshot_id };
			if (!registered.get(r.id)) return { ...base, state: 'error', reason: 'NOT_CONFIGURED' };
			return { ...base, state: 'error', reason: st?.state === 'ready' ? 'NOT_SERVED' : 'NOT_INDEXED', snapshot_id: st?.snapshot_id ?? null };
		});
}
