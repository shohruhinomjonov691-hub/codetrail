import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AnswerService, parseLanguage, RequestCancelledError, SearchUnavailableError } from '../answer/service.js';
import { CodeTrailError } from '../errors.js';
import { assertId, assertSnapshotId } from '../ids.js';

const MAX_BODY_BYTES = 8 * 1024;
const STATIC: Record<string, { file: string; type: string }> = {
	'/': { file: 'index.html', type: 'text/html; charset=utf-8' },
	'/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
	'/highlight.js': { file: 'highlight.js', type: 'text/javascript; charset=utf-8' },
	'/i18n.js': { file: 'i18n.js', type: 'text/javascript; charset=utf-8' },
	'/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const SECURITY_HEADERS = {
	'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'X-Frame-Options': 'DENY',
};

/** The one project and snapshot a public server answers for. */
export interface PublicPin {
	project_id: string;
	snapshot_id: string;
}

/** Parses CODETRAIL_PUBLIC_PIN ("project:<24-hex snapshot id>"); both parts are required. */
export function parsePublicPin(raw: string | undefined): PublicPin {
	const [project, snapshot, extra] = (raw ?? '').trim().split(':');
	if (!project || !snapshot || extra !== undefined) throw new CodeTrailError('USAGE', 'CODETRAIL_PUBLIC_PIN must be "<project_id>:<snapshot_id>"');
	return { project_id: assertId('project', project), snapshot_id: assertSnapshotId(snapshot) };
}

export interface ServerOptions {
	/**
	 * Public mode: the server answers for this project and snapshot only. A request
	 * may omit project_id/snapshot_id; any other value is refused (403).
	 */
	pinned?: PublicPin;
	/** Directory with the static UI (default: <repo>/web). */
	webDir?: string;
	/** Use the first X-Forwarded-For address as the client id (only behind a trusted proxy). */
	trustProxy?: boolean;
	/** One line per request; never receives questions, prompts, code or keys. */
	log?: (line: string) => void;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', `Request body is larger than ${MAX_BODY_BYTES} bytes`);
		chunks.push(chunk as Buffer);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object');
	return parsed as Record<string, unknown>;
}

/** In public mode only the pinned project/snapshot may be addressed (omitting them means the pinned ones). */
function scope(body: Record<string, unknown>, pinned: PublicPin | undefined): { project_id: unknown; snapshot_id: unknown } {
	if (!pinned) return { project_id: body.project_id, snapshot_id: body.snapshot_id };
	if (body.project_id !== undefined && body.project_id !== pinned.project_id) throw new HttpError(403, 'PROJECT_NOT_ALLOWED', 'This server answers only for its configured project');
	if (body.snapshot_id !== undefined && body.snapshot_id !== pinned.snapshot_id) throw new HttpError(403, 'SNAPSHOT_NOT_ALLOWED', 'This server answers only for its configured snapshot');
	return { project_id: pinned.project_id, snapshot_id: pinned.snapshot_id };
}

function errorStatus(err: unknown): { status: number; code: string; message: string } {
	if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
	if (err instanceof SearchUnavailableError) return { status: 503, code: 'SEARCH_UNAVAILABLE', message: 'Local search is unavailable.' };
	if (err instanceof CodeTrailError) {
		if (err.code === 'UNKNOWN_PROJECT' || err.code === 'UNKNOWN_SNAPSHOT') return { status: 404, code: err.code, message: err.message };
		if (err.code === 'USAGE' || err.code === 'INVALID_QUERY') return { status: 400, code: err.code, message: err.message };
	}
	return { status: 500, code: 'INTERNAL', message: 'Internal error' };
}

/**
 * HTTP API + static developer UI for one AnswerService:
 *   GET  /api/projects  served projects (operator-managed; there is no endpoint to add repositories)
 *   POST /api/search    {project_id, question, snapshot_id?} → local sources only, no AI call
 *   POST /api/explain   {project_id, question, snapshot_id?} → sources + grounded AI answer or a fallback
 */
export function createHttpServer(service: AnswerService, options: ServerOptions = {}): Server {
	const webDir = options.webDir ?? fileURLToPath(new URL('../../web/', import.meta.url));
	const log = options.log ?? (() => {});
	const server = createServer((req, res) => {
		const started = Date.now();
		let note = '';
		const done = (status: number): void => log(`${req.method} ${(req.url ?? '').split('?')[0]} ${status} ${Date.now() - started}ms${note ? ` ${note}` : ''}`);
		void (async () => {
			const path = (req.url ?? '/').split('?')[0] as string;
			try {
				if (req.method === 'GET' && STATIC[path]) {
					const asset = STATIC[path];
					const body = readFileSync(`${webDir}/${asset.file}`);
					res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
					res.end(body);
					return done(200);
				}
				if (req.method === 'GET' && path === '/api/projects') {
					const projects = options.pinned ? service.list().filter((p) => p.project_id === options.pinned!.project_id && p.snapshot_id === options.pinned!.snapshot_id) : service.list();
					send(res, 200, { projects, pinned: Boolean(options.pinned), ai: { available: service.generationModel !== null, model: service.generationModel } });
					return done(200);
				}
				if (path === '/api/search' || path === '/api/explain') {
					if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');
					const body = await readJson(req);
					const target = scope(body, options.pinned);
					const language = parseLanguage(body.language); // only "en" | "ko" (default "en")
					if (path === '/api/search') {
						send(res, 200, await service.search(target.project_id, body.question, target.snapshot_id));
						return done(200);
					}
					const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
					const client = forwarded || req.socket.remoteAddress || 'unknown';
					// A client that disconnects cancels its explanation (queued calls never reach the provider).
					const cancel = new AbortController();
					res.on('close', () => {
						if (!res.writableEnded) cancel.abort();
					});
					const result = await service.explain(target.project_id, body.question, client, target.snapshot_id, cancel.signal, language);
					note = `mode=${result.mode}${result.reason ? ` reason=${result.reason}` : ''}${result.cached ? ' cached' : ''}`;
					send(res, 200, result);
					return done(200);
				}
				throw new HttpError(404, 'NOT_FOUND', 'Not found');
			} catch (err) {
				if (err instanceof RequestCancelledError) {
					note = 'client closed';
					if (!res.writableEnded) res.destroy();
					return done(499);
				}
				const e = errorStatus(err);
				if (e.status === 500) note = `error=${err instanceof Error ? err.name : 'unknown'}`;
				send(res, e.status, { error: { code: e.code, message: e.message } });
				done(e.status);
			}
		})();
	});
	// Slow or stalled clients must not hold connections for minutes (Node's default is 300 s).
	server.requestTimeout = 30_000;
	server.headersTimeout = 15_000;
	return server;
}
