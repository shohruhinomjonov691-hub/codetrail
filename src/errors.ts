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
	| 'USAGE';

export class CodeTrailError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = 'CodeTrailError';
		this.code = code;
	}
}
