// models.dev as a metadata source: provider catalog (which API sites exist,
// their base URLs) and per-provider model metadata (context window, image,
// video, reasoning, effort options).
//
// In the metadata priority order models.dev sits ABOVE the local known-model
// rules: a catalog entry is curated per-model data, while a rule is a regex
// guess. Detected > models.dev > local rule > default. Fields filled from
// here are tagged in modelsDevFields.
//
// Data comes from the official models.dev SDK (@opencode-ai/models), three
// sources in order:
//   1. live API (GET https://models.dev/api.json) — real-time
//   2. the latest published SDK snapshot, served from the jsDelivr npm CDN —
//      at most ~24h stale, cached on disk per day; this is the freshness path
//      for networks where models.dev itself is unreachable but the CDN is not
//   3. the snapshot bundled inside the installed SDK — works fully offline
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Models } from "@opencode-ai/models";
import type { Model, ProviderMap } from "@opencode-ai/models";
import { normalizeModelLimits } from "./probe.ts";
import { normalizeModelIdCandidates } from "./known-models.ts";
import { PROBE_TIMEOUT_MS } from "./types.ts";
import type { ModelProbeInfo } from "./types.ts";

export type ModelsDevProvider = {
	id: string;
	name: string;
	baseUrl: string;
	env: string[];
	doc?: string;
};

// Providers whose api field is implicit (their ai-sdk package hardcodes the
// endpoint, so the catalog omits it). These mirror the SDK defaults.
// Providers that need account-specific URLs (Azure, Bedrock, Cloudflare AI
// Gateway, ...) or aren't OpenAI-compatible (Anthropic, Google) have no entry.
const DEFAULT_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	groq: "https://api.groq.com/openai/v1",
	mistral: "https://api.mistral.ai/v1",
	xai: "https://api.x.ai/v1",
	cerebras: "https://api.cerebras.ai/v1",
	togetherai: "https://api.together.xyz/v1",
	deepinfra: "https://api.deepinfra.com/v1/openai",
	perplexity: "https://api.perplexity.ai",
	venice: "https://api.venice.ai/api/v1",
	aihubmix: "https://aihubmix.com/v1",
};

// Session cache — one catalog covers every provider and model.
let catalogCache: ProviderMap | null = null;
let catalogPromise: Promise<ProviderMap> | null = null;

// jsDelivr serves the latest published SDK's snapshot.js. Same publisher and
// content as the npm dependency itself, just fresher. Cached in the temp dir
// per UTC day so each day costs at most one ~5MB download.
const SNAPSHOT_CDN_URL = "https://cdn.jsdelivr.net/npm/@opencode-ai/models@latest/dist/snapshot.js";

async function loadLatestSnapshot(): Promise<ProviderMap> {
	const day = new Date().toISOString().slice(0, 10);
	const file = join(tmpdir(), `model-probe-modelsdev-${day}.mjs`);
	if (!existsSync(file)) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS * 2);
		try {
			const response = await fetch(SNAPSHOT_CDN_URL, { headers: { "user-agent": "model-probe" }, signal: controller.signal });
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			const text = await response.text();
			// Guard against CDN error pages; the real check is the import below.
			if (!text.includes("providers")) throw new Error("unexpected snapshot content");
			writeFileSync(file, text);
			// Drop previous days' snapshots.
			for (const old of readdirSync(tmpdir())) {
				if (old.startsWith("model-probe-modelsdev-") && old !== `model-probe-modelsdev-${day}.mjs`) {
					try { unlinkSync(join(tmpdir(), old)); } catch { /* best effort */ }
				}
			}
		} finally {
			clearTimeout(timer);
		}
	}
	const mod = await import(pathToFileURL(file).href);
	const providers = (mod.providers ?? mod.default?.providers) as ProviderMap | undefined;
	if (!providers || Object.keys(providers).length === 0) throw new Error("snapshot had no providers");
	return providers;
}

async function loadCatalog(): Promise<ProviderMap> {
	if (catalogCache) return catalogCache;
	catalogPromise ??= (async () => {
		try {
			const client = Models.make();
			const map = await client.providers({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2) });
			if (!map || Object.keys(map).length === 0) throw new Error("models.dev returned no providers");
			catalogCache = map;
			return map;
		} catch {
			// Live API unreachable — try fresher snapshots before the bundled one.
		}
		try {
			catalogCache = await loadLatestSnapshot();
			return catalogCache;
		} catch {
			// CDN unreachable too — fall back to the SDK's bundled snapshot.
			// Imported dynamically so the ~5MB snapshot is only parsed on this path.
		}
		const snapshot = await import("@opencode-ai/models/snapshot");
		catalogCache = snapshot.providers;
		return catalogCache;
	})();
	return catalogPromise;
}

