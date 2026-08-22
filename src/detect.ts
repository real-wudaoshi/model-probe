import { applyKnownModelFallback } from "./known-models.ts";
import { probeDeveloperRole } from "./developer-role.ts";
import { fetchModelsDevInfoForBaseUrl } from "./modelsdev.ts";
import {
	applyModelDefaults,
	enrichLiteLLMModelGroupInfo,
	enrichLiteLLMModelInfo,
	enrichOllamaModelDetails,
	enrichOpenAIModelDetails,
	enrichPublicModelInfo,
	probeModels,
} from "./probe.ts";
import { FULL_PROFILE } from "./types.ts";
import type { DetectProfile, ModelProbeInfo, ProbeResult } from "./types.ts";

export interface DetectOptions {
	apiKey?: string;
	/** Which gateway-wide / per-model endpoints to try. Defaults to FULL_PROFILE (try everything). */
	profile?: DetectProfile;
	/** Use Ollama native endpoints (/api/tags, /api/show) instead of OpenAI per-model details. */
	ollama?: boolean;
	/** Fill remaining gaps from the built-in known-model rules (default true). */
	knownModelFallback?: boolean;
	/** Also probe whether the gateway accepts the OpenAI "developer" role (one tiny chat completion). */
	developerRole?: boolean;
}

export interface DetectResult extends ProbeResult {
	/** Final per-model metadata: inline list fields + gateway-wide + per-model + models.dev + local rules. */
	models: Map<string, ModelProbeInfo>;
	/** Developer-role support (probed value, or the default false), when requested via DetectOptions.developerRole. */
	supportsDeveloperRole?: boolean;
	/** Where supportsDeveloperRole came from: a real probe, or the default. */
	developerRoleSource?: "detected" | "default";
}

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

	if (profile.modelInfo) {
		for (const [id, info] of await enrichLiteLLMModelInfo(baseUrl, options.apiKey)) {
			out.set(id, info);
		}
	}
	// USTC-style site catalog /api/models/public (no auth) — authoritative
	// context_window, so its values override what LiteLLM endpoints report.
	if (profile.publicCatalog) {
		for (const [id, info] of await enrichPublicModelInfo(baseUrl)) {
			out.set(id, { ...(out.get(id) ?? {}), ...info });
		}
	}
	// LiteLLM /model_group/info (server root, requires api key) — fills gaps the
	// standard probes missed (e.g. when /model/info needs admin auth).
	if (profile.modelGroupInfo) {
		for (const [id, info] of await enrichLiteLLMModelGroupInfo(baseUrl, options.apiKey)) {
			const existing = out.get(id);
			if (!existing) {
				out.set(id, info);
				continue;
			}
			const filled = { ...existing };
			if (filled.contextWindow === undefined && info.contextWindow !== undefined) filled.contextWindow = info.contextWindow;
			if (filled.image === undefined && info.image !== undefined) filled.image = info.image;
			if (filled.video === undefined && info.video !== undefined) filled.video = info.video;
			if (filled.reasoning === undefined && info.reasoning !== undefined) filled.reasoning = info.reasoning;
			out.set(id, filled);
		}
	}
	return out;
}

// Per-model metadata: Ollama native endpoints, or GET /models/{id}.
export async function fetchPerModelInfo(
	baseUrl: string,
	ids: string[],
	options: { apiKey?: string; ollama?: boolean } = {},
): Promise<Map<string, ModelProbeInfo>> {
	if (options.ollama) return enrichOllamaModelDetails(baseUrl, options.apiKey, ids);
	return enrichOpenAIModelDetails(baseUrl, options.apiKey, ids);
}

