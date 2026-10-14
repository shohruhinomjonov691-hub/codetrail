/** Stored vectors are L2-normalized; anything else is treated as corrupt. */
export const UNIT_NORM_TOLERANCE = 1e-3;

/** True when `v[offset .. offset+dims)` is finite and has unit L2 norm. */
export function isUnitVector(v: Float32Array, dims: number, offset = 0): boolean {
	if (v.length < offset + dims) return false;
	let sum = 0;
	for (let i = offset; i < offset + dims; i++) {
		const x = v[i] as number;
		if (!Number.isFinite(x)) return false;
		sum += x * x;
	}
	return Math.abs(Math.sqrt(sum) - 1) <= UNIT_NORM_TOLERANCE;
}

/** Index of the first invalid row in a row-major matrix, or -1. */
export function firstInvalidRow(matrix: Float32Array, dims: number): number {
	if (matrix.length % dims !== 0) return 0;
	for (let row = 0; row * dims < matrix.length; row++) if (!isUnitVector(matrix, dims, row * dims)) return row;
	return -1;
}

export function cosine(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < b.length; i++) s += (a[i] as number) * (b[i] as number);
	return s;
}