function toProviderEntry(provider: { id: string; name?: string; api?: string; doc?: string; env?: string[] }): ModelsDevProvider | null {
	const baseUrl = provider.api?.trim() || DEFAULT_BASE_URLS[provider.id];
	if (!baseUrl) return null; // no known endpoint for this provider — skip
	return {
		id: provider.id,
		name: provider.name?.trim() || provider.id,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		env: Array.isArray(provider.env) ? provider.env.filter((v): v is string => typeof v === "string") : [],
		doc: provider.doc,
	};
}

// Pull the fields we track out of one catalog model entry.
function parseModelEntry(model: Model): ModelProbeInfo | undefined {
	const info: ModelProbeInfo = {};

	if (Number.isFinite(model.limit?.context) && model.limit.context > 0) info.contextWindow = model.limit.context;
	if (Number.isFinite(model.limit?.output) && model.limit.output > 0) info.maxTokens = model.limit.output;
	// Data hygiene: catalogs publish degenerate limits (output == context) for
	// models whose real output cap is unknown — clamp before anyone consumes it.
	if (info.contextWindow !== undefined && info.maxTokens !== undefined) {
		const limited = normalizeModelLimits(info.contextWindow, info.maxTokens);
		info.contextWindow = limited.contextWindow;
		info.maxTokens = limited.maxTokens;
	}
	if (Array.isArray(model.modalities?.input)) {
		info.image = model.modalities.input.includes("image");
		info.video = model.modalities.input.includes("video");
	}
	if (typeof model.reasoning === "boolean") info.reasoning = model.reasoning;

	const effort = model.reasoning_options?.find((o) => o.type === "effort");
	if (effort && effort.type === "effort") {
		info.effortOptions = effort.values.filter((v): v is string => typeof v === "string");
	}

	// Catalog list prices, already USD per 1M tokens. Missing cache rates map
	// to 0, matching pi's builtin catalogs.
	const cost = (model as any).cost;
	if (cost && typeof cost === "object") {
		const num = (v: unknown) => (Number.isFinite(v) ? (v as number) : undefined);
		const input = num(cost.input);
		const output = num(cost.output);
		if (input !== undefined || output !== undefined) {
			info.cost = {
				input: input ?? 0,
				output: output ?? 0,
				cacheRead: num(cost.cache_read) ?? 0,
				cacheWrite: num(cost.cache_write) ?? 0,
			};
		}
	}

	return Object.keys(info).length > 0 ? info : undefined;
}

// The provider catalog: id -> { baseUrl, env, ... }. Live API first, bundled
// snapshot as fallback. Cached for the session.
export async function fetchModelsDevProviders(): Promise<Map<string, ModelsDevProvider>> {
	const catalog = await loadCatalog();
	const out = new Map<string, ModelsDevProvider>();
	for (const provider of Object.values(catalog)) {
		if (!provider || typeof provider !== "object") continue;
		const entry = toProviderEntry(provider);
		if (entry) out.set(entry.id, entry);
	}
	if (out.size === 0) throw new Error("models.dev catalog contained no usable providers");
	return out;
}

// Model metadata for one provider, keyed by model id. Empty map when the
// provider id is unknown.
export async function fetchModelsDevModels(providerId: string): Promise<Map<string, ModelProbeInfo>> {
	const catalog = await loadCatalog();
	const out = new Map<string, ModelProbeInfo>();
	const models = catalog[providerId]?.models;
	if (models && typeof models === "object") {
		for (const [id, model] of Object.entries(models)) {
			const info = parseModelEntry(model);
			if (info) out.set(id, info);
		}
	}
	return out;
}

// Two base URLs point at the same provider when host matches and the paths
// agree up to a trailing /v1 (models.dev may list the bare host while the
// probed base was /v1-adapted, or vice versa).
function sameBaseUrl(a: string, b: string): boolean {
	try {
		const ua = new URL(a);
		const ub = new URL(b);
		if (ua.host.toLowerCase() !== ub.host.toLowerCase()) return false;
		const strip = (p: string) => p.replace(/\/+$/, "").replace(/\/v1$/i, "");
		return strip(ua.pathname) === strip(ub.pathname);
	} catch {
		return false;
	}
}

// Catalog-wide id index. Relay gateways (api.88api.ai, ...) are not in the
// catalog, so a base-URL match finds nothing even for a perfectly well-known
// model id. Every catalog model is therefore indexed by id — and by the segment
// after the last "/" for ids like "openai/gpt-6.1-sol" — and each field answers
// with the majority value across every provider that publishes the id: resellers
// republish the maker's numbers, so the mode is the maker's value.
//
// Cost is deliberately NOT taken from this tier: resellers price differently and
// a base-URL match already supplies the real per-host pricing.
type Vote<V> = Map<V, number>;

