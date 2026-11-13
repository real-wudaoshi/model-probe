import { applyKnownModelFallback, applyModelIdHints } from "./known-models.ts";
import { chatModelCandidates, probeDeveloperRole } from "./developer-role.ts";
import { fetchModelsDevInfoForBaseUrl, preloadModelsDevCatalog } from "./modelsdev.ts";
import {
	API_FALLBACK_LIMITS,
	applyModelDefaults,
	enrichLiteLLMModelGroupInfo,
	enrichLiteLLMModelInfo,
	enrichOllamaModelDetails,
	enrichOpenAIModelDetails,
	enrichPublicModelInfo,
	normalizeModelLimits,
	probeModels,
} from "./probe.ts";
import { FULL_PROFILE } from "./types.ts";
import { getMetadataProvenance, METADATA_FIELDS, mergeMetadataInfo, withMetadataProvenance } from "./provenance.ts";
import type { DetectProfile, ModelProbeInfo, ProbeResult } from "./types.ts";

export interface DetectOptions {
	apiKey?: string;
	/** Which gateway-wide / per-model endpoints to try. Defaults to FULL_PROFILE (try everything). */
	profile?: DetectProfile;
	/** Use Ollama native endpoints (/api/tags, /api/show) instead of OpenAI per-model details. */
	ollama?: boolean;
	/**
	 * Fill what the gateway did not report from models.dev, the built-in
	 * known-model rules, the api fallback and the defaults (default true).
	 * With false, `models` holds only what the gateway itself reported.
	 */
	knownModelFallback?: boolean;
	/** pi model api flavor (openai-completions, anthropic-messages, ...): enables
	 * protocol-level fallback limits when no other source knows them. */
	api?: string;
	/** Also probe whether the gateway accepts the OpenAI "developer" role (one tiny chat completion). */
	developerRole?: boolean;
}

export interface DetectResult extends ProbeResult {
	/** Final per-model metadata for every id in `ids`: inline list fields + gateway-wide + per-model + models.dev + local rules. */
	models: Map<string, ModelProbeInfo>;
	/** Developer-role support (probed value, or the default false), when requested via DetectOptions.developerRole. */
	supportsDeveloperRole?: boolean;
	/** Where supportsDeveloperRole came from: a real probe, or the default. */
	developerRoleSource?: "detected" | "default";
}

type TaggedField = "contextWindow" | "maxTokens" | "image" | "video" | "reasoning";

const NO_INFO: Map<string, ModelProbeInfo> = new Map();

// Gateway-wide metadata sources: each answers for EVERY model in a single
// call (LiteLLM /model/info, /model_group/info, the site public catalog).
// Ollama has no gateway-wide source — its native probing is per-model.
export async function fetchGatewayWideInfo(
	baseUrl: string,
	options: { apiKey?: string; profile?: DetectProfile; ollama?: boolean } = {},
): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	if (options.ollama) return out;
	const profile = { ...FULL_PROFILE, ...options.profile };

	// Independent endpoints — ask them at the same time, merge in a fixed order.
	const [modelInfo, publicCatalog, modelGroupInfo] = await Promise.all([
		profile.modelInfo ? enrichLiteLLMModelInfo(baseUrl, options.apiKey) : NO_INFO,
		profile.publicCatalog ? enrichPublicModelInfo(baseUrl) : NO_INFO,
		profile.modelGroupInfo ? enrichLiteLLMModelGroupInfo(baseUrl, options.apiKey) : NO_INFO,
	]);

	for (const [id, info] of modelInfo) out.set(id, info);
	// New API-style site catalog /api/models/public (no auth) — authoritative
	// context_window, so its values override what LiteLLM endpoints report.
	for (const [id, info] of publicCatalog) out.set(id, { ...(out.get(id) ?? {}), ...info });
	// LiteLLM /model_group/info (server root, requires api key) — fills gaps the
	// standard probes missed (e.g. when /model/info needs admin auth).
	for (const [id, info] of modelGroupInfo) {
		const existing = out.get(id);
		if (!existing) {
			out.set(id, info);
			continue;
		}
		const filled = { ...existing };
		if (filled.contextWindow === undefined && info.contextWindow !== undefined) filled.contextWindow = info.contextWindow;
		if (filled.maxTokens === undefined && info.maxTokens !== undefined) filled.maxTokens = info.maxTokens;
		if (filled.image === undefined && info.image !== undefined) filled.image = info.image;
		if (filled.video === undefined && info.video !== undefined) filled.video = info.video;
		if (filled.reasoning === undefined && info.reasoning !== undefined) filled.reasoning = info.reasoning;
		out.set(id, filled);
	}
	return out;
}

