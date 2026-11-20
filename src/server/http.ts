import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AnswerService, parseLanguage, RequestCancelledError, SearchUnavailableError, type ExplainResponse } from '../answer/service.js';
import type { ProjectStatus } from '../catalog.js';
import { CodeTrailError } from '../errors.js';
import { assertId, assertSnapshotId } from '../ids.js';
import { publicReport } from '../monitor/report.js';
import type { RunReport } from '../monitor/run.js';

const MAX_BODY_BYTES = 8 * 1024;
const STATIC: Record<string, { file: string; type: string }> = {
	'/': { file: 'index.html', type: 'text/html; charset=utf-8' },
	'/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
	'/highlight.js': { file: 'highlight.js', type: 'text/javascript; charset=utf-8' },
	'/errors.js': { file: 'errors.js', type: 'text/javascript; charset=utf-8' },
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

/**
 * Parses CODETRAIL_PUBLIC_PIN: one "project:snapshot" or a comma-separated list of them
 * (at most 12, each project once). The server answers for exactly these.
 */
export function parsePublicPins(raw: string | undefined): PublicPin[] {
	const parts = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
	if (parts.length === 0 || parts.length > 12) throw new CodeTrailError('USAGE', 'CODETRAIL_PUBLIC_PIN must list 1-12 "<project_id>:<snapshot_id>" entries');
	const pins = parts.map((p) => parsePublicPin(p));
	if (new Set(pins.map((p) => p.project_id)).size !== pins.length) throw new CodeTrailError('USAGE', 'CODETRAIL_PUBLIC_PIN lists a project twice');
	return pins;
}

/** Monitor endpoints (/api/monitor/check, /api/monitor/last): off unless the operator sets an access key. */
export interface MonitorApi {
	/** The secret every request must present as `Authorization: Bearer <key>`. Never logged or returned. */
	accessKey: string;
	/** Runs the checks in report mode (one Telegram summary). Rejects with LOCK_TIMEOUT when another run is active. */
	check: () => Promise<RunReport>;
	/** The last run's report (the same last-run.json the CLI writes), or null. */
	last: () => RunReport | null;
	/** Minimum time between two web-triggered checks (default 60 s). */
	checkIntervalMs?: number;
}

export interface ServerOptions {
	/** Access-key protected monitor API; without it both endpoints answer 403 MONITOR_DISABLED. */
	monitor?: MonitorApi;
	/**
	 * Public mode: the server answers for these projects/snapshots only. With one pin a request
	 * may omit project_id/snapshot_id; with several, project_id is required. Any other project
	 * or snapshot is refused (403).
	 */
	pinned?: PublicPin | readonly PublicPin[];
	/** State of every catalog project for the project picker (ready / indexing / error). */
	catalog?: () => ProjectStatus[];
	/** Requests per client per minute across /api/search, /api/explain and /api/chat (default 60). */
	requestsPerMinute?: number;
	/** Directory with the static UI (default: <repo>/web). */
	webDir?: string;
	/** Use the first X-Forwarded-For address as the client id (only behind a trusted proxy). */
	trustProxy?: boolean;
	/** One line per request; never receives questions, prompts, code or keys. */
	log?: (line: string) => void;
}

const describe = (result: ExplainResponse): string => `mode=${result.mode}${result.reason ? ` reason=${result.reason}` : ''}${result.cached ? ' cached' : ''} evidence=${result.evidence}`;

const MONITOR_ATTEMPTS_PER_MINUTE = 20;
const sha = (v: string): Buffer => createHash('sha256').update(v).digest();

/** Constant-time check of `Authorization: Bearer <key>`. */
export function bearerMatches(header: string | undefined, key: string): boolean {
	const m = /^Bearer (\S+)$/.exec(header ?? '');
	return m !== null && timingSafeEqual(sha(m[1] as string), sha(key));
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

/**
 * In public mode only pinned projects/snapshots may be addressed. One pin: omitting
 * project_id means that project. Several pins: project_id is required.
 */
function scope(body: Record<string, unknown>, pins: readonly PublicPin[] | undefined): { project_id: unknown; snapshot_id: unknown } {
	if (!pins) return { project_id: body.project_id, snapshot_id: body.snapshot_id };
	let pin: PublicPin | undefined;
	if (body.project_id === undefined) {
		if (pins.length !== 1) throw new HttpError(400, 'USAGE', 'project_id is required');
		pin = pins[0];
	} else pin = pins.find((p) => p.project_id === body.project_id);
	if (!pin) throw new HttpError(403, 'PROJECT_NOT_ALLOWED', 'This server does not answer for that project');
	if (body.snapshot_id !== undefined && body.snapshot_id !== pin.snapshot_id) throw new HttpError(403, 'SNAPSHOT_NOT_ALLOWED', 'This server answers only for its configured snapshot');
	return { project_id: pin.project_id, snapshot_id: pin.snapshot_id };
}

/** Sliding one-minute window per client. */
class RequestWindow {
	private readonly hits = new Map<string, number[]>();
	constructor(private readonly perMinute: number) {}
	allow(client: string, now = Date.now()): boolean {
		const recent = (this.hits.get(client) ?? []).filter((t) => now - t < 60_000);
		if (recent.length >= this.perMinute) {
			this.hits.set(client, recent);
			return false;
		}
		recent.push(now);
		this.hits.set(client, recent);
		if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.every((t) => now - t >= 60_000)) this.hits.delete(k);
		return true;
	}
}

/**
 * Client id for rate limits. Behind a trusted proxy the LAST X-Forwarded-For entry is the address the
 * proxy itself saw; earlier entries are whatever the client sent and can be forged to dodge limits.
 */
export function clientId(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean): string {
	if (trustProxy) {
		const parts = String(req.headers['x-forwarded-for'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
		if (parts.length) return parts[parts.length - 1] as string;
	}
	return req.socket.remoteAddress || 'unknown';
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
 *   POST /api/search    {project_id, question, snapshot_id?, language?, previous_questions?} → local sources only, no AI call
 *   POST /api/explain   {project_id, question, snapshot_id?, language?, previous_questions?} → sources + grounded AI answer or a fallback
 * previous_questions: up to 2 earlier questions of the conversation (questions only, never answers).
 */
export function createHttpServer(service: AnswerService, options: ServerOptions = {}): Server {
	const webDir = options.webDir ?? fileURLToPath(new URL('../../web/', import.meta.url));
	const log = options.log ?? (() => {});
	const pins = options.pinned === undefined ? undefined : Array.isArray(options.pinned) ? (options.pinned as readonly PublicPin[]) : [options.pinned as PublicPin];
	const requestWindow = new RequestWindow(options.requestsPerMinute ?? 60);
	// Every monitor request (valid key or not) counts, so the key cannot be guessed quickly.
	const monitorAttempts = new RequestWindow(MONITOR_ATTEMPTS_PER_MINUTE);
	const monitorInterval = options.monitor?.checkIntervalMs ?? 60_000;
	let monitorBusy = false;
	let monitorLastStart = 0;
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
					const projects = pins ? service.list().filter((p) => pins.some((pin) => pin.project_id === p.project_id && pin.snapshot_id === p.snapshot_id)) : service.list();
					const catalog = options.catalog ? options.catalog() : projects.map((p): ProjectStatus => ({ project_id: p.project_id, name: p.name, state: 'ready', reason: null, snapshot_id: p.snapshot_id, chunks: p.chunks, sources: p.sources }));
					send(res, 200, { projects, catalog, pinned: Boolean(pins), ai: { available: service.generationModel !== null, model: service.generationModel }, monitor: { available: Boolean(options.monitor) } });
					return done(200);
				}
				if (path === '/api/monitor/check' || path === '/api/monitor/last') {
					const mon = options.monitor;
					if (req.method !== (path === '/api/monitor/check' ? 'POST' : 'GET')) throw new HttpError(405, 'METHOD_NOT_ALLOWED', path === '/api/monitor/check' ? 'Use POST' : 'Use GET');
					if (!mon) throw new HttpError(403, 'MONITOR_DISABLED', 'Monitor access is not enabled on this server');
					if (!monitorAttempts.allow(clientId(req, options.trustProxy === true))) {
						note = 'rate_limited';
						throw new HttpError(429, 'RATE_LIMITED', 'Too many requests');
					}
					if (!bearerMatches(req.headers.authorization, mon.accessKey)) {
						note = 'unauthorized';
						throw new HttpError(401, 'UNAUTHORIZED', 'A valid access key is required');
					}
					if (path === '/api/monitor/last') {
						const last = mon.last();
						send(res, 200, last ? publicReport(last) : { at: null, projects: [], items: [], not_configured: [], telegram: null });
						return done(200);
					}
					// POST /api/monitor/check: one run at a time, at most one per interval; the run itself also holds the monitor lock.
					if (monitorBusy) throw new HttpError(409, 'MONITOR_BUSY', 'A monitor run is already in progress');
					const wait = monitorLastStart + monitorInterval - Date.now();
					if (wait > 0) {
						note = 'check_cooldown';
						res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
						throw new HttpError(429, 'RATE_LIMITED', 'The monitor can be checked once per minute');
					}
					monitorBusy = true;
					monitorLastStart = Date.now();
					try {
						const report = await mon.check();
						note = `telegram=${report.telegram?.outcome ?? 'none'}`;
						send(res, 200, publicReport(report));
						return done(200);
					} catch (err) {
						if (err instanceof CodeTrailError && err.code === 'LOCK_TIMEOUT') {
							monitorLastStart = 0; // another process (cron) holds the lock: this click did not run, so it does not use the interval
							throw new HttpError(409, 'MONITOR_BUSY', 'A monitor run is already in progress');
						}
						if (err instanceof CodeTrailError && err.code === 'USAGE') throw new HttpError(503, 'MONITOR_NOT_CONFIGURED', 'The monitor configuration is missing or invalid');
						throw err;
					} finally {
						monitorBusy = false;
					}
				}
				if (path === '/api/search' || path === '/api/explain' || path === '/api/chat') {
					if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');
					const body = await readJson(req);
					const target = scope(body, pins);
					const language = parseLanguage(body.language); // only "en" | "ko" (default "en")
					const client = clientId(req, options.trustProxy === true);
					if (!requestWindow.allow(client)) {
						note = 'rate_limited';
						throw new HttpError(429, 'RATE_LIMITED', 'Too many requests');
					}
					if (path === '/api/search') {
						send(res, 200, await service.search(target.project_id, body.question, target.snapshot_id, body.previous_questions));
						return done(200);
					}
					// A client that disconnects cancels its explanation (queued calls never reach the provider).
					const cancel = new AbortController();
					res.on('close', () => {
						if (!res.writableEnded) cancel.abort();
					});
					if (path === '/api/explain') {
						const result = await service.explain(target.project_id, body.question, client, target.snapshot_id, cancel.signal, language, body.previous_questions);
						note = describe(result);
						send(res, 200, result);
						return done(200);
					}
					// /api/chat: server-sent events. Everything that can be a 4xx is checked before the stream starts.
					service.check(target.project_id, body.question, target.snapshot_id, body.previous_questions);
					res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
					const emit = (event: string, data: unknown): void => {
						if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
					};
					const beat = setInterval(() => !res.destroyed && !res.writableEnded && res.write(': ping\n\n'), 10_000);
					try {
						const result = await service.explain(target.project_id, body.question, client, target.snapshot_id, cancel.signal, language, body.previous_questions, (phase) => emit('phase', { phase }));
						note = describe(result);
						// The answer is complete and validated; `streaming` is the client revealing it.
						emit('phase', { phase: 'streaming' });
						emit('result', result);
						return done(200);
					} catch (err) {
						if (err instanceof RequestCancelledError) throw err;
						const e = errorStatus(err);
						if (e.status === 500) note = `error=${err instanceof Error ? err.name : 'unknown'}`;
						emit('error', { code: e.code });
						return done(e.status);
					} finally {
						clearInterval(beat);
						if (!res.writableEnded) res.end();
					}
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
