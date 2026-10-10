import { chunkStructured, chunkMarkdown } from './text.js';
import { chunkTypeScript } from './typescript.js';
import type { Language, RawChunk } from './types.js';

export { CHUNK_LIMITS, CHUNKER_VERSION } from './types.js';
export type { ChunkKind, Language, RawChunk } from './types.js';
export { LineIndex } from './lines.js';

export function languageOf(path: string): Language | null {
	const lower = path.toLowerCase();
	if (/\.(ts|mts|cts)$/.test(lower)) return 'typescript';
	if (lower.endsWith('.tsx')) return 'tsx';
	if (/\.(js|mjs|cjs)$/.test(lower)) return 'javascript';
	if (lower.endsWith('.jsx')) return 'jsx';
	if (lower.endsWith('.json')) return 'json';
	if (/\.(md|mdx)$/.test(lower)) return 'markdown';
	if (/\.(yml|yaml)$/.test(lower)) return 'yaml';
	if (/\.(graphql|gql)$/.test(lower)) return 'graphql';
	return null;
}

/** Chunks one file. Empty / whitespace-only files yield no chunks. */
export function chunkFile(path: string, text: string): RawChunk[] {
	if (text.trim().length === 0) return [];
	const language = languageOf(path);
	switch (language) {
		case 'typescript':
		case 'tsx':
		case 'javascript':
		case 'jsx':
			return chunkTypeScript(path, text);
		case 'markdown':
			return chunkMarkdown(text);
		case 'graphql':
			return chunkStructured(text, 'schema');
		case 'json':
		case 'yaml':
			return chunkStructured(text, 'config');
		default:
			return chunkStructured(text, 'text');
	}
}
