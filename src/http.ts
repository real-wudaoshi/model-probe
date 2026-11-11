// Shared HTTP plumbing for every probe request:
// - silence is bounded everywhere: the headers must arrive in time, and a body
//   that stops arriving is cut off, so a stalling server cannot hang a probe
// - timers are always cleared, so nothing keeps the process alive afterwards
// - redirects are followed by hand: the API key survives an http -> https
//   upgrade on the same host but is never forwarded to another host
// - transport failures carry a readable reason instead of undici's bare
//   "fetch failed"
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { PROBE_TIMEOUT_MS } from "./types.ts";

export type HttpResult = {
	ok: boolean;
	status: number;
	statusText: string;
	/** The URL that produced this response (differs from the request URL after redirects). */
	url: string;
	headers: Headers;
	body: string;
	/** Set when a redirect led to another host and the credentials were withheld from it. */
	credentialsWithheldFrom?: string;
};

export type HttpFailureKind = "timeout" | "dns" | "connect";

/** A request that never produced an HTTP response. */
export class HttpError extends Error {
	readonly kind: HttpFailureKind;
	readonly url: string;
	readonly code?: string;

	constructor(kind: HttpFailureKind, url: string, message: string, code?: string) {
		super(message);
		this.name = "HttpError";
		this.kind = kind;
		this.url = url;
		this.code = code;
	}
}

export type RequestOptions = {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	/** Secret-bearing headers (authorization, api-key headers). Dropped when a redirect leaves the host. */
	credentials?: Record<string, string>;
	body?: string;
	/**
	 * Patience, in ms: the response headers must arrive within it (across
	 * redirects), and while the body downloads no gap between chunks may exceed
	 * it. Default PROBE_TIMEOUT_MS.
	 */
	timeoutMs?: number;
	/** Hard limit for downloading the whole body. Default 30s. */
	bodyTimeoutMs?: number;
	/** Abandon the request when this fires (the caller no longer needs the answer). */
	signal?: AbortSignal;
};

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_BODY_TIMEOUT_MS = 30_000;

// Ports the Fetch standard refuses to connect to ("bad ports"). fetch() fails
// on them before sending anything — yet a local gateway on :6000 or :10080 is
// perfectly ordinary, so those go through node:http instead.
const FETCH_BLOCKED_PORTS = new Set([
	1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
	137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
	1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

type SendInit = { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal };

// The same exchange as fetch(url, { redirect: "manual" }), over node:http.
function sendWithNodeHttp(url: URL, init: SendInit): Promise<Response> {
	return new Promise((resolve, reject) => {
		const transport = url.protocol === "https:" ? https : http;
		const request = transport.request(
			url,
			{
				method: init.method,
				// node:http does not decompress, so ask for an uncompressed body.
				headers: { ...init.headers, "accept-encoding": "identity" },
				signal: init.signal,
				// A connection per request: a pooled keep-alive socket the server has
				// since closed would surface as a spurious ECONNRESET.
				agent: false,
			},
			(response) => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(response.headers)) {
					for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
				}
				const status = response.statusCode ?? 502;
				// Statuses that cannot carry a body, as far as Response is concerned.
				const bodiless = status === 204 || status === 205 || status === 304;
				if (bodiless) response.resume();
				try {
					resolve(new Response(bodiless ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status, statusText: response.statusMessage ?? "", headers }));
				} catch (error) {
					response.destroy();
					reject(error);
				}
			},
		);
		request.on("error", reject);
		request.end(init.body);
	});
}

function send(url: string, init: SendInit): Promise<Response> {
	const target = new URL(url);
	if (target.port && FETCH_BLOCKED_PORTS.has(Number(target.port))) return sendWithNodeHttp(target, init);
	return fetch(url, { method: init.method, headers: init.headers, body: init.body, redirect: "manual", signal: init.signal });
}

function errorCode(error: unknown): string | undefined {
	const seen = new Set<unknown>();
	let current: any = error;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		if (typeof current.code === "string" && current.code) return current.code;
		// Happy-eyeballs failures arrive as an AggregateError.
		if (Array.isArray(current.errors) && current.errors.length > 0) {
			const nested = errorCode(current.errors[0]);
			if (nested) return nested;
		}
		current = current.cause;
	}
	return undefined;
}

