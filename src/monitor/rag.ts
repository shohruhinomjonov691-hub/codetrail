import type { EmbeddingRecipe } from '../embedding/recipe.js';
import { loadIndex, type LoadedIndex } from '../retrieval/index.js';
import { search } from '../retrieval/search.js';
import { listSnapshots } from '../snapshot.js';
import { samePath, type CodeHit, type RagSearch } from './rootcause.js';

/**
 * Keyword (BM25) search over a project's newest usable index, for root-cause evidence. It needs no
 * embedding server and no network: the question is the failure text, the corpus is the snapshot.
 * Indexes are opened on first use and closed by `close()`.
 */
export function keywordRag(dataDir: string, recipe: EmbeddingRecipe): { rag: RagSearch; close: () => void } {
	const open = new Map<string, LoadedIndex | null>();
	const indexFor = (projectId: string): LoadedIndex | null => {
		if (open.has(projectId)) return open.get(projectId) ?? null;
		let loaded: LoadedIndex | null = null;
		try {
			for (const snap of listSnapshots(dataDir, projectId).map((r) => r.snapshot_id).reverse()) {
				try {
					loaded = loadIndex(dataDir, projectId, snap, recipe);
					break;
				} catch {
					/* try the next older snapshot */
				}
			}
		} catch {
			loaded = null;
		}
		open.set(projectId, loaded);
		return loaded;
	};
	return {
		rag: async (projectId, query, files = []): Promise<CodeHit[] | null> => {
			const index = indexFor(projectId);
			if (!index) return null;
			const out: CodeHit[] = [];
			const seen = new Set<string>();
			const add = (h: CodeHit): void => {
				if (!seen.has(h.citation)) {
					seen.add(h.citation);
					out.push(h);
				}
			};
			// 1. the files the failure names: the chunk that holds the named line first, then the file's other chunks
			for (const f of files) {
				const chunks = index.chunks.filter((c) => samePath(f.path, c.path));
				const holds = (c: (typeof chunks)[number]): boolean => f.line !== undefined && c.start_line <= f.line && f.line <= c.end_line;
				chunks.sort((a, b) => Number(holds(b)) - Number(holds(a)) || a.start_line - b.start_line);
				for (const c of chunks.slice(0, 3)) add({ path: c.path, symbol: c.symbol, citation: `${c.source_id}@${c.commit.slice(0, 12)}:${c.path}:L${c.start_line}-${c.end_line}` });
			}
			// 2. keyword search for the failure's terms
			const q = query.trim();
			if (q) for (const h of await search(index, q.slice(0, 900), { mode: 'bm25', k: 5 })) add({ path: h.path, symbol: h.symbol, citation: h.citation });
			return out.slice(0, 10);
		},
		close: () => {
			for (const i of open.values()) i?.db.close();
			open.clear();
		},
	};
}
