export function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}

export function buildProbeUrl(baseUrl: string): string {
	const withSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL("models", withSlash).toString();
}

export function getPath(obj: any, path: string): any {
	let current = obj;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = current[key];
	}
	return current;
}

// First positive finite number among `paths`. Gateways that serialize numbers
// as strings ("128000") are read the same way.
export function firstFiniteNumber(obj: any, ...paths: string[]): number | undefined {
	for (const path of paths) {
		const raw = getPath(obj, path);
		const value = typeof raw === "string" && /^\s*\d+(\.\d+)?(e-?\d+)?\s*$/i.test(raw) ? Number(raw) : raw;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

function ipv4Octets(hostname: string): number[] | null {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	if (!match) return null;
	const octets = match.slice(1).map(Number);
	return octets.every((o) => o <= 255) ? octets : null;
}

// Whether a hostname points at this machine or a private network. Used to
// decide the default scheme for scheme-less input and whether an http:// URL
// deserves an https:// fallback (a public host may simply not listen on :80;
// a private one that fails over http will not suddenly answer over https).
export function isLocalHost(hostname: string): boolean {
	const lower = hostname.toLowerCase().replace(/\.$/, "");
	if (!lower) return false;

	// IPv6 literal (URL.hostname keeps the brackets).
	if (lower.startsWith("[")) {
		const v6 = lower.slice(1, -1);
		return (
			v6 === "::1" ||
			v6 === "::" ||
			/^f[cd][0-9a-f]{2}:/.test(v6) || // fc00::/7 unique local
			/^fe[89ab][0-9a-f]:/.test(v6) || // fe80::/10 link local
			v6.startsWith("::ffff:127.")
		);
	}

	const octets = ipv4Octets(lower);
	if (octets) {
		const [a, b] = octets;
		return (
			a === 127 ||
			a === 10 ||
			a === 0 ||
			(a === 192 && b === 168) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 169 && b === 254) || // link local
			(a === 100 && b >= 64 && b <= 127) // CGNAT — Tailscale and friends
		);
	}

	if (lower === "localhost" || lower.endsWith(".localhost")) return true;
	// A single-label name (docker compose service, NetBIOS / mDNS short name)
	// can only resolve on a private network.
	if (!lower.includes(".")) return true;
	return /\.(local|lan|internal|intranet|home|home\.arpa|corp|test)$/.test(lower);
}

export function hasExplicitScheme(input: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
}

// Endpoint paths people paste instead of the base URL. The base is whatever
// precedes them.
const ENDPOINT_SUFFIXES = ["/chat/completions", "/completions", "/responses", "/embeddings", "/messages", "/models"];

/**
 * Turn whatever a user typed or pasted into a probe-able base URL:
 * - adds a scheme when missing (http for local hosts, https otherwise)
 * - drops a pasted endpoint suffix (/chat/completions, /models, ...)
 * - drops query string, fragment and trailing slashes
 * Throws a descriptive error when the input cannot be read as a URL at all.
 */
export function normalizeBaseUrl(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Base URL is empty");

	let candidate = trimmed;
	if (!hasExplicitScheme(candidate)) {
		const host = candidate.replace(/^\/+/, "").split(/[/?#]/)[0];
		// Strip userinfo and port to classify the host; "[::1]:8080" keeps its brackets.
		const hostname = host.replace(/^.*@/, "").replace(/:\d+$/, "");
		candidate = `${isLocalHost(hostname) ? "http" : "https"}://${candidate.replace(/^\/+/, "")}`;
	}

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error(`Not a valid base URL: ${trimmed}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported URL scheme "${url.protocol}//" — expected http:// or https://: ${trimmed}`);
	}

	let pathname = url.pathname.replace(/\/+$/, "");
	for (const suffix of ENDPOINT_SUFFIXES) {
		if (pathname.toLowerCase().endsWith(suffix)) {
			pathname = pathname.slice(0, -suffix.length);
			break;
		}
	}
	return `${url.origin}${pathname}`;
}