function errorDetail(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: any = error;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const message = typeof current.message === "string" ? current.message.trim() : "";
		if (message && message !== "fetch failed" && !parts.includes(message)) parts.push(message);
		if (Array.isArray(current.errors) && current.errors.length > 0 && !current.cause) {
			current = current.errors[0];
			continue;
		}
		current = current.cause;
	}
	return parts.join(": ");
}

function toHttpError(error: unknown, url: string, timedOut: boolean, timeoutMs: number): HttpError {
	const code = errorCode(error);
	if (timedOut || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
		return new HttpError("timeout", url, `timed out after ${timeoutMs / 1000}s: ${url}`, code);
	}
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		let host = url;
		try {
			host = new URL(url).hostname;
		} catch {
			// keep the raw url
		}
		return new HttpError("dns", url, `cannot resolve host "${host}" (${code})`, code);
	}
	const detail = errorDetail(error);
	const reason = [code, detail && detail !== code ? detail : ""].filter(Boolean).join(" — ");
	return new HttpError("connect", url, `could not connect to ${url}${reason ? ` (${reason})` : ""}`, code);
}

const defaultPort = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");

/**
 * Whether the API key may follow a redirect. Yes for the same origin, and for
 * the one cross-origin hop that is routine and harmless: the same host
 * upgrading plain http on :80 to https on :443. Never to another host,
 * another port, or down from https to http.
 */
export function mayForwardCredentials(from: URL, to: URL): boolean {
	if (from.hostname.toLowerCase() !== to.hostname.toLowerCase()) return false;
	if (from.protocol === to.protocol) return defaultPort(from) === defaultPort(to);
	return from.protocol === "http:" && to.protocol === "https:" && defaultPort(from) === "80" && defaultPort(to) === "443";
}

