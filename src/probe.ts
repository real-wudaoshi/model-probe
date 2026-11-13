import { authedRequest, bodySnippet, HttpError, parseJsonBody, request } from "./http.ts";
import type { HttpFailureKind, HttpResult } from "./http.ts";
import { PROBE_CONCURRENCY } from "./types.ts";
import type { MetadataField, ModelCostInfo, ModelProbeInfo, ProbeResult } from "./types.ts";
import { buildProbeUrl, dedupe, firstFiniteNumber, isLocalHost, normalizeBaseUrl } from "./url.ts";
import { getMetadataProvenance, getMetadataSourceLabel, withMetadataProvenance } from "./provenance.ts";

const JSON_HEADERS: Record<string, string> = { accept: "application/json", "accept-encoding": "identity" };

// ---------------------------------------------------------------------------
// Model list
// ---------------------------------------------------------------------------

// Some gateways are quirky about where /models lives: some LiteLLM
// deployments hang on /v1/models while serving /models at the root; stock
// LiteLLM and many proxies serve both; One API / New API only mount /v1. Try
// the base as given, then the variant with a trailing /v1 added or removed.
//
// Public hosts that don't listen on :80 at all make an explicit http:// URL
// hang until the timeout, so for non-local http URLs the https:// twins are
// tried as well — after both paths of the scheme the caller actually gave.
function probeBaseVariants(base: string): string[] {
	const url = new URL(base);
	const path = url.pathname.replace(/\/+$/, "");
	let other: string | null = null;
	if (path.toLowerCase().endsWith("/v1")) other = `${url.origin}${path.slice(0, -3)}`;
	else if (path === "") other = `${url.origin}/v1`;

	const variants = [base, ...(other ? [other] : [])];
	if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
		for (const variant of [...variants]) variants.push(variant.replace(/^http:/i, "https:"));
	}
	return dedupe(variants);
}

// How informative a failed attempt is. When every variant fails, the most
// informative failure is the one reported: "401 invalid key" beats a 404 at
// the other base variant, which beats a timeout.
const RANK = { network: 0, notFound: 1, notApi: 2, serverError: 3, clientError: 4, definitive: 5 } as const;

type ListFailure = { kind: "failure"; rank: number; message: string; url: string; network?: HttpFailureKind };
type ListAttempt = { kind: "list"; base: string; items: any[] } | ListFailure;

function extractModelList(json: any): any[] | undefined {
	if (Array.isArray(json)) return json;
	if (!json || typeof json !== "object") return undefined;
	if (Array.isArray(json.data)) return json.data;
	if (Array.isArray(json.models)) return json.models;
	if (json.data && typeof json.data === "object" && Array.isArray(json.data.data)) return json.data.data;
	return undefined;
}

// Plenty of gateways report failures as HTTP 200 with an error envelope:
// { "error": { "message": ... } }, { "success": false, "message": ... }.
function errorEnvelopeMessage(json: any): string | undefined {
	if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
	const error = json.error;
	if (typeof error === "string" && error.trim()) return error.trim();
	if (error && typeof error === "object") {
		const message = [error.message, error.msg, error.detail].find((v) => typeof v === "string" && v.trim());
		return message ? String(message).trim() : bodySnippet(JSON.stringify(error));
	}
	if (json.success === false || json.ok === false) {
		const message = [json.message, json.msg, json.error_msg, json.detail].find((v) => typeof v === "string" && v.trim());
		return message ? String(message).trim() : "the request was not successful";
	}
	return undefined;
}

