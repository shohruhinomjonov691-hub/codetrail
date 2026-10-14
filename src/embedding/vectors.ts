import { CodeTrailError, type ErrorCode } from '../errors.js';

/** Stored vectors are L2-normalized; anything else is treated as corrupt. */
export const UNIT_NORM_TOLERANCE = 1e-3;

/** Row `offset .. offset+dims` of a matrix is finite, non-zero and has unit L2 norm. */
export function isUnitRow(matrix: Float32Array, dims: number, offset: number): boolean {
	if (offset < 0 || matrix.length < offset + dims) return false;
	let sum = 0;
	for (let i = offset; i < offset + dims; i++) {
		const x = matrix[i] as number;
		if (!Number.isFinite(x)) return false;
		sum += x * x;
	}
	return sum > 0 && Math.abs(Math.sqrt(sum) - 1) <= UNIT_NORM_TOLERANCE;
}

/**
 * The single rule for every vector CodeTrail accepts (query, document, probe,
 * cache read/write, index publish/load): a Float32Array of EXACTLY `dims`
 * elements, all finite, non-zero, unit L2 norm.
 */
export function isExactUnitVector(v: unknown, dims: number): v is Float32Array {
	return v instanceof Float32Array && v.length === dims && isUnitRow(v, dims, 0);
}

export function assertExactUnitVector(v: unknown, dims: number, what: string, code: ErrorCode = 'PROVIDER_FAILED'): asserts v is Float32Array {
	if (!isExactUnitVector(v, dims)) {
		const shape = v instanceof Float32Array ? `Float32Array(${v.length})` : Array.isArray(v) ? `Array(${v.length})` : typeof v;
		throw new CodeTrailError(code, `${what} must be a finite, non-zero unit Float32Array of exactly ${dims} elements (got ${shape})`);
	}
}

/** Index of the first invalid row in a row-major matrix, or -1. */
export function firstInvalidRow(matrix: Float32Array, dims: number): number {
	if (matrix.length % dims !== 0) return 0;
	for (let row = 0; row * dims < matrix.length; row++) if (!isUnitRow(matrix, dims, row * dims)) return row;
	return -1;
}

export function cosine(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < b.length; i++) s += (a[i] as number) * (b[i] as number);
	return s;
}
