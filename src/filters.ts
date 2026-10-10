import { isSafeRepoPath } from './paths.js';

/** Bump when filtering behaviour changes: it is part of every snapshot id. */
export const FILTER_VERSION = 2;

export const FILTER_LIMITS = {
	/** Files larger than this are not indexed. */
	maxFileBytes: 512 * 1024,
	/** Any single line longer than this marks the file as generated/minified. */
	maxLineChars: 2000,
	/** Average line length above this marks the file as minified. */
	maxAvgLineChars: 300,
	/** Upper bound on indexed files per source, so a huge repo fails loudly. */
	maxFilesPerSource: 20_000,
} as const;

export const ALLOWED_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.mts',
	'.cts',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.json',
	'.md',
	'.mdx',
	'.graphql',
	'.gql',
	'.yml',
	'.yaml',
] as const;

/** Directory names that are never indexed, at any depth. */
const DENY_DIRS = new Set([
	'node_modules',
	'bower_components',
	'jspm_packages',
	'dist',
	'build',
	'out',
	'.next',
	'.nuxt',
	'.svelte-kit',
	'.turbo',
	'.cache',
	'.parcel-cache',
	'coverage',
	'.nyc_output',
	'uploads',
	'upload',
	'vendor',
	'.git',
	'.aws',
	'.ssh',
	'.gnupg',
	'.agents',
	'.claude',
	'.cursor',
	'.idea',
	'.vscode',
	'__snapshots__',
]);

/** Exact file names that are never indexed. */
const DENY_FILES = new Set([
	'package-lock.json',
	'npm-shrinkwrap.json',
	'yarn.lock',
	'pnpm-lock.yaml',
	'bun.lockb',
	'.npmrc',
	'.yarnrc',
	'.yarnrc.yml',
	'.pypirc',
	'.netrc',
	'.git-credentials',
	'credentials.json',
	'service-account.json',
	'id_rsa',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
]);

/** File-name patterns that are never indexed. */
const DENY_PATTERNS: readonly RegExp[] = [
	/^\.env(\..*)?$/i, // .env, .env.local, .env.example — examples are reviewed by hand, not indexed
	/\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg)$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
	/(^|[._-])(secrets?|credentials?)\.(json|ya?ml|txt|ini|toml|conf|cfg)$/i,
	/\.min\.(js|mjs|cjs)$/i,
	/\.(map|snap)$/i,
	/\.d\.ts$/i,
	/\.(log|sql|sqlite|db|dump|bak)$/i,
];

export type ExcludeReason =
	| 'unsafe-path'
	| 'symlink'
	| 'submodule'
	| 'extension'
	| 'denied-dir'
	| 'denied-file'
	| 'project-exclude'
	| 'too-large'
	| 'binary'
	| 'not-utf8'
	| 'long-line'
	| 'minified'
	| 'secret-suspected'
	| 'file-limit';

function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] as string;
		if (c === '*') {
			if (glob[i + 1] === '*') {
				i++;
				if (glob[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				} else re += '.*';
			} else re += '[^/]*';
		} else if (c === '?') re += '[^/]';
		else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${re}$`);
}

/** Path-only decision, made before any blob is read. */
export function classifyPath(path: string, projectExcludes: readonly RegExp[] = []): ExcludeReason | null {
	if (!isSafeRepoPath(path)) return 'unsafe-path';
	const segments = path.split('/');
	const fileName = segments[segments.length - 1] as string;
	if (segments.slice(0, -1).some((segment) => DENY_DIRS.has(segment.toLowerCase()))) return 'denied-dir';
	if (DENY_FILES.has(fileName.toLowerCase())) return 'denied-file';
	if (DENY_PATTERNS.some((pattern) => pattern.test(fileName))) return 'denied-file';
	if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(path))) return 'extension';
	if (projectExcludes.some((re) => re.test(path))) return 'project-exclude';
	return null;
}

// ignoreBOM: keep a leading U+FEFF so decoded text maps 1:1 onto the blob bytes.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Content decision for a blob that passed the path filter. Returns the decoded text when indexable. */
export function classifyContent(bytes: Buffer): { reason: ExcludeReason } | { text: string } {
	if (bytes.length > FILTER_LIMITS.maxFileBytes) return { reason: 'too-large' };
	if (bytes.includes(0)) return { reason: 'binary' };
	let text: string;
	try {
		text = utf8.decode(bytes);
	} catch {
		return { reason: 'not-utf8' };
	}
	const lines = text.split('\n');
	let maxLine = 0;
	for (const line of lines) if (line.length > maxLine) maxLine = line.length;
	if (maxLine > FILTER_LIMITS.maxLineChars) return { reason: 'long-line' };
	if (text.length / Math.max(1, lines.length) > FILTER_LIMITS.maxAvgLineChars) return { reason: 'minified' };
	return { text };
}

export function filterConfigFingerprint(): unknown {
	return {
		version: FILTER_VERSION,
		limits: FILTER_LIMITS,
		extensions: ALLOWED_EXTENSIONS,
		denyDirs: [...DENY_DIRS].sort(),
		denyFiles: [...DENY_FILES].sort(),
		denyPatterns: DENY_PATTERNS.map((re) => re.source),
	};
}
