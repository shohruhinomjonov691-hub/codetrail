import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Hash of NUL-joined parts, so ("ab","c") and ("a","bc") never collide. */
export function hashParts(parts: readonly (string | number)[]): string {
	return sha256Hex(parts.map(String).join('\u0000'));
}

/** JSON with object keys sorted recursively — stable input for config hashes. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortKeys((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}