function statusLabel(res: HttpResult): string {
	return `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

// The base to hand back after redirects: when the list was finally served
// from another URL (http -> https upgrade, host move), that URL's base is the
// one that actually works.
function baseAfterRedirects(requestedBase: string, requestedUrl: string, finalUrl: string): string {
	if (finalUrl === requestedUrl) return requestedBase;
	try {
		const url = new URL(finalUrl);
		const path = url.pathname.replace(/\/+$/, "");
		if (path.toLowerCase().endsWith("/models")) return `${url.origin}${path.slice(0, -"/models".length)}`;
	} catch {
		// keep the requested base
	}
	return requestedBase;
}

const MAX_LIST_PAGES = 25;

// Follow list pagination: Google's native Gemini API returns 50 models per
// page with a nextPageToken; Anthropic-style lists use has_more / last_id.
async function collectRemainingPages(
	listUrl: string,
	apiKey: string | undefined,
	firstPage: any,
	items: any[],
	signal: AbortSignal | undefined,
): Promise<any[]> {
	let page = firstPage;
	for (let pages = 1; pages < MAX_LIST_PAGES && !signal?.aborted; pages++) {
		if (!page || typeof page !== "object" || Array.isArray(page)) break;
		const next = new URL(listUrl);
		if (typeof page.nextPageToken === "string" && page.nextPageToken) {
			next.searchParams.set("pageSize", "1000");
			next.searchParams.set("pageToken", page.nextPageToken);
		} else if (page.has_more === true && typeof page.last_id === "string" && page.last_id) {
			next.searchParams.set("limit", "1000");
			next.searchParams.set("after_id", page.last_id);
		} else {
			break;
		}
		let res: HttpResult;
		try {
			res = await authedRequest(next.toString(), apiKey, { headers: JSON_HEADERS, signal });
		} catch {
			break; // keep what we have
		}
		if (!res.ok) break;
		page = parseJsonBody(res.body)?.value;
		const more = extractModelList(page);
		if (!more || more.length === 0) break;
		items = items.concat(more);
	}
	return items;
}

async function fetchModelsList(base: string, apiKey: string | undefined, signal?: AbortSignal): Promise<ListAttempt> {
	const listUrl = buildProbeUrl(base);
	const failure = (rank: number, message: string, url = listUrl, network?: HttpFailureKind): ListAttempt => ({
		kind: "failure",
		rank,
		message,
		url,
		...(network ? { network } : {}),
	});

	let res: HttpResult;
	try {
		res = await authedRequest(listUrl, apiKey, { headers: JSON_HEADERS, signal }, { allowAlternative: true });
	} catch (error) {
		if (!(error instanceof HttpError)) throw error;
		const message = error.kind === "timeout" ? `Probe ${error.message}` : `Probe failed: ${error.message}`;
		return failure(RANK.network, message, listUrl, error.kind);
	}

	if (!res.ok) {
		if (res.status === 404) return failure(RANK.notFound, `Probe failed (404 Not Found): ${res.url}`, res.url);
		const snippet = bodySnippet(res.body);
		const withheld = res.credentialsWithheldFrom
			? ` (redirected to ${res.credentialsWithheldFrom}; the API key is not forwarded to another host — use that URL as the base URL)`
			: "";
		const rank = res.status === 401 || res.status === 403 ? RANK.definitive : res.status >= 500 ? RANK.serverError : RANK.clientError;
		return failure(rank, `Probe failed (${statusLabel(res)}) at ${res.url}${withheld}${snippet ? `: ${snippet}` : ""}`, res.url);
	}

	// A 200 that isn't JSON means we hit a web UI, not the API (e.g. New API
	// serving its console HTML at /models) — the other base variant may work.
	const parsed = parseJsonBody(res.body);
	if (!parsed) return failure(RANK.notApi, `Probe got a non-JSON response (a web page, not an API): ${res.url}`, res.url);

	const list = extractModelList(parsed.value);
	if (!list) {
		const envelope = errorEnvelopeMessage(parsed.value);
		if (envelope) return failure(RANK.definitive, `Probe failed: ${res.url} answered with an error: ${bodySnippet(envelope)}`, res.url);
		const snippet = bodySnippet(res.body, 120);
		return failure(RANK.notApi, `Probe failed: ${res.url} answered, but not with a model list${snippet ? `: ${snippet}` : ""}`, res.url);
	}

	const items = await collectRemainingPages(res.url, apiKey, parsed.value, list, signal);
	return { kind: "list", base: baseAfterRedirects(base, listUrl, res.url), items };
}

function modelIdOfListItem(item: any): string {
	if (typeof item === "string") return item.trim();
	if (!item || typeof item !== "object") return "";
	// Gemini entries carry "name" (models/<id>) instead of "id".
	const raw = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : typeof item.model === "string" ? item.model : "";
	return raw.trim().replace(/^models\//, "");
}

function buildProbeResult(base: string, items: any[]): ProbeResult {
	const infoById = new Map<string, ModelProbeInfo>();
	const ids = dedupe(
		items
			.map((item: any) => {
				const id = modelIdOfListItem(item);
				if (!id) return "";
				// Some /models lists carry metadata inline (OpenRouter, Vercel,
				// Gemini, ...). Capture it so callers can show details without an
				// extra round-trip per model.
				const info = parseModelListItem(item);
				if (info) infoById.set(id, info);
				return id;
			})
			.filter(Boolean),
	).sort((a, b) => a.localeCompare(b));
	return { ids, infoById, baseUrl: base };
}

/**
 * Probe an OpenAI-compatible base URL for its model list. Adapts to gateways
 * that mount /models at the server root instead of under /v1 (and vice versa);
 * the base URL that actually answered is returned as `baseUrl`.
 *
 * The input is forgiving: a missing scheme, a trailing slash, or a pasted
 * endpoint URL (.../chat/completions, .../models) are all normalized first.
 */
export async function probeModels(baseUrl: string, apiKey?: string): Promise<ProbeResult> {
	const variants = probeBaseVariants(normalizeBaseUrl(baseUrl));

	const failures: ListFailure[] = [];
	const deadOrigins = new Set<string>();
	const deadHosts = new Set<string>();
	let empty: ProbeResult | undefined;

	// Nothing listens on this origin / the name doesn't resolve: another path on
	// the same origin cannot do better.
	const isDead = (base: string) => {
		const url = new URL(base);
		return deadOrigins.has(url.origin) || deadHosts.has(url.hostname);
	};
	// Record one attempt; returns the result when it is the one to hand back.
	const consider = (base: string, attempt: ListAttempt): ProbeResult | undefined => {
		if (attempt.kind === "list") {
			const result = buildProbeResult(attempt.base, attempt.items);
			if (result.ids.length > 0) return result;
			// A valid but empty list: keep it, another variant may be the real one.
			empty ??= result;
			return undefined;
		}
		failures.push(attempt);
		const url = new URL(base);
		if (attempt.network === "dns") deadHosts.add(url.hostname);
		else if (attempt.network === "connect") deadOrigins.add(url.origin);
		return undefined;
	};

	for (let i = 0; i < variants.length; i++) {
		const base = variants[i];
		if (isDead(base)) continue;
		const attempt = await fetchModelsList(base, apiKey);
		const result = consider(base, attempt);
		if (result) return result;
		if (attempt.kind !== "failure" || attempt.network !== "timeout") continue;

		// That variant sat out its whole timeout. Waiting out the others one by
		// one could take several times as long, so the rest are asked at once —
		// and looked at in order, the other origin first: the silence may be
		// specific to this scheme/port.
		const silent = new URL(base).origin;
		const rest = variants.slice(i + 1).filter((variant) => !isDead(variant));
		rest.sort((a, b) => Number(new URL(a).origin === silent) - Number(new URL(b).origin === silent));
		const abandon = new AbortController();
		const pending = rest.map((variant) => fetchModelsList(variant, apiKey, abandon.signal));
		for (const attemptInFlight of pending) attemptInFlight.catch(() => {});
		try {
			for (let j = 0; j < rest.length; j++) {
				const found = consider(rest[j], await pending[j]);
				if (found) return found;
			}
		} finally {
			abandon.abort(); // whatever is still in flight is no longer needed
		}
		break;
	}

	if (empty) return empty;

	let best = failures[0];
	for (const failure of failures) if (failure.rank > best.rank) best = failure;
	if (!best) throw new Error(`Probe failed: no usable base URL in "${baseUrl}"`);
	// For "nothing there" outcomes, say where else we looked.
	const others = dedupe(failures.filter((f) => f !== best).map((f) => f.url)).filter((u) => u !== best.url);
	const suffix = best.rank <= RANK.notApi && others.length > 0 ? ` (also tried ${others.join(", ")})` : "";
	throw new Error(`${best.message}${suffix}`);
}

// ---------------------------------------------------------------------------
// Limits, defaults, formatting
// ---------------------------------------------------------------------------

// Protocol-level fallback limits, applied when the gateway, the catalog, and
// the local rules all say nothing about a model's limits. Reasoning models
// burn far more output than classic 4K-era defaults, so these follow what the
// providers themselves document. Keyed by the pi model `api` flavor.
export const API_FALLBACK_LIMITS: Record<string, { contextWindow: number; maxTokens: number }> = {
	"anthropic-messages": { contextWindow: 200000, maxTokens: 32000 },
	"google-generative-ai": { contextWindow: 1048576, maxTokens: 65536 },
	"openai-completions": { contextWindow: 258000, maxTokens: 32000 },
	"openai-responses": { contextWindow: 258000, maxTokens: 32000 },
};

// Community catalogs often publish degenerate limits for models whose real
// output cap is unknown (maxTokens == contextWindow). Taken at face value that
// squeezes the input budget to zero, so clamp the output to a conservative cap
// and keep at least 3/4 of the window for input.
export const MAX_OUTPUT_TOKEN_CAP = 32000;

export function normalizeModelLimits(contextWindow: number, maxTokens: number): { contextWindow: number; maxTokens: number } {
	if (contextWindow <= 0 || maxTokens < contextWindow) return { contextWindow, maxTokens };
	return {
		contextWindow,
		maxTokens: Math.min(MAX_OUTPUT_TOKEN_CAP, Math.max(1, Math.floor(contextWindow / 4))),
	};
}

// Field defaults applied when neither the gateway nor the local rules say
// anything: reasoning on (most current models think), image and video input
// off (opt-in). contextWindow has no default. Developer-role support is a
// gateway-level probe and defaults to false as well (see developer-role.ts).
export const MODEL_INFO_DEFAULTS = { image: false, video: false, reasoning: true } as const;

// Fill still-unknown fields from MODEL_INFO_DEFAULTS, tagging them in
// defaultedFields. Detected and local-rule values always win.
export function applyModelDefaults(info: ModelProbeInfo | undefined): ModelProbeInfo {
	const out: ModelProbeInfo = { ...(info ?? {}) };
	const defaulted: NonNullable<ModelProbeInfo["defaultedFields"]> = [...(info?.defaultedFields ?? [])];
	if (out.image === undefined) {
		out.image = MODEL_INFO_DEFAULTS.image;
		defaulted.push("image");
	}
	if (out.video === undefined) {
		out.video = MODEL_INFO_DEFAULTS.video;
		defaulted.push("video");
	}
	if (out.reasoning === undefined) {
		out.reasoning = MODEL_INFO_DEFAULTS.reasoning;
		defaulted.push("reasoning");
	}
	if (defaulted.length > 0) out.defaultedFields = defaulted;
	const sources = getMetadataProvenance(info);
	for (const field of ["image", "video", "reasoning"] as const) if (info?.[field] === undefined) sources[field] = { source: "default", match: "default", infer: true };
	return withMetadataProvenance(out, sources);
}

// Human-readable list of the metadata fields actually present in a probe
// result. Default-filled fields don't count — they carry no information.
export function probeInfoSummary(info: ModelProbeInfo | undefined): string[] {
	if (!info) return [];
	const defaulted = new Set(info.defaultedFields ?? []);
	const parts: string[] = [];
	if (info.contextWindow !== undefined && !defaulted.has("contextWindow")) parts.push("context");
	if (info.maxTokens !== undefined && !defaulted.has("maxTokens")) parts.push("maxTokens");
	if (info.reasoning !== undefined && !defaulted.has("reasoning")) parts.push("reasoning");
	if (info.image !== undefined && !defaulted.has("image")) parts.push("image");
	if (info.video !== undefined && !defaulted.has("video")) parts.push("video");
	if (info.cost !== undefined) parts.push("cost");
	return parts;
}

// Whether a probe result carries anything worth surfacing (including gateway
// endpoint types, which don't count as "detected metadata" for the summary).
function hasProbeInfo(info: ModelProbeInfo | undefined): boolean {
	if (!info) return false;
	return (
		probeInfoSummary(info).length > 0 ||
		(info.endpointTypes !== undefined && info.endpointTypes.length > 0) ||
		info.alwaysThinking !== undefined ||
		(info.effortOptions !== undefined && info.effortOptions.length > 0)
	);
}

export function describeProbeInfo(info: ModelProbeInfo | undefined): string | undefined {
	if (!info) return undefined;
	const defaulted = new Set(info.defaultedFields ?? []);
	const tag = (field: MetadataField) => {
		if (info.inferredFields?.some((value) => value === field)) return " [local rules]";
		const label = getMetadataSourceLabel(info, field);
		return label === "gateway" || label === "default" ? "" : ` [${label}]`;
	};
	const parts: string[] = [];
	// Limit fields filled by the api fallback (tagged defaulted) carry no real
	// information about the model — don't show them.
	if (info.contextWindow !== undefined && !defaulted.has("contextWindow")) parts.push(`ctx ${info.contextWindow}${tag("contextWindow")}`);
	if (info.maxTokens !== undefined && !defaulted.has("maxTokens")) parts.push(`max-out ${info.maxTokens}${tag("maxTokens")}`);
	// Only values that differ from the defaults (image/video: false,
	// reasoning: true) are worth showing — a model with default values gets
	// no tag at all, even if the default was really detected (e.g. probed
	// "no image input").
	if (info.image === true) parts.push(`image${tag("image")}`);
	if (info.video === true) parts.push(`video${tag("video")}`);
	if (info.reasoning === false) parts.push(`no reasoning${tag("reasoning")}`);
	else if (info.reasoning === true && info.alwaysThinking) parts.push(`reasoning (always on)${tag("reasoning")}`);
	if (info.reasoning !== false && info.effortOptions?.length) parts.push(`effort ${info.effortOptions.join("/")}${tag("effortOptions")}`);
	if (info.cost) parts.push(`$${info.cost.input}/$${info.cost.output} per 1M${tag("cost")}`);
	if (info.endpointTypes && info.endpointTypes.length > 0) parts.push(info.endpointTypes.join("/"));
	return parts.length > 0 ? parts.join(" • ") : undefined;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const roundRate = (value: number) => Math.round(value * 1e6) / 1e6;

// Build per-1M-token cost rates (pi / models.dev convention). Missing cache
// rates default to 0, matching pi's builtin catalogs; an entry with neither
// input nor output price carries no information and is skipped. Values are
// rounded to 6 decimals so 4.4e-7 * 1e6 doesn't surface as 0.44000000000000006.
function costPerMillion(input?: number, output?: number, cacheRead?: number, cacheWrite?: number, scale = 1): ModelCostInfo | undefined {
	if (input === undefined && output === undefined) return undefined;
	const rate = (v: number | undefined) => roundRate((v ?? 0) * scale);
	return { input: rate(input), output: rate(output), cacheRead: rate(cacheRead), cacheWrite: rate(cacheWrite) };
}

// LiteLLM reports USD per token.
function costFromPerToken(input?: number, output?: number, cacheRead?: number, cacheWrite?: number): ModelCostInfo | undefined {
	return costPerMillion(input, output, cacheRead, cacheWrite, 1e6);
}

// A price: a non-negative finite number, possibly stringified. Negative
// values are placeholders (OpenRouter's router entries publish "-1").
function priceValue(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// No model costs anywhere near $1000 per 1M tokens, so a "per token" price
// above this is really a per-1M price in disguise.
const MAX_PLAUSIBLE_PER_TOKEN_PRICE = 0.001;

// Inline pricing on /models entries, normalized to USD per 1M tokens. Sources
// whose unit is explicit come first; the ambiguous `pricing` object last.
function parseInlinePricing(item: any): ModelCostInfo | undefined {
	// Chutes: price.{input, output, input_cache_read}.usd — USD per 1M.
	const price = item?.price;
	if (price && typeof price === "object") {
		const cost = costPerMillion(priceValue(price.input?.usd), priceValue(price.output?.usd), priceValue(price.input_cache_read?.usd));
		if (cost) return cost;
	}
	// DeepInfra: metadata.pricing.{input_tokens, output_tokens} — USD per 1M.
	const metaPricing = item?.metadata?.pricing;
	if (metaPricing && typeof metaPricing === "object") {
		const cost = costPerMillion(priceValue(metaPricing.input_tokens), priceValue(metaPricing.output_tokens), priceValue(metaPricing.cache_read_tokens));
		if (cost) return cost;
	}
	// Venice: model_spec.pricing.{input, output, cache_input}.usd — USD per 1M.
	const specPricing = item?.model_spec?.pricing;
	if (specPricing && typeof specPricing === "object") {
		const cost = costPerMillion(priceValue(specPricing.input?.usd), priceValue(specPricing.output?.usd), priceValue(specPricing.cache_input?.usd));
		if (cost) return cost;
	}
	// models.dev-shaped lists — USD per 1M: cost.{input, output, cache_read,
	// cache_write}, or OpenCode Zen's cost.text.{input: {price, cache}, output: {price}}.
	const cost = item?.cost;
	if (cost && typeof cost === "object") {
		const text = cost.text && typeof cost.text === "object" ? cost.text : undefined;
		const parsed = text
			? costPerMillion(priceValue(text.input?.price), priceValue(text.output?.price), priceValue(text.input?.cache?.read), priceValue(text.input?.cache?.write))
			: costPerMillion(priceValue(cost.input), priceValue(cost.output), priceValue(cost.cache_read), priceValue(cost.cache_write));
		if (parsed) return parsed;
	}

	const pricing = item?.pricing;
	if (!pricing || typeof pricing !== "object") return undefined;
	// Novita: pricing.{prompt, completion, input_cache_read}.price_per_m_decimal — USD per 1M.
	const novita = costPerMillion(
		priceValue(pricing.prompt?.price_per_m_decimal),
		priceValue(pricing.completion?.price_per_m_decimal),
		priceValue(pricing.input_cache_read?.price_per_m_decimal),
	);
	if (novita) return novita;
	// pricing.{prompt, completion} / pricing.{input, output} are used with two
	// units: OpenRouter, Cerebras and Vercel publish USD per TOKEN, Together
	// and others USD per 1M under the very same names. The magnitude tells
	// them apart.
	const input = priceValue(pricing.prompt) ?? priceValue(pricing.input);
	const output = priceValue(pricing.completion) ?? priceValue(pricing.output);
	if (input === undefined && output === undefined) return undefined;
	const perMillion = Math.max(input ?? 0, output ?? 0) > MAX_PLAUSIBLE_PER_TOKEN_PRICE;
	return costPerMillion(
		input,
		output,
		priceValue(pricing.input_cache_read) ?? priceValue(pricing.cache_read),
		priceValue(pricing.input_cache_write) ?? priceValue(pricing.cache_write),
		perMillion ? 1 : 1e6,
	);
}

// ---------------------------------------------------------------------------
// Inline metadata on list entries / model detail objects
// ---------------------------------------------------------------------------

function lowerStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
}

const includesAny = (list: string[], ...names: string[]) => names.some((name) => list.includes(name));

// One API / New API gateways (and their forks) attach extra model metadata
// under "meta": { context_window, capabilities: { vision, reasoning, ... },
// supports_vision, supports_reasoning }. Fills only fields that are still
// unknown, so OpenRouter/OpenAI-style data wins when both exist.
function parseGatewayMetaFields(source: any, info: ModelProbeInfo): void {
	const meta = source?.meta;
	if (!meta || typeof meta !== "object") return;
	if (info.contextWindow === undefined) {
		const contextWindow = firstFiniteNumber(meta, "context_window", "max_input_tokens");
		if (contextWindow !== undefined) info.contextWindow = contextWindow;
	}
	if (info.maxTokens === undefined) {
		const maxTokens = firstFiniteNumber(meta, "max_output_tokens", "max_tokens");
		if (maxTokens !== undefined) info.maxTokens = maxTokens;
	}
	const capabilities = meta.capabilities;
	if (capabilities && typeof capabilities === "object") {
		if (info.image === undefined && typeof capabilities.vision === "boolean") info.image = capabilities.vision;
		if (info.reasoning === undefined && typeof capabilities.reasoning === "boolean") info.reasoning = capabilities.reasoning;
		if (info.reasoning === undefined && typeof capabilities.thinking === "boolean") info.reasoning = capabilities.thinking;
	}
	if (info.image === undefined && typeof meta.supports_vision === "boolean") info.image = meta.supports_vision;
	if (info.reasoning === undefined && typeof meta.supports_reasoning === "boolean") info.reasoning = meta.supports_reasoning;
}

// Context window / max output. Each gateway family has its own spelling.
function parseLimits(item: any, info: ModelProbeInfo): void {
	const contextWindow = firstFiniteNumber(
		item,
		"context_length", // OpenRouter, Venice, Chutes, Moonshot
		"context_window", // Groq, Vercel
		"max_input_tokens", // Anthropic-style lists
		"inputTokenLimit", // Gemini native
		"context_size", // Novita
		"max_context_length", // Mistral
		"max_model_len", // vLLM / SGLang
		"limit.context", // models.dev-shaped lists (OpenCode Zen)
		"limits.max_context_length", // Cerebras
		"metadata.context_length", // DeepInfra
		"model_spec.availableContextTokens", // Venice
	);
	if (contextWindow !== undefined) info.contextWindow = contextWindow;

	const maxTokens = firstFiniteNumber(
		item,
		"max_output_tokens",
		"max_completion_tokens", // Groq
		"outputTokenLimit", // Gemini native
		"max_output_length", // Chutes
		"top_provider.max_completion_tokens", // OpenRouter
		"limit.output",
		"limits.max_completion_tokens",
		"model_spec.maxCompletionTokens",
	);
	if (maxTokens !== undefined) {
		info.maxTokens = maxTokens;
		return;
	}
	// A bare "max_tokens" means max OUTPUT on some gateways (Vercel, Anthropic)
	// and is a copy of the context window on others (DeepInfra, embeddings).
	// Only trust it when it is clearly smaller than the window.
	const ambiguous = firstFiniteNumber(item, "max_tokens", "metadata.max_tokens");
	if (ambiguous !== undefined && info.contextWindow !== undefined && ambiguous < info.contextWindow) info.maxTokens = ambiguous;
}

// Image / video input.
function parseInputModalities(item: any, info: ModelProbeInfo): void {
	const modalities =
		lowerStrings(item.architecture?.input_modalities) ?? // OpenRouter, Hugging Face
		lowerStrings(item.modalities) ??
		lowerStrings(item.modalities?.input) ?? // Vercel, models.dev-shaped lists
		lowerStrings(item.input_modalities); // Chutes, Novita
	if (modalities) {
		info.image = modalities.includes("image");
		info.video = modalities.includes("video");
	}

	const capabilities = item.capabilities;
	const capabilityList = lowerStrings(capabilities);
	if (capabilityList) {
		if (info.image === undefined) info.image = includesAny(capabilityList, "vision", "image_input");
	} else if (capabilities && typeof capabilities === "object") {
		// Cerebras / Mistral: { vision: true }; Anthropic / Kimi: { vision | image_input: { supported } }.
		for (const key of ["vision", "image_input"]) {
			const value = capabilities[key];
			const flag = typeof value === "boolean" ? value : typeof value?.supported === "boolean" ? value.supported : undefined;
			if (info.image === undefined && flag !== undefined) info.image = flag;
		}
	}

	const spec = item.model_spec?.capabilities; // Venice
	if (spec && typeof spec === "object") {
		if (info.image === undefined && typeof spec.supportsVision === "boolean") info.image = spec.supportsVision;
		if (info.video === undefined && typeof spec.supportsVideoInput === "boolean") info.video = spec.supportsVideoInput;
	}

	for (const key of ["supports_vision", "supports_image_in"]) {
		if (info.image === undefined && typeof item[key] === "boolean") info.image = item[key];
	}
	if (info.video === undefined && typeof item.supports_video_in === "boolean") info.video = item.supports_video_in;

	// Tag lists only ever prove presence — a missing tag proves nothing.
	const tags = [...(lowerStrings(item.tags) ?? []), ...(lowerStrings(item.metadata?.tags) ?? [])];
	if (info.image === undefined && includesAny(tags, "vision", "vlm", "image-input")) info.image = true;
	if (info.video === undefined && includesAny(tags, "video-input")) info.video = true;
}

const REASONING_NAMES = ["reasoning", "thinking", "include_reasoning", "reasoning_effort"];

// Lists that enumerate everything a model accepts, and the entries that show a
// list really is of that kind. Only such a list can prove a negative: when it
// has no reasoning entry the model does not reason. An unrelated array that
// merely shares the key name proves nothing.
const EXHAUSTIVE_LISTS: Array<{ key: string; markers: string[] }> = [
	// OpenRouter / Vercel: request parameters the model accepts.
	{ key: "supported_parameters", markers: ["temperature", "max_tokens", "top_p", "tools", "stop"] },
	// Chutes.
	{ key: "supported_features", markers: ["tools", "json_mode", "structured_outputs", "function_calling"] },
	// Novita.
	{ key: "features", markers: ["function-calling", "structured-outputs", "function_calling", "structured_outputs", "serverless"] },
];

// Whether the model reasons.
function parseReasoning(item: any, info: ModelProbeInfo): void {
	if (typeof item.reasoning === "boolean") info.reasoning = item.reasoning;
	// Gemini native lists flag thinking models with "thinking": true.
	else if (typeof item.thinking === "boolean") info.reasoning = item.thinking;
	else if (typeof item.supports_reasoning === "boolean") info.reasoning = item.supports_reasoning;
	if (info.reasoning !== undefined) return;

	const capabilities = item.capabilities;
	const capabilityList = lowerStrings(capabilities);
	if (capabilityList) {
		info.reasoning = includesAny(capabilityList, "thinking", "reasoning");
		return;
	}
	if (capabilities && typeof capabilities === "object") {
		for (const key of ["reasoning", "thinking"]) {
			const value = capabilities[key];
			const flag = typeof value === "boolean" ? value : typeof value?.supported === "boolean" ? value.supported : undefined;
			if (flag !== undefined) {
				info.reasoning = flag;
				return;
			}
		}
	}

	const spec = item.model_spec?.capabilities; // Venice
	if (spec && typeof spec === "object" && typeof spec.supportsReasoning === "boolean") {
		info.reasoning = spec.supportsReasoning;
		return;
	}

	for (const { key, markers } of EXHAUSTIVE_LISTS) {
		const list = lowerStrings(item[key]);
		if (!list || list.length === 0) continue;
		if (includesAny(list, ...REASONING_NAMES)) {
			info.reasoning = true;
			return;
		}
		if (includesAny(list, ...markers)) {
			info.reasoning = false;
			return;
		}
	}

	// Tag lists only ever prove presence.
	const tags = [...(lowerStrings(item.tags) ?? []), ...(lowerStrings(item.metadata?.tags) ?? [])];
	if (includesAny(tags, ...REASONING_NAMES)) info.reasoning = true;
}

// Inline metadata carried by /models list entries and GET /models/{id}
// objects. Returns undefined when the entry is bare.
function parseModelListItem(item: any): ModelProbeInfo | undefined {
	if (!item || typeof item !== "object") return undefined;
	const info: ModelProbeInfo = {};

	parseLimits(item, info);
	parseReasoning(item, info);
	if (info.reasoning !== false && Array.isArray(item.effort?.supported_levels)) {
		const levels = item.effort.supported_levels.filter((level: unknown): level is string => typeof level === "string" && level.trim() !== "");
		if (levels.length) {
			info.effortOptions = [...new Set<string>(levels)];
			info.reasoning = true;
		}
	}
	parseInputModalities(item, info);

	// New API's /v1/models entries carry supported_endpoint_types
	// (e.g. ["chat"] or ["chat", "embeddings"]).
	if (Array.isArray(item.supported_endpoint_types)) {
		const types = item.supported_endpoint_types.filter((t: unknown): t is string => typeof t === "string");
		if (types.length > 0) info.endpointTypes = types;
	}

	const cost = parseInlinePricing(item);
	if (cost) info.cost = cost;

	parseGatewayMetaFields(item, info);

	return hasProbeInfo(info) ? info : undefined;
}

// Metadata from GET /models/{id} (OpenAI and compatible servers). The detail
// object is read like a list entry, plus the richer reasoning descriptor some
// servers publish only here.
function parseOpenAIModelDetail(json: any): ModelProbeInfo | undefined {
	if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
	const info: ModelProbeInfo = parseModelListItem(json) ?? {};

	const reasoning = json.capabilities?.reasoning;
	if (reasoning && typeof reasoning === "object") {
		const type = typeof reasoning.type === "string" ? reasoning.type : "";
		if (type === "none") {
			info.reasoning = false;
		} else if (type === "minimal") {
			// Thinking exists but cannot be turned off.
			info.reasoning = true;
			info.alwaysThinking = true;
		} else if (type === "effort") {
			info.reasoning = true;
			if (Array.isArray(reasoning.effort_options)) {
				info.effortOptions = reasoning.effort_options.filter((option: unknown): option is string => typeof option === "string");
			}
		}
	}

	return hasProbeInfo(info) ? info : undefined;
}

// ---------------------------------------------------------------------------
// Gateway-wide sources
// ---------------------------------------------------------------------------

// Several entries can describe one model (LiteLLM lists every deployment of a
// load-balanced group separately). The first entry wins per field; later ones
// only fill what is still missing — a sparse second deployment must not wipe
// out what the first one reported.
function mergeMissingFields(out: Map<string, ModelProbeInfo>, name: string, parsed: ModelProbeInfo): void {
	const existing = out.get(name);
	if (!existing) {
		out.set(name, parsed);
		return;
	}
	for (const [key, value] of Object.entries(parsed)) {
		if ((existing as any)[key] === undefined && value !== undefined) (existing as any)[key] = value;
	}
}

async function getJson(url: string, apiKey: string | undefined, headers = JSON_HEADERS): Promise<any | undefined> {
	try {
		const res = await authedRequest(url, apiKey, { headers });
		if (!res.ok) return undefined;
		return parseJsonBody(res.body)?.value;
	} catch {
		return undefined; // best effort
	}
}

// The server root (LiteLLM mounts its management endpoints there) followed by
// the base URL itself.
function rootsOf(baseUrl: string): string[] {
	const trimmed = baseUrl.replace(/\/+$/, "");
	try {
		return dedupe([new URL(baseUrl).origin, trimmed]);
	} catch {
		return [trimmed];
	}
}

// Metadata from a LiteLLM proxy's GET /model_group/info — like /model/info
// but mounted at the server root (/v1/model_group/info is 404), keyed by
// model_group, with per-group capability fields.
function parseModelGroupInfo(json: any, out: Map<string, ModelProbeInfo>): boolean {
	if (!json || typeof json !== "object") return false;
	const entries = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
	let found = false;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const name = typeof entry.model_group === "string" ? entry.model_group.trim() : "";
		if (!name) continue;
		const parsed: ModelProbeInfo = {};
		const contextWindow = firstFiniteNumber(entry, "max_input_tokens", "context_window");
		if (contextWindow !== undefined) parsed.contextWindow = contextWindow;
		const maxTokens = firstFiniteNumber(entry, "max_output_tokens", "max_tokens");
		if (maxTokens !== undefined) parsed.maxTokens = maxTokens;
		if (typeof entry.supports_vision === "boolean") parsed.image = entry.supports_vision;
		if (typeof entry.supports_reasoning === "boolean") parsed.reasoning = entry.supports_reasoning;
		if (probeInfoSummary(parsed).length > 0) {
			mergeMissingFields(out, name, parsed);
			found = true;
		}
	}
	return found;
}

// Fetch LiteLLM /model_group/info (requires an api key). The endpoint lives at
// the server root, so we try the baseUrl's origin first, then the baseUrl.
export async function enrichLiteLLMModelGroupInfo(
	baseUrl: string,
	apiKey: string | undefined,
): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	if (!apiKey) return out;
	for (const root of rootsOf(baseUrl)) {
		const json = await getJson(`${root}/model_group/info`, apiKey);
		if (parseModelGroupInfo(json, out)) return out;
	}
	return out;
}

// New API-style site model catalog: GET {site}/api/models/public (no auth
// needed) returns authoritative context_window for every published model —
// more reliable than LiteLLM's /model/info (which often has max_input_tokens
// null).
function parsePublicModelList(json: any, out: Map<string, ModelProbeInfo>): boolean {
	const entries = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
	if (!entries) return false;
	let found = false;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const name =
			typeof entry.litellm_model_name === "string"
				? entry.litellm_model_name.trim()
				: typeof entry.model_name === "string"
					? entry.model_name.trim()
					: typeof entry.id === "string"
						? entry.id.trim()
						: "";
		if (!name) continue;
		if (entry.status === "draft" || entry.status === "archived" || entry.is_visible === false) continue;
		const parsed: ModelProbeInfo = {};
		const contextWindow = firstFiniteNumber(entry, "context_window", "contextWindow", "max_input_tokens");
		if (contextWindow !== undefined) parsed.contextWindow = contextWindow;
		const maxTokens = firstFiniteNumber(entry, "max_output_tokens", "maxTokens", "max_tokens");
		if (maxTokens !== undefined) parsed.maxTokens = maxTokens;
		// Best effort: some catalogs also publish capability flags.
		if (typeof entry.supports_vision === "boolean") parsed.image = entry.supports_vision;
		if (typeof entry.supports_reasoning === "boolean") parsed.reasoning = entry.supports_reasoning;
		if (probeInfoSummary(parsed).length > 0) {
			mergeMissingFields(out, name, parsed);
			found = true;
		}
	}
	return found;
}

// Fetch the site's public model catalog. The catalog lives on the site root,
// not the api host — for api.llm.example.edu.cn we also try llm.example.edu.cn.
export async function enrichPublicModelInfo(baseUrl: string): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	const roots: string[] = [];
	try {
		const url = new URL(baseUrl);
		roots.push(url.origin);
		// api.llm.example.edu.cn -> llm.example.edu.cn (same domain, site root)
		if (/^api\./i.test(url.hostname) && !isLocalHost(url.hostname)) roots.push(`https://${url.hostname.replace(/^api\./i, "")}`);
	} catch {
		roots.push(baseUrl.replace(/\/+$/, ""));
	}
	for (const root of dedupe(roots)) {
		try {
			// No credentials: the catalog is public, and the site root is not the API host.
			const res = await request(`${root}/api/models/public`, { headers: { accept: "application/json" } });
			if (!res.ok) continue;
			if (parsePublicModelList(parseJsonBody(res.body)?.value, out)) return out;
		} catch {
			// try the next candidate root
		}
	}
	return out;
}