type IdVotes = {
	contextWindow: Vote<number>;
	maxTokens: Vote<number>;
	image: Vote<boolean>;
	video: Vote<boolean>;
	reasoning: Vote<boolean>;
};

let idIndexCache: Map<string, ModelProbeInfo> | null = null;

function bump<V>(votes: Vote<V>, value: V | undefined): void {
	if (value === undefined) return;
	votes.set(value, (votes.get(value) ?? 0) + 1);
}

// Highest count wins; ties keep the value seen first (catalog order).
function winner<V>(votes: Vote<V>): V | undefined {
	let best: V | undefined;
	let bestCount = 0;
	for (const [value, count] of votes) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

function indexKeys(catalogId: string): string[] {
	const lower = catalogId.trim().toLowerCase();
	if (!lower) return [];
	const keys = new Set<string>([lower]);
	const slash = lower.lastIndexOf("/");
	if (slash > 0 && slash < lower.length - 1) keys.add(lower.slice(slash + 1));
	return [...keys];
}

async function getIdIndex(): Promise<Map<string, ModelProbeInfo>> {
	if (idIndexCache) return idIndexCache;
	const catalog = await loadCatalog();
	const votes = new Map<string, IdVotes>();
	for (const provider of Object.values(catalog)) {
		const models = provider?.models;
		if (!models || typeof models !== "object") continue;
		for (const [catalogId, model] of Object.entries(models)) {
			const info = parseModelEntry(model as Model);
			if (!info) continue;
			for (const key of indexKeys(catalogId)) {
				let entry = votes.get(key);
				if (!entry) {
					entry = {
						contextWindow: new Map(),
						maxTokens: new Map(),
						image: new Map(),
						video: new Map(),
						reasoning: new Map(),
					};
					votes.set(key, entry);
				}
				bump(entry.contextWindow, info.contextWindow);
				bump(entry.maxTokens, info.maxTokens);
				bump(entry.image, info.image);
				bump(entry.video, info.video);
				bump(entry.reasoning, info.reasoning);
			}
		}
	}

	const index = new Map<string, ModelProbeInfo>();
	for (const [key, entry] of votes) {
		const info: ModelProbeInfo = {};
		const contextWindow = winner(entry.contextWindow);
		const maxTokens = winner(entry.maxTokens);
		const image = winner(entry.image);
		const video = winner(entry.video);
		const reasoning = winner(entry.reasoning);
		if (contextWindow !== undefined) info.contextWindow = contextWindow;
		if (maxTokens !== undefined) info.maxTokens = maxTokens;
		if (image !== undefined) info.image = image;
		if (video !== undefined) info.video = video;
		if (reasoning !== undefined) info.reasoning = reasoning;
		if (Object.keys(info).length > 0) index.set(key, info);
	}
	idIndexCache = index;
	return index;
}

// Model metadata looked up by id across the whole catalog, for gateways the
// catalog does not know. Ids are matched through the same normalization chain
// the local rules use, so "bailian/gpt-6.1-sol" still finds "gpt-6.1-sol".
export async function fetchModelsDevInfoByModelIds(ids: string[]): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	if (ids.length === 0) return out;
	let index: Map<string, ModelProbeInfo>;
	try {
		index = await getIdIndex();
	} catch {
		return out; // catalog unreachable — no models.dev tier
	}
	for (const id of ids) {
		for (const candidate of normalizeModelIdCandidates(id)) {
			const info = index.get(candidate);
			if (info) {
				out.set(id, info);
				break;
			}
		}
	}
	return out;
}

// Model metadata for the provider serving this base URL. When `ids` is given,
// any model the host's own catalog entry does not cover is looked up by id
// across the whole catalog — a relay gets real metadata instead of nothing.
export async function fetchModelsDevInfoForBaseUrl(baseUrl: string, ids?: string[]): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	try {
		const providers = await fetchModelsDevProviders();
		for (const provider of providers.values()) {
			if (sameBaseUrl(provider.baseUrl, baseUrl)) {
				for (const [id, info] of await fetchModelsDevModels(provider.id)) out.set(id, info);
				break;
			}
		}
	} catch {
		// catalog unreachable — try the id index alone below
	}
	if (ids && ids.length > 0) {
		const byId = await fetchModelsDevInfoByModelIds(ids.filter((id) => !out.has(id)));
		for (const [id, info] of byId) out.set(id, info);
	}
	return out;
}
