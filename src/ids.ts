import { CodeTrailError } from './errors.js';

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** project_id / source_id: lowercase slug, 1–40 chars, used in file paths. */
export function assertId(kind: 'project' | 'source', value: string): string {
	if (!ID_PATTERN.test(value)) {
		throw new CodeTrailError('INVALID_ID', `Invalid ${kind} id: must match ${ID_PATTERN.source}`);
	}
	return value;
}

export function isFullSha(value: string): boolean {
	return SHA_PATTERN.test(value);
}

/** snapshot ids are hex digests produced by CodeTrail itself. */
export function assertSnapshotId(value: string): string {
	if (!/^[0-9a-f]{24}$/.test(value)) {
		throw new CodeTrailError('INVALID_ID', 'Invalid snapshot id');
	}
	return value;
}