// Metadata from a LiteLLM proxy's GET /model/info — one call returns
// model_info for every configured model (context_window, max_tokens,
// supports_vision, supports_reasoning, ...). Returns true when the response
// looked like a LiteLLM /model/info payload and filled at least one entry.
function parseLiteLLMModelInfo(json: any, out: Map<string, ModelProbeInfo>): boolean {
	if (!json || typeof json !== "object") return false;
	// /model/info returns { data: [...] }; tolerate a nested { data: { data: [...] } }
	const entries = Array.isArray(json.data) ? json.data : Array.isArray(json?.data?.data) ? json.data.data : [];
	let found = false;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const name = typeof entry.model_name === "string" ? entry.model_name.trim() : "";
		const info = entry.model_info;
		if (!name || !info || typeof info !== "object") continue;
		const parsed: ModelProbeInfo = {};
		const contextWindow = firstFiniteNumber(info, "context_window", "max_input_tokens");
		if (contextWindow !== undefined) parsed.contextWindow = contextWindow;
		const maxTokens = firstFiniteNumber(info, "max_output_tokens", "max_tokens");
		if (maxTokens !== undefined) parsed.maxTokens = maxTokens;
		if (typeof info.supports_vision === "boolean") parsed.image = info.supports_vision;
		if (typeof info.supports_reasoning === "boolean") parsed.reasoning = info.supports_reasoning;
		// LiteLLM reports costs per token (input_cost_per_token, ...).
		const cost = costFromPerToken(
			firstFiniteNumber(info, "input_cost_per_token"),
			firstFiniteNumber(info, "output_cost_per_token"),
			firstFiniteNumber(info, "cache_read_input_token_cost"),
			firstFiniteNumber(info, "cache_creation_input_token_cost"),
		);
		if (cost) parsed.cost = cost;
		if (probeInfoSummary(parsed).length > 0) {
			mergeMissingFields(out, name, parsed);
			found = true;
		}
	}
	return found;
}