/**
 * Perform one HTTP exchange and return the fully-read response. Resolves for
 * every HTTP status; rejects with HttpError only when no response arrived.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<HttpResult> {
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	let activeBudget = timeoutMs;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let bodyTimer: ReturnType<typeof setTimeout> | undefined;
	// (Re)start the patience timer: fires when nothing arrives for `timeoutMs`.
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
	};
	arm();
	const abandon = () => controller.abort();
	if (options.signal?.aborted) abandon();
	else options.signal?.addEventListener("abort", abandon, { once: true });

	let currentUrl = url;
	let method = options.method ?? "GET";
	let body = options.body;
	let credentials: Record<string, string> | undefined = options.credentials;
	let credentialsWithheldFrom: string | undefined;

	try {
		for (let hop = 0; ; hop++) {
			const response = await send(currentUrl, {
				method,
				headers: { ...(options.headers ?? {}), ...(credentials ?? {}) },
				body: method === "GET" ? undefined : body,
				signal: controller.signal,
			});

			const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
			if (location && hop < MAX_REDIRECTS) {
				let next: URL | undefined;
				try {
					next = new URL(location, currentUrl);
				} catch {
					next = undefined;
				}
				if (next && (next.protocol === "http:" || next.protocol === "https:")) {
					// Nobody needs the redirect body; release the connection.
					await response.body?.cancel().catch(() => {});
					if (credentials && !mayForwardCredentials(new URL(currentUrl), next)) {
						credentials = undefined;
						credentialsWithheldFrom = next.host;
					}
					if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
						method = "GET";
						body = undefined;
					}
					currentUrl = next.toString();
					continue;
				}
			}

			// Headers are in. The body may be large and slow, so it gets a generous
			// hard limit — but it must keep coming: a server that goes quiet
			// mid-body is cut off after the usual patience.
			bodyTimer = setTimeout(() => {
				timedOut = true;
				activeBudget = bodyTimeoutMs;
				controller.abort();
			}, bodyTimeoutMs);
			let text = "";
			if (response.body) {
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				for (;;) {
					arm();
					const { done, value } = await reader.read();
					if (done) break;
					text += decoder.decode(value, { stream: true });
				}
				text += decoder.decode();
			}
			return {
				ok: response.ok,
				status: response.status,
				statusText: response.statusText,
				url: currentUrl,
				headers: response.headers,
				body: text,
				...(credentialsWithheldFrom ? { credentialsWithheldFrom } : {}),
			};
		}
	} catch (error) {
		throw toHttpError(error, currentUrl, timedOut, activeBudget);
	} finally {
		clearTimeout(timer);
		clearTimeout(bodyTimer);
		options.signal?.removeEventListener("abort", abandon);
	}
}

/** Parse a response body as JSON. Returns undefined (not null) when it isn't JSON. */
export function parseJsonBody(body: string): { value: any } | undefined {
	try {
		return { value: JSON.parse(body) };
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// API-key header selection
//
// OpenAI-compatible servers want `Authorization: Bearer`. Google's native
// Gemini API wants `x-goog-api-key` and REJECTS a request that also carries a
// Bearer header holding an API key (it reads the Bearer as an OAuth token and
// answers 401). Anthropic's API wants `x-api-key`. So exactly one scheme is
// sent per request: the one the URL calls for. When that is refused and the
// endpoint could be another flavor — by its URL, or because its error message
// names the header it wants — the request is repeated once with that scheme.

type AuthScheme = "bearer" | "goog" | "anthropic";

// The scheme that worked for an origin, so later requests (per-model details,
// gateway-wide endpoints) go straight to it.
const workingScheme = new Map<string, AuthScheme>();

function isGoogleNative(url: URL): boolean {
	return /(^|\.)googleapis\.com$/i.test(url.hostname) && !/\/openai(\/|$)/i.test(url.pathname);
}

// Relays that re-expose the Gemini-native surface keep its /v1beta path.
function looksGeminiNative(url: URL): boolean {
	return /\/v1(alpha|beta)(\/|$)/i.test(url.pathname) && !/\/openai(\/|$)/i.test(url.pathname);
}

function isAnthropicNative(url: URL): boolean {
	return /(^|\.)anthropic\.com$/i.test(url.hostname);
}

// Schemes worth trying for a URL, most likely first: the one that last worked
// on this origin, then what the URL itself suggests.
function schemesFor(url: URL): AuthScheme[] {
	const natural: AuthScheme[] = isGoogleNative(url)
		? ["goog", "bearer"]
		: isAnthropicNative(url)
			? ["anthropic", "bearer"]
			: looksGeminiNative(url)
				? ["bearer", "goog"]
				: ["bearer"];
	const known = workingScheme.get(url.origin);
	return known ? [known, ...natural.filter((scheme) => scheme !== known)] : natural;
}

// A refusal that names the header the server reads: "x-api-key header is required".
function schemeNamedIn(body: string): AuthScheme | undefined {
	if (/x-goog-api-key/i.test(body)) return "goog";
	if (/x-api-key/i.test(body)) return "anthropic";
	return undefined;
}

function credentialHeaders(scheme: AuthScheme, apiKey: string): Record<string, string> {
	if (scheme === "goog") return { "x-goog-api-key": apiKey };
	if (scheme === "anthropic") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
	return { authorization: `Bearer ${apiKey}` };
}

/**
 * `request()` with the API key attached in the header scheme the endpoint
 * expects. Without a key this is a plain request.
 *
 * `allowAlternative` permits ONE retry with another scheme after a 401/403,
 * and only when there is a reason to think the endpoint is another flavor
 * (see above). The key goes to the same host either way.
 */
export async function authedRequest(
	url: string,
	apiKey: string | undefined,
	options: RequestOptions = {},
	auth: { allowAlternative?: boolean } = {},
): Promise<HttpResult> {
	const key = apiKey?.trim();
	if (!key) return request(url, options);

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return request(url, { ...options, credentials: credentialHeaders("bearer", key) });
	}
	const schemes = schemesFor(parsed);
	const first = await request(url, { ...options, credentials: credentialHeaders(schemes[0], key) });
	if (first.status !== 401 && first.status !== 403) return first;
	if (!auth.allowAlternative) return first;

	const alternative = [...schemes.slice(1), schemeNamedIn(first.body)].find((scheme) => scheme !== undefined && scheme !== schemes[0]);
	if (!alternative) return first;
	const second = await request(url, { ...options, credentials: credentialHeaders(alternative, key) });
	if (second.ok) {
		workingScheme.set(parsed.origin, alternative);
		return second;
	}
	// Both refused: the first answer is the one the endpoint's own flavor gave.
	return first;
}

/** Forget remembered auth schemes (tests). */
export function resetAuthSchemeCache(): void {
	workingScheme.clear();
}

/** A short, printable excerpt of a response body for error messages. */
export function bodySnippet(body: string, max = 200): string {
	return body
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}