/**
 * Per-model metadata: Ollama native endpoints, or GET /models/{id}.
 *
 * `known` (optional) is the metadata already in hand per model, e.g. the
 * inline fields of the /models list. It lets the probe give up early on
 * gateways whose detail objects merely repeat the list.
 */
export async function fetchPerModelInfo(
	baseUrl: string,
	ids: string[],
	options: { apiKey?: string; ollama?: boolean; known?: Map<string, ModelProbeInfo> } = {},
): Promise<Map<string, ModelProbeInfo>> {
	if (options.ollama) return enrichOllamaModelDetails(baseUrl, options.apiKey, ids);
	return enrichOpenAIModelDetails(baseUrl, options.apiKey, ids, options.known);
}

// Fill still-unknown fields from the models.dev catalog (matched by base URL
// upstream), tagging them in modelsDevFields. Runs before the local rules: a
// catalog entry is curated per-model data, while a rule is a regex guess.
function applyModelsDevFallback(info: ModelProbeInfo | undefined, modelsDev: ModelProbeInfo | undefined): ModelProbeInfo | undefined {
	if (!modelsDev) return info;
	const out: ModelProbeInfo = { ...(info ?? {}) };
	const sources = getMetadataProvenance(info), catalogSources = getMetadataProvenance(modelsDev);
	const tagged: NonNullable<ModelProbeInfo["modelsDevFields"]> = [...(info?.modelsDevFields ?? [])];
	for (const field of ["contextWindow", "maxTokens", "image", "video", "reasoning", "cost"] as const) {
		if (out[field] === undefined && modelsDev[field] !== undefined) {
			out[field] = modelsDev[field] as any;
			sources[field] = catalogSources[field]?.source === "gateway" ? { source: "models.dev", match: "exact", infer: false } : catalogSources[field];
			tagged.push(field);
		}
	}
	for (const field of ["effortOptions", "alwaysThinking", "endpointTypes"] as const) {
		if (field !== "endpointTypes" && out.reasoning === false) continue;
		if (out[field] === undefined && modelsDev[field] !== undefined) {
			(out as Record<string, unknown>)[field] = modelsDev[field];
			sources[field] = catalogSources[field]?.source === "gateway" ? { source: "models.dev", match: "exact", infer: false } : catalogSources[field];
		}
	}
	if (tagged.length > 0) out.modelsDevFields = tagged;
	return withMetadataProvenance(out, sources);
}

// Protocol-level limits, below the local rules and above nothing — the last
// word before a field stays unknown. Tagged as defaulted so callers can tell
// it apart from real data (and don't display it as a confident label).
//
// The output fallback never takes more than a quarter of a window that IS
// known: a 32K default on a model with a 16K context would be nonsense.
function applyApiFallback(info: ModelProbeInfo, api: string | undefined): ModelProbeInfo {
	const fallback = api && Object.hasOwn(API_FALLBACK_LIMITS, api) ? API_FALLBACK_LIMITS[api] : undefined;
	if (!fallback) return info;
	const out: ModelProbeInfo = { ...info };
	const sources = getMetadataProvenance(info);
	const defaulted: TaggedField[] = [...(info.defaultedFields ?? [])];
	if (out.contextWindow === undefined) {
		out.contextWindow = fallback.contextWindow;
		defaulted.push("contextWindow");
	}
	if (out.maxTokens === undefined) {
		out.maxTokens = Math.min(fallback.maxTokens, Math.max(1, Math.floor(out.contextWindow / 4)));
		defaulted.push("maxTokens");
	}
	if (defaulted.length > 0) out.defaultedFields = defaulted;
	for (const field of ["contextWindow", "maxTokens"] as const) if (info[field] === undefined && out[field] !== undefined) sources[field] = { source: "api-default", match: "default", infer: true };
	return withMetadataProvenance(out, sources);
}

