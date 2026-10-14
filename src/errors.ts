/**
 * Every rejection CodeTrail makes on purpose carries a stable code so the CLI,
 * tests and (later) the API can react without parsing human-readable text.
 * Messages must never contain file contents or secret values.
 */
export type ErrorCode =
	| 'INVALID_ID'
	| 'INVALID_GITHUB_URL'
	| 'INVALID_LOCAL_PATH'
	| 'LOCAL_PATH_OUTSIDE_ROOTS'
	| 'NOT_A_GIT_REPO'
	| 'UNKNOWN_PROJECT'
	| 'UNKNOWN_SOURCE'
	| 'DUPLICATE'
	| 'INVALID_REF'
	| 'GIT_FAILED'
	| 'SNAPSHOT_BLOCKED'
	| 'UNKNOWN_SNAPSHOT'
	| 'SNAPSHOT_OUTDATED'
	| 'SNAPSHOT_CORRUPT'
	| 'LOCK_TIMEOUT'
	| 'UNSAFE_SOURCE'
	| 'PROVIDER_URL_REJECTED'
	| 'PROVIDER_FAILED'
	| 'MODEL_MISMATCH'
	| 'TOKEN_LIMIT'
	| 'INDEX_CORRUPT'
	| 'UNKNOWN_INDEX'
	| 'INDEX_OUTDATED'
	| 'CACHE_FAILED'
	| 'INVALID_QUERY'
	| 'USAGE';

export class CodeTrailError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'CodeTrailError';
		this.code = code;
	}
}
