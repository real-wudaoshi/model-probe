import { fetchGatewayWideInfo, fetchPerModelInfo, resolveModelInfo } from "./detect.ts";
import { fetchModelsDevInfoForBaseUrl, fetchModelsDevModels, preloadModelsDevCatalog } from "./modelsdev.ts";
import { API_FALLBACK_LIMITS, normalizeModelLimits, probeModels } from "./probe.ts";
import { mayForwardCredentials } from "./http.ts";
import { normalizeBaseUrl } from "./url.ts";
import { FULL_PROFILE } from "./types.ts";
import type { DetectProfile, ModelProbeInfo, ProbeResult, ResolvedModelMetadata } from "./types.ts";
import { getMetadataProvenance, mergeMetadataInfo, mergeWithExistingMetadata, resolvedMetadata, savedModelMetadata, withMetadataProvenance } from "./provenance.ts";

export type MetadataContext = {
	baseUrl?: string;
	listing?: ProbeResult;
	gateway?: Map<string, ModelProbeInfo>;
	catalog?: Map<string, ModelProbeInfo>;
};
export type ModelMetadataOptions = {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	ollama?: boolean;
	profile?: DetectProfile;
	/** Reuse only package-produced source data; this object contains no key. */
	context?: MetadataContext;
	listing?: ProbeResult;
	/** Bound catalog, as used by catalog mirroring. Empty ids lists that catalog. */
	catalogProviderId?: string;
	requireLiveCatalog?: boolean;
	existing?: Map<string, ModelProbeInfo>;
	knownModelFallback?: boolean;
	signal?: AbortSignal;
};
export type MetadataBatchResult = {
	ids: string[];
	baseUrl?: string;
	infoById: Map<string, ModelProbeInfo>;
	models: Map<string, ResolvedModelMetadata>;
	context: MetadataContext;
};
type ContextIdentity = { baseUrl?: string; apiKey?: string; providerId?: string; live: boolean; gatewayProfile: string };
const identities = new WeakMap<MetadataContext, ContextIdentity>();
const empty = () => new Map<string, ModelProbeInfo>();
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason ?? new DOMException("Metadata lookup cancelled", "AbortError"); }

/**
 * Fetch and resolve metadata for explicit IDs (one or many). A missing /models
 * never prevents known-ID lookup. No inference/generation requests are made.
 * Set perModelDetails:false for a list preview, then reuse context for selection.
 */
