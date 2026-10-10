import { isAbsolute, resolve } from 'node:path';

export interface RuntimeConfig {
	/** Root for registry, locks, quarantined clones and snapshot artifacts. */
	dataDir: string;
	/** Absolute directories a local source must resolve inside. Empty = local sources disabled. */
	localRoots: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RuntimeConfig {
	const dataDir = env.CODETRAIL_DATA_DIR?.trim() ? resolve(cwd, env.CODETRAIL_DATA_DIR.trim()) : resolve(cwd, 'data');
	const localRoots = (env.CODETRAIL_LOCAL_ROOTS ?? '')
		.split(':')
		.map((root) => root.trim())
		.filter((root) => root.length > 0 && isAbsolute(root));
	return { dataDir, localRoots };
}