// Fill still-unknown fields from the models.dev catalog (matched by base URL
// upstream), tagging them in modelsDevFields. Runs before the local rules: a
// catalog entry is curated per-model data, while a rule is a regex guess.
function applyModelsDevFallback(info: ModelProbeInfo | undefined, modelsDev: ModelProbeInfo | undefined): ModelProbeInfo | undefined {
	if (!modelsDev) return info;
	const out: ModelProbeInfo = { ...(info ?? {}) };
	const tagged: Array<"contextWindow" | "image" | "video" | "reasoning"> = [...(info?.modelsDevFields ?? [])];
	for (const field of ["contextWindow", "image", "video", "reasoning"] as const) {
		if (out[field] === undefined && modelsDev[field] !== undefined) {
			out[field] = modelsDev[field];
			tagged.push(field);
		}
	}
	// effortOptions isn't a display tag, just carry it over.
	if (out.effortOptions === undefined && modelsDev.effortOptions !== undefined) out.effortOptions = modelsDev.effortOptions;
	if (tagged.length > 0) out.modelsDevFields = tagged;
	return out;
}

// Resolve the final metadata for one model: detected values win, then the
// models.dev catalog (exact per-model entries), then the local rules (regex
// guesses), then MODEL_INFO_DEFAULTS. The source of each filled field is
// tagged (modelsDevFields / inferredFields / defaultedFields).
export function resolveModelInfo(
	modelId: string,
	info?: ModelProbeInfo,
	modelsDev?: Map<string, ModelProbeInfo>,
): ModelProbeInfo {
	return applyModelDefaults(applyKnownModelFallback(modelId, applyModelsDevFallback(info, modelsDev?.get(modelId))));
}

// Merge metadata maps for `ids` (later maps win) and resolve each id through
// models.dev + the local rules + defaults.
export function finalizeModelInfo(
	ids: string[],
	maps: Array<Map<string, ModelProbeInfo>>,
	options: { modelsDev?: Map<string, ModelProbeInfo> } = {},
): Map<string, ModelProbeInfo> {
	const merged = new Map<string, ModelProbeInfo>();
	for (const map of maps) {
		for (const [id, info] of map) {
			merged.set(id, { ...(merged.get(id) ?? {}), ...info });
		}
	}
	for (const id of ids) {
		merged.set(id, resolveModelInfo(id, merged.get(id), options.modelsDev));
	}
	return merged;
}

/**
 * Full detection: probe /models (with ±/v1 adaptation), then gather metadata
 * from gateway-wide endpoints, then per-model details for anything still
 * unknown, and finally the built-in known-model rules.
 */
export async function detectModels(baseUrl: string, options: DetectOptions = {}): Promise<DetectResult> {
	const profile = { ...FULL_PROFILE, ...options.profile };
	const probed = await probeModels(baseUrl, options.apiKey);

	const gatewayWide = await fetchGatewayWideInfo(probed.baseUrl, { apiKey: options.apiKey, profile, ollama: options.ollama });

	// Per-model details. Skipped when a gateway-wide source already answered for
	// everything (LiteLLM's /models/{id} has no metadata).
	let details = new Map<string, ModelProbeInfo>();
	if (options.ollama) {
		details = await fetchPerModelInfo(probed.baseUrl, probed.ids, { apiKey: options.apiKey, ollama: true });
	} else if (profile.perModelDetails && gatewayWide.size === 0) {
		details = await fetchPerModelInfo(probed.baseUrl, probed.ids, { apiKey: options.apiKey });
	}

	// models.dev catalog, matched to the probed base URL. Fetched like a
	// gateway-wide source but applied ABOVE the local rules at finalize time.
	let modelsDev = new Map<string, ModelProbeInfo>();
	if (profile.modelsDev) {
		modelsDev = await fetchModelsDevInfoForBaseUrl(probed.baseUrl);
	}

	const models =
		options.knownModelFallback === false
			? finalizeModelInfo([], [probed.infoById, gatewayWide, details])
			: finalizeModelInfo(probed.ids, [probed.infoById, gatewayWide, details], { modelsDev });

	const result: DetectResult = { ...probed, models };
	if (options.developerRole) {
		const probedRole = probed.ids.length > 0 ? await probeDeveloperRole(probed.baseUrl, options.apiKey, probed.ids[0]) : undefined;
		// Inconclusive probes default to false: sending "system" instead of
		// "developer" is accepted everywhere, the reverse is not.
		result.supportsDeveloperRole = probedRole ?? false;
		result.developerRoleSource = probedRole === undefined ? "default" : "detected";
	}
	return result;
}
