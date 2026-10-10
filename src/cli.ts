#!/usr/bin/env node
import { loadConfig } from './config.js';
import { CodeTrailError } from './errors.js';
import { assertId } from './ids.js';
import { Registry } from './registry.js';
import { createSnapshot, listSnapshots, readSnapshot } from './snapshot.js';
import { normalizeGithubUrl, resolveLocalSource } from './sources.js';

const USAGE = `codetrail — exact-commit snapshots and chunking for TS/JS repositories

Usage:
  codetrail project add <project_id> [--name <name>] [--exclude <glob>]...
  codetrail project list
  codetrail source add-local  <project_id> <source_id> <absolute_path> [--ref <ref>]
  codetrail source add-github <project_id> <source_id> <https://github.com/owner/repo> [--ref <ref>]
  codetrail snapshot create <project_id> [--ref <source_id>=<ref>]...
  codetrail snapshot list <project_id>
  codetrail snapshot show <project_id> <snapshot_id>

Environment: CODETRAIL_DATA_DIR (default ./data), CODETRAIL_LOCAL_ROOTS (colon-separated).
Output is JSON. File contents and secret values are never printed.`;

interface Parsed {
	positional: string[];
	flags: Map<string, string[]>;
}

function parse(argv: string[]): Parsed {
	const positional: string[] = [];
	const flags = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg.startsWith('--')) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) throw new CodeTrailError('USAGE', `Missing value for ${arg}`);
			flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), value]);
			i++;
		} else positional.push(arg);
	}
	return { positional, flags };
}

function need(values: string[], count: number): string[] {
	if (values.length !== count) throw new CodeTrailError('USAGE', USAGE);
	return values;
}

function print(value: unknown): void {
	process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function main(argv: string[]): Promise<number> {
	const config = loadConfig();
	const registry = new Registry(config.dataDir);
	const { positional, flags } = parse(argv);
	const [group, action, ...rest] = positional;
	const one = (name: string): string | undefined => flags.get(name)?.at(-1);

	if (group === 'project' && action === 'add') {
		const [projectId] = need(rest, 1) as [string];
		print(registry.addProject(projectId, one('name') ?? projectId, flags.get('exclude') ?? []));
		return 0;
	}
	if (group === 'project' && action === 'list') {
		print(registry.listProjects());
		return 0;
	}
	if (group === 'source' && (action === 'add-local' || action === 'add-github')) {
		const [projectId, sourceId, location] = need(rest, 3) as [string, string, string];
		assertId('project', projectId);
		assertId('source', sourceId);
		registry.getProject(projectId);
		const resolvedLocation = action === 'add-local' ? resolveLocalSource(location, config.localRoots) : normalizeGithubUrl(location);
		print(
			registry.addSource(projectId, {
				id: sourceId,
				kind: action === 'add-local' ? 'local' : 'github',
				location: resolvedLocation,
				defaultRef: one('ref') ?? 'HEAD',
			}),
		);
		return 0;
	}
	if (group === 'snapshot' && action === 'create') {
		const [projectId] = need(rest, 1) as [string];
		const refs: Record<string, string> = {};
		for (const pair of flags.get('ref') ?? []) {
			const eq = pair.indexOf('=');
			if (eq <= 0) throw new CodeTrailError('USAGE', '--ref expects <source_id>=<ref>');
			refs[pair.slice(0, eq)] = pair.slice(eq + 1);
		}
		const result = await createSnapshot(config, projectId, refs);
		print({ ...result.report, result: result.status });
		return result.status === 'blocked' ? 2 : 0;
	}
	if (group === 'snapshot' && action === 'list') {
		const [projectId] = need(rest, 1) as [string];
		print(listSnapshots(config.dataDir, projectId).map((r) => ({ snapshot_id: r.snapshot_id, created_at: r.created_at, sources: r.sources, counts: r.counts })));
		return 0;
	}
	if (group === 'snapshot' && action === 'show') {
		const [projectId, snapshotId] = need(rest, 2) as [string, string];
		const { report } = readSnapshot(config.dataDir, projectId, snapshotId);
		print(report);
		return 0;
	}
	process.stderr.write(USAGE + '\n');
	return group ? 64 : 0;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err: unknown) => {
		if (err instanceof CodeTrailError) {
			process.stderr.write(`error [${err.code}]: ${err.message}\n`);
			process.exit(err.code === 'USAGE' ? 64 : 1);
		}
		process.stderr.write(`error: ${err instanceof Error ? err.message : 'unexpected failure'}\n`);
		process.exit(1);
	},
);
