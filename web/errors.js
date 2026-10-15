// Maps API error codes to dictionary keys (web/i18n.js). The server's raw error text is never shown:
// unknown codes, network failures and 5xx responses get a translated generic message.
const BY_CODE = {
	SEARCH_UNAVAILABLE: { titleKey: 'error.search.title', bodyKey: 'error.search.body' },
	NETWORK: { titleKey: 'error.request.title', bodyKey: 'error.network' },
	INVALID_QUERY: { titleKey: 'error.request.title', bodyKey: 'error.badRequest' },
	USAGE: { titleKey: 'error.request.title', bodyKey: 'error.badRequest' },
	INVALID_JSON: { titleKey: 'error.request.title', bodyKey: 'error.badRequest' },
	BODY_TOO_LARGE: { titleKey: 'error.request.title', bodyKey: 'error.badRequest' },
	UNSUPPORTED_MEDIA_TYPE: { titleKey: 'error.request.title', bodyKey: 'error.badRequest' },
	PROJECT_NOT_ALLOWED: { titleKey: 'error.request.title', bodyKey: 'error.noProject' },
	SNAPSHOT_NOT_ALLOWED: { titleKey: 'error.request.title', bodyKey: 'error.noProject' },
	UNKNOWN_PROJECT: { titleKey: 'error.request.title', bodyKey: 'error.noProject' },
	UNKNOWN_SNAPSHOT: { titleKey: 'error.request.title', bodyKey: 'error.noProject' },
};
const GENERIC = { titleKey: 'error.request.title', bodyKey: 'error.generic' };

/** Dictionary keys for an API error code (INTERNAL, HTTP_5xx and anything unknown → generic). */
export function errorKeys(code) {
	return Object.prototype.hasOwnProperty.call(BY_CODE, code) ? BY_CODE[code] : GENERIC;
}

export const KNOWN_ERROR_CODES = Object.keys(BY_CODE);
