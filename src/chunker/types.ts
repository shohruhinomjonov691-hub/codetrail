export const CHUNKER_VERSION = 4;

/** Hard limits every emitted chunk respects. */
export const CHUNK_LIMITS = {
	maxLines: 120,
	maxChars: 6000,
	/** Declarations shorter than this may be packed together with neighbours. */
	minStandaloneLines: 6,
} as const;

export type ChunkKind =
	| 'function'
	| 'class'
	| 'method'
	| 'type'
	| 'enum'
	| 'variable'
	| 'namespace'
	| 'module'
	| 'markdown-section'
	| 'config'
	| 'schema'
	| 'text';

export type Language = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'json' | 'markdown' | 'yaml' | 'graphql';

/** A chunk before ids/metadata are attached: just a line range and labels. */
export interface RawChunk {
	kind: ChunkKind;
	symbol: string | null;
	startLine: number;
	endLine: number;
	part: { index: number; total: number } | null;
}
