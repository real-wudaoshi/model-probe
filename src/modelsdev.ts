// models.dev as a metadata source: provider catalog (which API sites exist,
// their base URLs) and per-provider model metadata (context window, vision,
// reasoning, effort options).
//
// In the metadata priority order models.dev sits BELOW the local known-model
// rules and ABOVE the built-in defaults: detected > local rule > models.dev >
// default. Fields filled from here are tagged in modelsDevFields.
//
// models.dev is unreachable on some networks (DNS poisoning / TLS resets), so
// there are two sources, tried in order:
//   1. https://models.dev/api.json — the generated catalog, one request
//   2. GitHub mirror — api.github.com lists the data repo's directories and
//      jsDelivr serves the provider/model TOML files
import { PROBE_TIMEOUT_MS } from "./types.ts";
import type { ModelProbeInfo } from "./types.ts";

export type ModelsDevProvider = {
	id: string;
	name: string;
	baseUrl: string;
	env: string[];
	doc?: string;
};

const API_JSON_URL = "https://models.dev/api.json";
const GITHUB_PROVIDERS_URL = "https://api.github.com/repos/sst/models.dev/contents/providers?ref=dev";
const GITHUB_PROVIDER_URL = (id: string) => `https://api.github.com/repos/sst/models.dev/contents/providers/${id}?ref=dev`;
const GITHUB_TREE_URL = (sha: string) => `https://api.github.com/repos/sst/models.dev/git/trees/${sha}?recursive=1`;
const PROVIDER_TOML_URL = (id: string) => `https://cdn.jsdelivr.net/gh/sst/models.dev@dev/providers/${id}/provider.toml`;
const MODEL_TOML_URL = (id: string, file: string) => `https://cdn.jsdelivr.net/gh/sst/models.dev@dev/providers/${id}/models/${file}`;
const MIRROR_CONCURRENCY = 8;

// Providers whose api field is implicit (their ai-sdk package hardcodes the
// endpoint, so provider.toml omits it). These mirror the SDK defaults; the
// api.json source usually carries them explicitly. Providers that need
// account-specific URLs (Azure, Bedrock, Cloudflare AI Gateway, ...) or aren't
// OpenAI-compatible (Anthropic, Google) have no entry.
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

// Session caches. apiJson holds the raw catalog when the primary source
// answered (its model metadata is inline); otherwise the mirror is used.
let apiJson: any = null;
let providersCache: Map<string, ModelsDevProvider> | null = null;
const modelsCache = new Map<string, Map<string, ModelProbeInfo>>();

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			headers: { accept: "application/json", "user-agent": "model-probe" },
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers: { "user-agent": "model-probe" }, signal: controller.signal });
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

// Pull the flat keys we need out of a provider.toml. The files are simple
// (name/env/api/doc plus comments), so a full TOML parser is overkill.
function parseProviderToml(text: string): { name?: string; api?: string; doc?: string; env: string[] } {
	const grab = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
	const envMatch = /^env\s*=\s*\[([^\]]*)\]/m.exec(text);
	const env = envMatch ? [...envMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
	return { name: grab("name"), api: grab("api"), doc: grab("doc"), env };
}

function toProviderEntry(id: string, raw: { name?: string; api?: string; doc?: string; env?: string[] }): ModelsDevProvider | null {
	const baseUrl = raw.api?.trim() || DEFAULT_BASE_URLS[id];
	if (!baseUrl) return null; // no known endpoint for this provider — skip
	return {
		id,
		name: raw.name?.trim() || id,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		env: Array.isArray(raw.env) ? raw.env.filter((v): v is string => typeof v === "string") : [],
		doc: raw.doc,
	};
}

// Parse the fields we track out of one model entry — either an api.json model
// object or a model TOML file. Numbers in TOML may use _ separators
// (context = 400_000).
function parseModelEntry(raw: any): ModelProbeInfo | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const info: ModelProbeInfo = {};

	const context = raw.limit?.context ?? raw.context_window ?? raw.contextWindow;
	if (typeof context === "number" && Number.isFinite(context) && context > 0) info.contextWindow = context;

	const inputModalities = Array.isArray(raw.modalities?.input) ? raw.modalities.input : undefined;
	if (inputModalities) info.vision = inputModalities.includes("image");

	if (typeof raw.reasoning === "boolean") info.reasoning = raw.reasoning;

	// reasoning_options: [{ type = "effort", values = [...] }] (TOML) or the
	// equivalent api.json shape.
	const options = Array.isArray(raw.reasoning_options) ? raw.reasoning_options : [];
	const effort = options.find((o: any) => o && typeof o === "object" && o.type === "effort" && Array.isArray(o.values));
	if (effort) info.effortOptions = effort.values.filter((v: unknown): v is string => typeof v === "string");

	return Object.keys(info).length > 0 ? info : undefined;
}