export async function fetchModelMetadata(requestedIds: string[], options: ModelMetadataOptions = {}): Promise<MetadataBatchResult> {
	checkAbort(options.signal);
	const profile = { ...FULL_PROFILE, ...options.profile };
	const fill = options.knownModelFallback !== false;
	let inputBase = options.listing?.baseUrl ?? options.context?.baseUrl;
	if (options.baseUrl) {
		try { inputBase = normalizeBaseUrl(options.baseUrl); }
		catch (error) {
			if (!requestedIds.length) throw error;
			inputBase = undefined;
		}
	}
	const gatewayProfile = JSON.stringify([profile.modelInfo, profile.publicCatalog, profile.modelGroupInfo, options.ollama, profile.modelsDev, fill]);
	const identity: ContextIdentity = { baseUrl: inputBase, apiKey: options.apiKey, providerId: options.catalogProviderId, live: !!options.requireLiveCatalog, gatewayProfile };
	const prior = options.context, old = prior && identities.get(prior);
	const reuse = !!old && old.apiKey === identity.apiKey && old.providerId === identity.providerId && old.live === identity.live && old.gatewayProfile === gatewayProfile
		&& (old.baseUrl === inputBase || prior!.baseUrl === inputBase);
	const context: MetadataContext = reuse ? { ...prior } : {};
	let ids = [...new Set(requestedIds.map((id) => id.trim()).filter(Boolean))];
	let baseUrl = inputBase;
	let catalogFailed = false;
	let bound = empty();
	let offlineBound = empty();
	if (options.listing) context.listing = options.listing;
	if (!ids.length && !options.catalogProviderId && baseUrl) {
		context.listing ??= await probeModels(baseUrl, options.apiKey);
		ids = context.listing.ids;
	}
	if (!ids.length && !options.catalogProviderId) {
		context.baseUrl = baseUrl; identities.set(context, identity);
		return { ids, baseUrl, models: new Map(), infoById: empty(), context };
	}
	if (options.catalogProviderId) {
		try {
			bound = reuse && context.catalog ? context.catalog : await fetchModelsDevModels(options.catalogProviderId, { requireLive: options.requireLiveCatalog });
			context.catalog = bound;
			if (!requestedIds.length) ids = [...bound.keys()];
		} catch (error) {
			// Mirroring needs live membership. A known ID can still use a
			// snapshot as a reference, below gateway data and saved values.
			if (!requestedIds.length) throw error;
			catalogFailed = true;
			if (fill && profile.modelsDev) offlineBound = await fetchModelsDevModels(options.catalogProviderId).catch(empty);
		}
	} else if (fill && profile.modelsDev) preloadModelsDevCatalog();
	const pending = ids.filter((id) => !bound.has(id));
	if (baseUrl && pending.length && !context.listing) {
		try { context.listing = await probeModels(baseUrl, options.apiKey); }
		catch { /* Known IDs can still use management/details/catalog sources. */ }
	}
	if (baseUrl && context.listing) {
		// A redirect is not permission to send the key to its new host on a
		// subsequent request, nor to persist that host as the provider endpoint.
		try { if (mayForwardCredentials(new URL(baseUrl), new URL(context.listing.baseUrl))) baseUrl = context.listing.baseUrl; } catch { /* keep requested endpoint */ }
	}
	context.baseUrl = baseUrl;
	checkAbort(options.signal);
	const [gateway, catalog] = await Promise.all([
		baseUrl && pending.length ? context.gateway ?? fetchGatewayWideInfo(baseUrl, { apiKey: options.apiKey, profile, ollama: options.ollama }).catch(empty) : empty(),
		fill && profile.modelsDev && pending.length
			? options.catalogProviderId ? fetchModelsDevInfoForBaseUrl(baseUrl ?? "", pending).catch(empty)
				: reuse && context.catalog ? new Map(context.catalog) : fetchModelsDevInfoForBaseUrl(baseUrl ?? "", ids).catch(empty)
			: empty(),
	]);
	context.gateway = gateway;
	if (!options.catalogProviderId) {
		// A selected/manual ID may not have existed in the preview's lookup.
		const missing = pending.filter((id) => !catalog.has(id));
		if (reuse && fill && profile.modelsDev && missing.length) {
			for (const [id, info] of await fetchModelsDevInfoForBaseUrl(baseUrl ?? "", missing)) catalog.set(id, info);
		}
		context.catalog = catalog;
	}
	checkAbort(options.signal);
	const listing = context.listing?.infoById ?? empty();
	let details = empty();
	if (baseUrl && profile.perModelDetails && pending.length) {
		const wanted = options.ollama ? pending : pending.filter((id) => !gateway.has(id));
		if (wanted.length) details = await fetchPerModelInfo(baseUrl, wanted, { apiKey: options.apiKey, ollama: options.ollama, known: listing });
	}
	checkAbort(options.signal);
	const models = new Map<string, ResolvedModelMetadata>(), infoById = empty();
	for (const id of ids) {
		const detected = mergeMetadataInfo(mergeMetadataInfo(listing.get(id), gateway.get(id) ?? {}), details.get(id) ?? {});
		if (!fill && !Object.keys(detected).length) continue;
		let fromCatalog = bound.get(id) ?? catalog.get(id);
		if (catalogFailed) {
			const offline = offlineBound.get(id);
			if (offline) fromCatalog = mergeMetadataInfo(fromCatalog, offline);
			if (fromCatalog) {
				const sources = getMetadataProvenance(fromCatalog);
				for (const field of Object.keys(sources) as Array<keyof typeof sources>) {
					const source = sources[field];
					if (source?.source === "models.dev") sources[field] = { ...source, infer: true };
				}
				fromCatalog = withMetadataProvenance({ ...fromCatalog }, sources);
			}
		}
		const resolved = fill ? resolveModelInfo(id, bound.has(id) ? undefined : detected, fromCatalog ? new Map([[id, fromCatalog]]) : undefined, options.api) : detected;
		const previous = options.existing?.get(id);
		const record = resolvedMetadata(id, mergeWithExistingMetadata(resolved, previous));
		models.set(id, record); infoById.set(id, record.info);
	}
	identities.set(context, identity);
	return { ids, baseUrl, models, infoById, context };
}

/** Pure, shared numerical fallback for runtimes requiring complete limits. */
export function getModelLimits(info: ModelProbeInfo, api?: string): { contextWindow: number; maxTokens: number } {
	const fallback = api && Object.hasOwn(API_FALLBACK_LIMITS, api) ? API_FALLBACK_LIMITS[api] : { contextWindow: 128000, maxTokens: 8192 };
	const contextWindow = typeof info.contextWindow === "number" && info.contextWindow > 0 ? info.contextWindow : fallback.contextWindow;
	const explicitOutput = typeof info.maxTokens === "number" && info.maxTokens > 0;
	const maxTokens = explicitOutput ? info.maxTokens! : Math.min(fallback.maxTokens, Math.max(1, Math.floor(contextWindow / 4)));
	return explicitOutput ? { contextWindow, maxTokens } : normalizeModelLimits(contextWindow, maxTokens);
}

export function existingMetadata(info: ModelProbeInfo, provenance?: Parameters<typeof savedModelMetadata>[1]): ModelProbeInfo {
	return savedModelMetadata(info, provenance);
}