// LiteLLM proxy: GET /model/info returns metadata for every model in one
// call, which is far cheaper than per-model fetches (and LiteLLM's
// /models/{id} has no metadata at all). The endpoint is mounted at the
// server root (/v1/model/info is 404 on LiteLLM), so try the baseUrl's
// origin first, then the baseUrl itself.
export async function enrichLiteLLMModelInfo(
	baseUrl: string,
	apiKey: string | undefined,
): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	for (const root of rootsOf(baseUrl)) {
		const json = await getJson(`${root}/model/info`, apiKey);
		if (parseLiteLLMModelInfo(json, out)) return out;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Per-model details
// ---------------------------------------------------------------------------

// Run `task` over `ids`, PROBE_CONCURRENCY at a time. Between waves `giveUp`
// decides — with every result of the finished wave in hand — whether the
// rest is worth asking.
async function inWaves(ids: string[], task: (id: string) => Promise<void>, giveUp: () => boolean): Promise<void> {
	for (let start = 0; start < ids.length && !giveUp(); start += PROBE_CONCURRENCY) {
		await Promise.all(ids.slice(start, start + PROBE_CONCURRENCY).map(task));
	}
}

const DETAIL_FIELDS = ["contextWindow", "maxTokens", "image", "video", "reasoning", "cost", "alwaysThinking", "effortOptions"] as const;

// Whether a detail response says anything the caller didn't already know.
function addsInformation(info: ModelProbeInfo, known: ModelProbeInfo | undefined): boolean {
	if (!known) return true;
	return DETAIL_FIELDS.some((field) => info[field] !== undefined && JSON.stringify(info[field]) !== JSON.stringify(known[field]));
}

// Most gateways answer GET /models/{id} with a bare object, a 404, or not at
// all. Once this many requests came back with nothing new, the rest of the
// list is not asked.
const DETAIL_GIVE_UP_AFTER = 2 * PROBE_CONCURRENCY;

/**
 * Fetch GET /models/{id} for each model to learn context_window and
 * capabilities. Best effort: servers that don't expose per-model details
 * simply leave those fields unset.
 *
 * `known` is what the caller already has per model (inline list metadata);
 * it lets the probe stop early on gateways whose detail objects only repeat
 * the list.
 */
export async function enrichOpenAIModelDetails(
	baseUrl: string,
	apiKey: string | undefined,
	ids: string[],
	known?: Map<string, ModelProbeInfo>,
): Promise<Map<string, ModelProbeInfo>> {
	const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const out = new Map<string, ModelProbeInfo>();
	let finished = 0;
	let useful = 0;
	let unanswered = 0;
	let rateLimited = false;

	await inWaves(
		ids,
		async (id) => {
			try {
				const res = await authedRequest(new URL(`models/${encodeURIComponent(id)}`, base).toString(), apiKey, { headers: JSON_HEADERS });
				if (res.status === 429) {
					rateLimited = true;
				} else if (res.ok) {
					const info = parseOpenAIModelDetail(parseJsonBody(res.body)?.value);
					if (info) {
						out.set(id, info);
						if (addsInformation(info, known?.get(id))) useful++;
					}
				}
			} catch {
				unanswered++; // timeout or connection failure
			}
			finished++;
		},
		// Stop when told to back off, when a whole wave got no answer at all, or
		// when the answers so far taught nothing: no per-model details here.
		() => rateLimited || (useful === 0 && (unanswered >= PROBE_CONCURRENCY || finished >= DETAIL_GIVE_UP_AFTER)),
	);
	return out;
}

// Derive the native Ollama API root from an OpenAI-compatible baseUrl
// (http://host:11434/v1 -> http://host:11434).
function ollamaNativeRoot(baseUrl: string): string | null {
	try {
		const url = new URL(baseUrl);
		const pathname = url.pathname.replace(/\/+$/, "");
		return `${url.origin}${pathname.toLowerCase().endsWith("/v1") ? pathname.slice(0, -3) : pathname}`;
	} catch {
		return null;
	}
}

function parseOllamaCapabilities(capabilities: unknown, info: ModelProbeInfo): void {
	const list = lowerStrings(capabilities);
	if (!list) return;
	info.image = list.includes("vision");
	info.reasoning = list.includes("thinking");
}

// A Modelfile "PARAMETER num_ctx N" is the context the model actually runs
// with — smaller than (and overriding) the architecture's maximum.
function ollamaConfiguredContext(parameters: unknown): number | undefined {
	if (typeof parameters !== "string") return undefined;
	const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
	const value = match ? Number(match[1]) : Number.NaN;
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

// Ollama exposes native metadata: GET /api/tags (capabilities) and
// POST /api/show (context_length via model_info, capabilities, parameters).
export async function enrichOllamaModelDetails(
	baseUrl: string,
	apiKey: string | undefined,
	ids: string[],
): Promise<Map<string, ModelProbeInfo>> {
	const root = ollamaNativeRoot(baseUrl);
	if (!root) return new Map();
	const out = new Map<string, ModelProbeInfo>();
	const headers: Record<string, string> = { accept: "application/json" };

	const tags = await getJson(`${root}/api/tags`, apiKey, headers);
	for (const model of Array.isArray(tags?.models) ? tags.models : []) {
		const name = typeof model?.name === "string" ? model.name.trim() : "";
		if (!name) continue;
		const info: ModelProbeInfo = {};
		parseOllamaCapabilities(model.capabilities, info);
		if (Object.keys(info).length > 0) out.set(name, info);
	}

	let failures = 0;
	let successes = 0;
	await inWaves(
		ids,
		async (id) => {
			try {
				const res = await authedRequest(`${root}/api/show`, apiKey, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json" },
					// "model" is the current parameter name, "name" the one older servers read.
					body: JSON.stringify({ model: id, name: id }),
				});
				const json = res.ok ? parseJsonBody(res.body)?.value : undefined;
				if (!json || typeof json !== "object") {
					failures++;
					return;
				}
				successes++;
				const info: ModelProbeInfo = { ...(out.get(id) ?? {}) };
				const modelInfo = json.model_info;
				if (modelInfo && typeof modelInfo === "object") {
					for (const [key, value] of Object.entries(modelInfo)) {
						if (key.endsWith(".context_length") && typeof value === "number" && value > 0) info.contextWindow = value;
					}
				}
				const configured = ollamaConfiguredContext(json.parameters);
				if (configured !== undefined) info.contextWindow = configured;
				parseOllamaCapabilities(json.capabilities, info);
				out.set(id, info);
			} catch {
				failures++;
			}
		},
		// Not an Ollama server (or it is down): don't ask about every model.
		() => successes === 0 && failures >= PROBE_CONCURRENCY,
	);
	return out;
}
