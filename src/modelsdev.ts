// models.dev as a metadata source: provider catalog (which API sites exist,
// their base URLs) and per-provider model metadata (context window, vision,
// reasoning, effort options).
//
// In the metadata priority order models.dev sits ABOVE the local known-model
// rules: a catalog entry is curated per-model data, while a rule is a regex
// guess. Detected > models.dev > local rule > default. Fields filled from
// here are tagged in modelsDevFields.
//
// Data comes from the official models.dev SDK (@opencode-ai/models). The live
// API (GET https://models.dev/api.json) is tried first; when models.dev is
// unreachable (DNS poisoning / TLS resets on some networks) the snapshot
// bundled inside the SDK — at most ~24h behind the live API — is used
// instead, so this tier works fully offline.
import { Models } from "@opencode-ai/models";
import type { Model, ProviderMap } from "@opencode-ai/models";
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

async function loadCatalog(): Promise<ProviderMap> {
	if (catalogCache) return catalogCache;
	try {
		const client = Models.make();
		const map = await client.providers({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2) });
		if (!map || Object.keys(map).length === 0) throw new Error("models.dev returned no providers");
		catalogCache = map;
		return map;
	} catch {
		// Live API unreachable — use the SDK's bundled snapshot. Imported
		// dynamically so the ~5MB snapshot is only parsed on this path.
		const snapshot = await import("@opencode-ai/models/snapshot");
		catalogCache = snapshot.providers;
		return catalogCache;
	}
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
	if (Array.isArray(model.modalities?.input)) info.vision = model.modalities.input.includes("image");
	if (typeof model.reasoning === "boolean") info.reasoning = model.reasoning;

	const effort = model.reasoning_options?.find((o) => o.type === "effort");
	if (effort && effort.type === "effort") {
		info.effortOptions = effort.values.filter((v): v is string => typeof v === "string");
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

// Find the models.dev provider serving this base URL and return its model
// metadata. Empty map when nothing matches or every source is down.
export async function fetchModelsDevInfoForBaseUrl(baseUrl: string): Promise<Map<string, ModelProbeInfo>> {
	try {
		const providers = await fetchModelsDevProviders();
		for (const provider of providers.values()) {
			if (sameBaseUrl(provider.baseUrl, baseUrl)) {
				return await fetchModelsDevModels(provider.id);
			}
		}
	} catch {
		// catalog unreachable — no models.dev tier
	}
	return new Map();
}
