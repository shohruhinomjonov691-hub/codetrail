/**
 * node:sqlite (built into Node ≥ 22.13, FTS5 included) — no native dependency.
 * It still emits an ExperimentalWarning on load; only that warning is filtered
 * so CLI output stays clean. Everything else passes through unchanged.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
	const text = typeof warning === 'string' ? warning : warning.message;
	if (/SQLite is an experimental feature/i.test(text)) return;
	return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const sqlite = await import('node:sqlite');
export const DatabaseSync = sqlite.DatabaseSync;
export type Database = InstanceType<typeof sqlite.DatabaseSync>;