// The two limits are resolved independently and can come from different
// sources: a context window the gateway reported next to an output cap from
// the catalog or a rule. When such a borrowed output cap does not even fit in
// the window, it describes some other deployment — replace it with a
// conservative share of the real window and stop presenting it as sourced data.
function reconcileLimits(info: ModelProbeInfo): ModelProbeInfo {
	if (info.contextWindow === undefined || info.maxTokens === undefined || info.maxTokens < info.contextWindow) return info;
	const fromModelsDev = info.modelsDevFields?.includes("maxTokens") ?? false;
	const fromRules = info.inferredFields?.includes("maxTokens") ?? false;
	const defaulted = info.defaultedFields?.includes("maxTokens") ?? false;
	// A cap the gateway itself reported stands as reported.
	if (!fromModelsDev && !fromRules && !defaulted) return info;

	const out: ModelProbeInfo = { ...info, maxTokens: normalizeModelLimits(info.contextWindow, info.maxTokens).maxTokens };
	if (fromModelsDev) out.modelsDevFields = info.modelsDevFields!.filter((field) => field !== "maxTokens");
	if (fromRules) {
		const remaining = info.inferredFields!.filter((field) => field !== "maxTokens");
		if (remaining.length > 0) {
			out.inferredFields = remaining;
		} else {
			delete out.inferredFields;
			delete out.inferred;
		}
	}
	if (out.modelsDevFields?.length === 0) delete out.modelsDevFields;
	if (!defaulted) out.defaultedFields = [...(info.defaultedFields ?? []), "maxTokens"];
	return withMetadataProvenance(out, { ...getMetadataProvenance(info), maxTokens: { source: "api-default", match: "default", infer: true, derivation: "limit-reconciliation", references: getMetadataProvenance(info).maxTokens?.references } });
}

// Resolve the final metadata for one model: detected values win, then an
// exact models.dev entry, then an ID context hint ("...[1m]") or a normalized
// catalog match, then the local rules (regex guesses), then protocol-level
// fallback limits for the given api flavor, then MODEL_INFO_DEFAULTS. The
// source of each filled field is tagged (modelsDevFields / inferredFields /
// defaultedFields).
export function resolveModelInfo(
	modelId: string,
	info?: ModelProbeInfo,
	modelsDev?: Map<string, ModelProbeInfo>,
	api?: string,
): ModelProbeInfo {
	const catalog = modelsDev?.get(modelId);
	const exactContext = catalog?.contextWindow !== undefined && !getMetadataProvenance(catalog).contextWindow?.infer;
	const fromCatalog = exactContext
		? applyModelsDevFallback(info, catalog)
		: applyModelsDevFallback(applyModelIdHints(modelId, info), catalog);
	const fromRules = applyKnownModelFallback(modelId, fromCatalog) ?? {};
	return applyModelDefaults(reconcileLimits(applyApiFallback(fromRules, api)));
}

// Merge metadata maps for `ids` (later maps win) and resolve each id through
// models.dev + the local rules + the api fallback + defaults.
export function finalizeModelInfo(
	ids: string[],
	maps: Array<Map<string, ModelProbeInfo>>,
	options: { modelsDev?: Map<string, ModelProbeInfo>; api?: string } = {},
): Map<string, ModelProbeInfo> {
	const merged = new Map<string, ModelProbeInfo>();
	for (const map of maps) {
		for (const [id, info] of map) {
			merged.set(id, mergeMetadataInfo(merged.get(id), info));
		}
	}
	for (const id of ids) {
		merged.set(id, resolveModelInfo(id, merged.get(id), options.modelsDev, options.api));
	}
	return merged;
}

/**
 * Full detection: probe /models (with ±/v1 adaptation), then gather metadata
 * from gateway-wide endpoints, then per-model details for anything still
 * unknown, and finally models.dev and the built-in known-model rules.
 */
export async function detectModels(baseUrl: string, options: DetectOptions = {}): Promise<DetectResult> {
	const profile = { ...FULL_PROFILE, ...options.profile };
	const fillGaps = options.knownModelFallback !== false;
	const useModelsDev = fillGaps && profile.modelsDev;
	// The catalog is a multi-MB download: start it now so it overlaps the probing.
	if (useModelsDev) preloadModelsDevCatalog();

	const probed = await probeModels(baseUrl, options.apiKey);

	const { fetchModelMetadata } = await import("./metadata.ts");
	const batch = await fetchModelMetadata(probed.ids, { ...options, baseUrl, listing: probed, profile });
	const models = batch.infoById;

	const result: DetectResult = { ...probed, models };
	if (options.developerRole) {
		const probedRole = probed.ids.length > 0 && batch.baseUrl ? await probeDeveloperRole(batch.baseUrl, options.apiKey, chatModelCandidates(probed.ids)) : undefined;
		// Inconclusive probes default to false: sending "system" instead of
		// "developer" is accepted everywhere, the reverse is not.
		result.supportsDeveloperRole = probedRole ?? false;
		result.developerRoleSource = probedRole === undefined ? "default" : "detected";
	}
	return result;
}