// TOML model files keep numbers/arrays in sections; reshape the few things we
// need into the api.json-like object parseModelEntry expects.
function parseModelToml(text: string): ModelProbeInfo | undefined {
	const raw: any = {};
	if (/^reasoning\s*=\s*true\s*$/m.test(text)) raw.reasoning = true;
	else if (/^reasoning\s*=\s*false\s*$/m.test(text)) raw.reasoning = false;

	const limitSection = /\[limit\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1] ?? "";
	const contextMatch = /^\s*context\s*=\s*([\d_]+)/m.exec(limitSection);
	if (contextMatch) raw.limit = { context: Number(contextMatch[1].replace(/_/g, "")) };

	const modalitiesSection = /\[modalities\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1] ?? "";
	const inputMatch = /^\s*input\s*=\s*\[([^\]]*)\]/m.exec(modalitiesSection);
	if (inputMatch) raw.modalities = { input: [...inputMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) };

	const optionsMatch = /^reasoning_options\s*=\s*\[(.*)\]/m.exec(text);
	if (optionsMatch) {
		const valuesMatch = /values\s*=\s*\[([^\]]*)\]/.exec(optionsMatch[1]);
		if (valuesMatch) {
			raw.reasoning_options = [
				{ type: "effort", values: [...valuesMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) },
			];
		}
	}
	return parseModelEntry(raw);
}

// Primary source: the generated api.json — one request, everything inline.
async function fetchApiJson(): Promise<any> {
	if (apiJson) return apiJson;
	const json = await fetchJson(API_JSON_URL, PROBE_TIMEOUT_MS * 2);
	if (!json || typeof json !== "object") throw new Error("api.json was not an object");
	apiJson = json;
	return json;
}

// The provider catalog. Tries models.dev first, then the GitHub/jsDelivr
// mirror. Cached for the session; throws when both sources fail.
export async function fetchModelsDevProviders(): Promise<Map<string, ModelsDevProvider>> {
	if (providersCache) return providersCache;

	try {
		const json = await fetchApiJson();
		const out = new Map<string, ModelsDevProvider>();
		for (const [id, raw] of Object.entries<any>(json)) {
			if (!raw || typeof raw !== "object") continue;
			const entry = toProviderEntry(typeof raw.id === "string" ? raw.id : id, raw);
			if (entry) out.set(entry.id, entry);
		}
		if (out.size === 0) throw new Error("api.json contained no usable providers");
		providersCache = out;
		return out;
	} catch {
		// fall through to the mirror
	}

	const listing = await fetchJson(GITHUB_PROVIDERS_URL, PROBE_TIMEOUT_MS * 2);
	const ids: string[] = Array.isArray(listing)
		? listing.filter((e: any) => e?.type === "dir" && typeof e?.name === "string").map((e: any) => e.name)
		: [];
	if (ids.length === 0) throw new Error("GitHub mirror listing was empty");

	const out = new Map<string, ModelsDevProvider>();
	let cursor = 0;
	async function worker() {
		while (cursor < ids.length) {
			const id = ids[cursor++];
			try {
				const entry = toProviderEntry(id, parseProviderToml(await fetchText(PROVIDER_TOML_URL(id), PROBE_TIMEOUT_MS)));
				if (entry) out.set(id, entry);
			} catch {
				// A single unreadable provider doesn't sink the catalog.
			}
		}
	}
	await Promise.all(Array.from({ length: MIRROR_CONCURRENCY }, worker));
	if (out.size === 0) throw new Error("GitHub mirror returned no usable providers");
	providersCache = out;
	return out;
}

// Model metadata for one provider, keyed by model id. api.json carries models
// inline; the mirror needs one directory listing plus one TOML per model.
export async function fetchModelsDevModels(providerId: string): Promise<Map<string, ModelProbeInfo>> {
	const cached = modelsCache.get(providerId);
	if (cached) return cached;

	const out = new Map<string, ModelProbeInfo>();
	try {
		const json = await fetchApiJson();
		const models = json[providerId]?.models;
		if (models && typeof models === "object") {
			for (const [id, raw] of Object.entries<any>(models)) {
				const info = parseModelEntry(raw);
				if (info) out.set(id, info);
			}
			modelsCache.set(providerId, out);
			return out;
		}
	} catch {
		// fall through to the mirror
	}

	// Mirror: models/ can nest vendor subdirectories (openrouter: models/
	// <vendor>/<model>.toml), so list the whole subtree via the git trees API —
	// two requests for the full file list. The model id is the path relative to
	// models/, minus .toml.
	const dirInfo = await fetchJson(GITHUB_PROVIDER_URL(providerId), PROBE_TIMEOUT_MS * 2).catch(() => null);
	const modelsDir = Array.isArray(dirInfo)
		? dirInfo.find((e: any) => e?.name === "models" && e?.type === "dir")
		: undefined;
	const treeSha = typeof modelsDir?.sha === "string" ? modelsDir.sha : undefined;
	const tree = treeSha ? await fetchJson(GITHUB_TREE_URL(treeSha), PROBE_TIMEOUT_MS * 2).catch(() => null) : null;
	const files: string[] = Array.isArray(tree?.tree)
		? tree.tree.filter((e: any) => e?.type === "blob" && typeof e?.path === "string" && e.path.endsWith(".toml")).map((e: any) => e.path)
		: [];
	let cursor = 0;
	async function worker() {
		while (cursor < files.length) {
			const file = files[cursor++];
			try {
				const info = parseModelToml(await fetchText(MODEL_TOML_URL(providerId, file), PROBE_TIMEOUT_MS));
				if (info) out.set(file.replace(/\.toml$/, ""), info);
			} catch {
				// best effort per model
			}
		}
	}
	await Promise.all(Array.from({ length: MIRROR_CONCURRENCY }, worker));
	if (out.size > 0) modelsCache.set(providerId, out);
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
