import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CodeTrailError } from './errors.js';
import { assertId } from './ids.js';
import type { SourceKind } from './sources.js';

export interface SourceRecord {
	id: string;
	kind: SourceKind;
	/** Canonical GitHub URL, or the resolved real path of a local repo. */
	location: string;
	/** Ref snapshotted when none is given on the command line. */
	defaultRef: string;
}

export interface ProjectRecord {
	id: string;
	name: string;
	/** Extra repo-relative glob excludes on top of the built-in denylist. */
	exclude: string[];
	sources: SourceRecord[];
}

interface RegistryFile {
	schema: 1;
	projects: ProjectRecord[];
}

/** Small JSON registry of projects and their sources. Written atomically. */
export class Registry {
	private readonly file: string;

	constructor(dataDir: string) {
		this.file = join(dataDir, 'registry.json');
	}

	private read(): RegistryFile {
		try {
			const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as RegistryFile;
			if (parsed.schema !== 1 || !Array.isArray(parsed.projects)) throw new Error('bad schema');
			return parsed;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, projects: [] };
			throw err;
		}
	}

	private write(data: RegistryFile): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
		renameSync(tmp, this.file);
	}

	listProjects(): ProjectRecord[] {
		return this.read().projects;
	}

	getProject(projectId: string): ProjectRecord {
		assertId('project', projectId);
		const project = this.read().projects.find((p) => p.id === projectId);
		if (!project) throw new CodeTrailError('UNKNOWN_PROJECT', `Unknown project: ${projectId}`);
		return project;
	}

	addProject(projectId: string, name: string, exclude: string[] = []): ProjectRecord {
		assertId('project', projectId);
		const data = this.read();
		if (data.projects.some((p) => p.id === projectId)) {
			throw new CodeTrailError('DUPLICATE', `Project already exists: ${projectId}`);
		}
		const project: ProjectRecord = { id: projectId, name: name || projectId, exclude: [...exclude].sort(), sources: [] };
		data.projects.push(project);
		data.projects.sort((a, b) => a.id.localeCompare(b.id));
		this.write(data);
		return project;
	}

	addSource(projectId: string, source: SourceRecord): SourceRecord {
		assertId('source', source.id);
		const data = this.read();
		const project = data.projects.find((p) => p.id === projectId);
		if (!project) throw new CodeTrailError('UNKNOWN_PROJECT', `Unknown project: ${projectId}`);
		if (project.sources.some((s) => s.id === source.id)) {
			throw new CodeTrailError('DUPLICATE', `Source already exists: ${source.id}`);
		}
		project.sources.push(source);
		project.sources.sort((a, b) => a.id.localeCompare(b.id));
		this.write(data);
		return source;
	}
}
