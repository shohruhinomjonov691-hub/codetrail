import { CodeTrailError } from '../errors.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * Model providers must be local: a loopback host, or an internal host name the
 * operator explicitly allowlisted (e.g. a Docker service name). URLs with
 * credentials, query strings, fragments or a path are rejected so the base URL
 * can only ever be "scheme://host:port".
 */
export function validateProviderUrl(raw: string, allowedHosts: readonly string[] = []): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new CodeTrailError('PROVIDER_URL_REJECTED', 'Provider URL is not a valid URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new CodeTrailError('PROVIDER_URL_REJECTED', 'Provider URL must use http or https');
	}
	if (url.username || url.password) throw new CodeTrailError('PROVIDER_URL_REJECTED', 'Provider URL must not contain credentials');
	if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
		throw new CodeTrailError('PROVIDER_URL_REJECTED', 'Provider URL must be a bare scheme://host:port');
	}
	const host = url.hostname.toLowerCase();
	const allowed = new Set(allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
	if (!LOOPBACK.has(host) && !allowed.has(host)) {
		throw new CodeTrailError('PROVIDER_URL_REJECTED', `Provider host ${host} is not loopback or in CODETRAIL_PROVIDER_HOSTS`);
	}
	return url;
}

/** Small counting semaphore for bounding concurrent provider requests. */
export class Semaphore {
	private active = 0;
	private readonly waiters: (() => void)[] = [];

	constructor(private readonly limit: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiters.shift()?.();
		}
	}
}
