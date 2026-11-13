// models.dev as a metadata source: provider catalog (which API sites exist,
// their base URLs) and per-provider model metadata (context window, image,
// video, reasoning, effort options).
//
// In the metadata priority order models.dev sits ABOVE the local known-model
// rules: a catalog entry is curated per-model data, while a rule is a regex
// guess. Detected > models.dev > local rule > default. Fields filled from
// here are tagged in modelsDevFields.
//
// Data comes from the official models.dev SDK (@opencode-ai/models), in this
// order:
//   1. the last live download, cached on disk, while it is under an hour old
//   2. the live API (GET https://models.dev/catalog.json) — then cached
//   3. an older live download (up to a day) when the API is unreachable
//   4. the latest published SDK snapshot from the jsDelivr npm CDN — the
//      freshness path for networks where models.dev itself is blocked
//   5. the snapshot bundled inside the installed SDK — works fully offline
//
// Everything cached is plain JSON in a per-user cache directory. The CDN
// snapshot ships as a JavaScript module; it is parsed as data and never
// imported, so nothing downloaded at runtime is ever executed.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Models, ModelsDevError } from "@opencode-ai/models";
import type { Model, ProviderMap } from "@opencode-ai/models";
import { request } from "./http.ts";
import { normalizeModelIdCandidates } from "./known-models.ts";
import { normalizeModelLimits } from "./probe.ts";
import { PROBE_TIMEOUT_MS } from "./types.ts";
import type { MetadataField, MetadataProvenance, MetadataReference, ModelProbeInfo } from "./types.ts";
import { getMetadataProvenance, METADATA_FIELDS, withMetadataProvenance } from "./provenance.ts";

export type ModelsDevProvider = {
	id: string;
	name: string;
	baseUrl: string;
	env: string[];
	doc?: string;
};

/**
 * Where the catalog in use came from. "live" and "cache" are the models.dev
 * API itself (just downloaded / downloaded earlier on this machine); "cdn"
 * and "bundled" are published snapshots, which can be older than data this
 * machine has already seen.
 */
export type ModelsDevCatalogInfo = {
	source: "live" | "cache" | "cdn" | "bundled";
	/** When the data was current (ms since epoch). */
	asOf: number;
};

// Providers whose api field is implicit (their ai-sdk package hardcodes the
// endpoint, so the catalog omits it). These mirror the SDK defaults.
// Providers that need account-specific URLs (Azure, Bedrock, Cloudflare AI
// Gateway, ...) or aren't OpenAI-compatible (Anthropic, Google) have no entry.
const DEFAULT_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	deepseek: "https://api.deepseek.com",
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

// Hosts to recognize when PROBED, although the catalog lists no OpenAI-style
// base URL for them (native APIs, SDK-hardcoded endpoints). They only map a
// probed base URL to its catalog table — they are deliberately not part of
// fetchModelsDevProviders(), which lists OpenAI-compatible endpoints.
const PROBED_HOST_ALIASES: Array<{ providerId: string; matches: (url: URL) => boolean }> = [
	{ providerId: "google", matches: (url) => url.hostname === "generativelanguage.googleapis.com" },
	{ providerId: "anthropic", matches: (url) => url.hostname === "api.anthropic.com" },
	{ providerId: "vercel", matches: (url) => url.hostname === "ai-gateway.vercel.sh" },
	{ providerId: "opencode", matches: (url) => url.hostname === "opencode.ai" && /^\/zen(\/|$)/.test(url.pathname) },
];

// ---------------------------------------------------------------------------
// Catalog loading
// ---------------------------------------------------------------------------

// Lab-published, provider-agnostic model metadata (models.dev /models.json),
// keyed by "<lab>/<model>". Typed loosely: the shape has grown across SDK
// releases and only a few stable fields are read.
type LabModel = {
	open_weights?: boolean;
	reasoning?: boolean;
	modalities?: { input?: unknown };
	limit?: { context?: number; output?: number };
};
type LabModelMap = Record<string, LabModel>;

type CatalogData = { providers: ProviderMap; models: LabModelMap; asOf: number };
type LoadedCatalog = CatalogData & { source: ModelsDevCatalogInfo["source"] };

// A live download is reused for an hour before asking again.
const LIVE_TTL_MS = 60 * 60 * 1000;
// After the live API failed, don't make every run wait for it again.
const LIVE_RETRY_DELAY_MS = 10 * 60 * 1000;
// Up to this age an earlier live download beats the daily CDN snapshot.
const STALE_LIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The CDN snapshot is republished daily.
const CDN_TTL_MS = 12 * 60 * 60 * 1000;

// jsDelivr serves the latest published SDK's snapshot.js: same publisher and
// content as the npm dependency itself, just fresher.
const SNAPSHOT_CDN_URL = "https://cdn.jsdelivr.net/npm/@opencode-ai/models@latest/dist/snapshot.js";

// The catalog held in memory. A long-lived host (an editor or agent session
// that stays open for days) asks again once the copy has aged: hourly for
// live data, and after the retry delay when all it could get was a snapshot.
let catalogCache: LoadedCatalog | null = null;
let catalogLoadedAt = 0;
let catalogPromise: Promise<LoadedCatalog> | null = null;
let idIndexCache: Map<string, ModelProbeInfo> | null = null;

function cacheDir(): string {
	const override = process.env.MODEL_PROBE_CACHE_DIR?.trim();
	if (override) return override;
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "model-probe", "Cache");
	}
	if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "model-probe");
	return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "model-probe");
}

const cacheFile = (name: "live" | "cdn") => join(cacheDir(), `modelsdev-${name}.json`);
const liveFailureMarker = () => join(cacheDir(), "modelsdev-live.failed");

function isProviderMap(value: unknown): value is ProviderMap {
	return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function readCache(name: "live" | "cdn"): (CatalogData & { savedAt: number }) | null {
	try {
		const parsed = JSON.parse(readFileSync(cacheFile(name), "utf8"));
		if (!parsed || typeof parsed !== "object" || typeof parsed.savedAt !== "number" || !isProviderMap(parsed.providers)) return null;
		return {
			savedAt: parsed.savedAt,
			asOf: typeof parsed.asOf === "number" ? parsed.asOf : parsed.savedAt,
			providers: parsed.providers,
			models: parsed.models && typeof parsed.models === "object" ? parsed.models : {},
		};
	} catch {
		return null; // missing or unreadable — treated as no cache
	}
}

// Write-then-rename, so a reader (or a run killed halfway) never sees half a file.
function writeCache(name: "live" | "cdn", data: CatalogData, savedAt: number): void {
	try {
		mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
		const file = cacheFile(name);
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify({ savedAt, asOf: data.asOf, providers: data.providers, models: data.models }), { mode: 0o600 });
		renameSync(temp, file);
	} catch {
		// Caching is an optimization; an unwritable cache directory is not an error.
	}
}

function liveFailedRecently(now: number): boolean {
	try {
		return now - statSync(liveFailureMarker()).mtimeMs < LIVE_RETRY_DELAY_MS;
	} catch {
		return false;
	}
}

function recordLiveFailure(failed: boolean): void {
	try {
		if (failed) {
			mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
			writeFileSync(liveFailureMarker(), "");
		} else if (existsSync(liveFailureMarker())) {
			unlinkSync(liveFailureMarker());
		}
	} catch {
		// best effort
	}
}

async function fetchLive(now: number): Promise<CatalogData> {
	const client = Models.make();
	const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS * 2);
	// catalog.json carries the provider tables and the lab metadata in one
	// download. Where that file itself is the problem (a mirror without it),
	// api.json still has the provider tables; when the host cannot be reached
	// at all, a second request would only double the wait.
	try {
		const catalog: any = await client.catalog({ signal });
		if (isProviderMap(catalog?.providers)) {
			return { providers: catalog.providers, models: catalog.models && typeof catalog.models === "object" ? catalog.models : {}, asOf: now };
		}
	} catch (error) {
		if (!(error instanceof ModelsDevError) || error.reason === "Transport") throw error;
	}
	const providers = await client.providers({ signal });
	if (!isProviderMap(providers)) throw new Error("models.dev returned no providers");
	return { providers, models: {}, asOf: now };
}

/**
 * Read the SDK's snapshot module as DATA. The file is generated as
 *   const data = JSON.parse("<json>") ... export const generatedAt = "<iso>"
 * so the catalog is recovered by parsing that string literal twice — the
 * module is never evaluated.
 */
export function parseSnapshotModule(source: string, now = Date.now()): CatalogData {
	const call = source.indexOf("JSON.parse(");
	const open = call === -1 ? -1 : source.indexOf('"', call);
	if (open === -1) throw new Error("unrecognized snapshot format");
	// Find the closing quote of the string literal, skipping escaped characters.
	let close = -1;
	for (let i = open + 1; i < source.length; i++) {
		const ch = source.charCodeAt(i);
		if (ch === 92 /* \ */) i++;
		else if (ch === 34 /* " */) {
			close = i;
			break;
		}
	}
	if (close === -1) throw new Error("unrecognized snapshot format");
	const data = JSON.parse(JSON.parse(source.slice(open, close + 1)));
	if (!isProviderMap(data?.providers)) throw new Error("snapshot had no providers");
	const generatedAt = /generatedAt\s*=\s*"([^"]+)"/.exec(source.slice(close))?.[1];
	const asOf = generatedAt ? Date.parse(generatedAt) : Number.NaN;
	return {
		providers: data.providers,
		models: data.models && typeof data.models === "object" ? data.models : {},
		asOf: Number.isFinite(asOf) ? asOf : now,
	};
}

async function fetchCdnSnapshot(now: number): Promise<CatalogData> {
	const res = await request(SNAPSHOT_CDN_URL, {
		headers: { "user-agent": "model-probe" },
		timeoutMs: PROBE_TIMEOUT_MS * 2,
		bodyTimeoutMs: 30_000, // several MB
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return parseSnapshotModule(res.body, now);
}

async function loadBundledSnapshot(): Promise<LoadedCatalog> {
	// Imported dynamically so the multi-MB snapshot is only parsed on this path.
	const snapshot: any = await import("@opencode-ai/models/snapshot");
	const asOf = typeof snapshot.generatedAt === "string" ? Date.parse(snapshot.generatedAt) : Number.NaN;
	return {
		providers: snapshot.providers,
		models: snapshot.models && typeof snapshot.models === "object" ? snapshot.models : {},
		asOf: Number.isFinite(asOf) ? asOf : 0,
		source: "bundled",
	};
}

async function loadCatalogUncached(): Promise<LoadedCatalog> {
	const now = Date.now();

	const live = readCache("live");
	if (live && now - live.savedAt < LIVE_TTL_MS) return { ...live, source: "cache" };

	if (!liveFailedRecently(now)) {
		try {
			const fresh = await fetchLive(now);
			writeCache("live", fresh, now);
			recordLiveFailure(false);
			return { ...fresh, source: "live" };
		} catch {
			// Live API unreachable — remember that, then try the fallbacks.
			recordLiveFailure(true);
		}
	}
	if (live && now - live.savedAt < STALE_LIVE_MAX_AGE_MS) return { ...live, source: "cache" };

	const cdn = readCache("cdn");
	if (cdn && now - cdn.savedAt < CDN_TTL_MS) return { ...cdn, source: "cdn" };
	try {
		const snapshot = await fetchCdnSnapshot(now);
		writeCache("cdn", snapshot, now);
		return { ...snapshot, source: "cdn" };
	} catch {
		// CDN unreachable too.
	}

	// Offline: whichever copy is newest — an old download or the bundled snapshot.
	const candidates: LoadedCatalog[] = [await loadBundledSnapshot()];
	if (live) candidates.push({ ...live, source: "cache" });
	if (cdn) candidates.push({ ...cdn, source: "cdn" });
	return candidates.reduce((best, candidate) => (candidate.asOf > best.asOf ? candidate : best));
}

function isLiveGrade(catalog: LoadedCatalog): boolean {
	return catalog.source === "live" || catalog.source === "cache";
}

async function loadCatalog(): Promise<LoadedCatalog> {
	if (catalogCache && Date.now() - catalogLoadedAt < (isLiveGrade(catalogCache) ? LIVE_TTL_MS : LIVE_RETRY_DELAY_MS)) {
		return catalogCache;
	}
	catalogPromise ??= loadCatalogUncached().then(
		(catalog) => {
			catalogCache = catalog;
			catalogLoadedAt = Date.now();
			idIndexCache = null;
			catalogPromise = null;
			return catalog;
		},
		(error) => {
			catalogPromise = null; // let a later call try again
			if (catalogCache) return catalogCache; // keep serving the copy we have
			throw error;
		},
	);
	return catalogPromise;
}

/**
 * Start loading the catalog in the background, so a later lookup doesn't wait
 * for the download. Never throws.
 */
export function preloadModelsDevCatalog(): void {
	void loadCatalog().catch(() => {});
}

/** Which copy of the catalog is in use, and how current it is. */
export async function getModelsDevCatalogInfo(): Promise<ModelsDevCatalogInfo> {
	const catalog = await loadCatalog();
	return { source: catalog.source, asOf: catalog.asOf };
}

/** Drop the in-memory catalog so the next lookup loads it again. */
export function resetModelsDevCatalog(): void {
	catalogCache = null;
	catalogLoadedAt = 0;
	catalogPromise = null;
	idIndexCache = null;
}

// ---------------------------------------------------------------------------
// Catalog entries -> ModelProbeInfo
// ---------------------------------------------------------------------------

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

// The fields both provider entries and lab metadata carry.
function parseSharedFields(model: LabModel): ModelProbeInfo {
	const info: ModelProbeInfo = {};
	const context = model.limit?.context;
	const output = model.limit?.output;
	if (typeof context === "number" && Number.isFinite(context) && context > 0) info.contextWindow = context;
	if (typeof output === "number" && Number.isFinite(output) && output > 0) info.maxTokens = output;
	// Data hygiene: catalogs publish degenerate limits (output == context) for
	// models whose real output cap is unknown — clamp before anyone consumes it.
	if (info.contextWindow !== undefined && info.maxTokens !== undefined) {
		const normalized = normalizeModelLimits(info.contextWindow, info.maxTokens).maxTokens;
		if (normalized !== info.maxTokens) withMetadataProvenance(info, { maxTokens: { source: "api-default", match: "default", infer: true, derivation: "limit-reconciliation" } });
		info.maxTokens = normalized;
	}
	const input = model.modalities?.input;
	if (Array.isArray(input)) {
		info.image = input.includes("image");
		info.video = input.includes("video");
	}
	if (typeof model.reasoning === "boolean") info.reasoning = model.reasoning;
	return info;
}

// Pull the fields we track out of one provider's model entry.
function parseModelEntry(model: Model): ModelProbeInfo | undefined {
	if (!model || typeof model !== "object") return undefined;
	const info = parseSharedFields(model as LabModel);

	const effort = Array.isArray(model.reasoning_options) ? model.reasoning_options.find((o) => o?.type === "effort") : undefined;
	if (info.reasoning !== false && effort && Array.isArray(effort.values)) {
		const values = [...new Set(effort.values.filter((v): v is Exclude<typeof v, null> => typeof v === "string" && v.trim() !== ""))];
		if (values.length) info.effortOptions = values;
	}

	// Catalog list prices, already USD per 1M tokens. Missing cache rates map
	// to 0, matching pi's builtin catalogs.
	const cost = model.cost;
	const rate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
	const input = rate(cost?.input), output = rate(cost?.output);
	if (input !== undefined && output !== undefined) {
		info.cost = { input, output, cacheRead: rate(cost?.cache_read) ?? 0, cacheWrite: rate(cost?.cache_write) ?? 0 };
	}

	return Object.keys(info).length > 0 ? info : undefined;
}

// The provider catalog: id -> { baseUrl, env, ... } for every provider with
// an OpenAI-compatible endpoint. Cached for the session.
export async function fetchModelsDevProviders(): Promise<Map<string, ModelsDevProvider>> {
	const catalog = await loadCatalog();
	const out = new Map<string, ModelsDevProvider>();
	for (const provider of Object.values(catalog.providers)) {
		if (!provider || typeof provider !== "object") continue;
		const entry = toProviderEntry(provider);
		if (entry) out.set(entry.id, entry);
	}
	if (out.size === 0) throw new Error("models.dev catalog contained no usable providers");
	return out;
}

/**
 * Model metadata for one provider, keyed by model id. Empty map when the
 * provider id is unknown.
 *
 * `requireLive` rejects instead of answering from a published snapshot (CDN
 * or bundled). Use it before treating the table as the truth to SYNC against:
 * a snapshot can predate what this machine already saw, so "missing from the
 * table" would not mean "removed upstream".
 */
export async function fetchModelsDevModels(providerId: string, options: { requireLive?: boolean } = {}): Promise<Map<string, ModelProbeInfo>> {
	const catalog = await loadCatalog();
	if (options.requireLive && catalog.source !== "live" && catalog.source !== "cache") {
		const date = catalog.asOf > 0 ? new Date(catalog.asOf).toISOString().slice(0, 10) : "an unknown date";
		throw new Error(`models.dev is unreachable — only an offline snapshot from ${date} is available`);
	}
	const out = new Map<string, ModelProbeInfo>();
	const models = Object.hasOwn(catalog.providers, providerId) ? catalog.providers[providerId]?.models : undefined;
	if (models && typeof models === "object") {
		for (const [id, model] of Object.entries(models)) {
			const info = parseModelEntry(model);
			if (info) {
				const sources: MetadataProvenance = {};
				const reference: MetadataReference = { modelId: id, providerId, ...((model as any).canonical_model_id ? { canonicalModelId: (model as any).canonical_model_id } : {}) };
				for (const field of METADATA_FIELDS) if (info[field] !== undefined) {
					const inherited = getMetadataProvenance(info)[field];
					sources[field] = inherited?.derivation ? { ...inherited, references: [reference] } : { source: "models.dev", match: "exact", infer: false, referenceModelId: id, references: [reference], candidate: id };
				}
				out.set(id, withMetadataProvenance(info, sources));
			}
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

// ---------------------------------------------------------------------------
// Catalog-wide id index
// ---------------------------------------------------------------------------

// Relay gateways (api.88api.ai, ...) are not in the catalog, so a base-URL
// match finds nothing even for a perfectly well-known model id. Every catalog
// model is therefore indexed by id — and by the segment after the last "/" for
// ids like "openai/gpt-6.1-sol". What an id resolves to:
//
//   - a proprietary model: the numbers its maker published (models.dev's lab
//     metadata, reached through the entries' canonical_model_id). A relay
//     resells the maker's API, so those are the numbers that apply.
//   - an open-weights model, or an id the labs don't list: per field, the
//     value most providers publish. Every host runs open weights with its own
//     limits, so the common value is a better guess than the architecture's
//     theoretical maximum.
//
// Prices and named effort levels come from a single offering per field.
// Prefer the maker's offering when available and keep its provider in the trace.
type Vote<V> = Map<V, number>;
const REFERENCE_FIELDS = ["cost", "effortOptions"] as const;
type ReferenceOffer = Pick<ModelProbeInfo, typeof REFERENCE_FIELDS[number]> & { reference: MetadataReference };

type IdVotes = {
	contextWindow: Vote<number>;
	maxTokens: Vote<number>;
	image: Vote<boolean>;
	video: Vote<boolean>;
	reasoning: Vote<boolean>;
	canonical: Vote<string>;
	references: Partial<Record<MetadataField, Map<number | boolean, MetadataReference[]>>>;
	canonicalReferences: Map<string, MetadataReference[]>;
	offers: ReferenceOffer[];
};

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
	const labModels = catalog.models;

	const votes = new Map<string, IdVotes>();
	const canonicalOffers = new Map<string, ReferenceOffer[]>();
	for (const [providerId, provider] of Object.entries(catalog.providers)) {
		const models = provider?.models;
		if (!models || typeof models !== "object") continue;
		for (const [catalogId, model] of Object.entries(models)) {
			const info = parseModelEntry(model as Model);
			if (!info) continue;
			const canonical = model.canonical_model_id;
			const reference: MetadataReference = { modelId: catalogId, providerId, ...(canonical ? { canonicalModelId: canonical } : {}),
				...(getMetadataProvenance(info).maxTokens?.derivation ? { derivedFields: ["maxTokens" as const] } : {}) };
			const offer = info.cost || info.effortOptions ? { cost: info.cost, effortOptions: info.effortOptions, reference } : undefined;
			const offeringLab = canonical ?? `${providerId}/${catalogId}`;
			if (offer && Object.hasOwn(labModels, offeringLab)) {
				const offers = canonicalOffers.get(offeringLab) ?? [];
				offers.push(offer);
				canonicalOffers.set(offeringLab, offers);
			}
			for (const key of indexKeys(catalogId)) {
				let entry = votes.get(key);
				if (!entry) {
					entry = { contextWindow: new Map(), maxTokens: new Map(), image: new Map(), video: new Map(), reasoning: new Map(), canonical: new Map(), references: {}, canonicalReferences: new Map(), offers: [] };
					votes.set(key, entry);
				}
				bump(entry.contextWindow, info.contextWindow);
				bump(entry.maxTokens, info.maxTokens);
				bump(entry.image, info.image);
				bump(entry.video, info.video);
				bump(entry.reasoning, info.reasoning);
				if (offer) entry.offers.push(offer);
				for (const field of ["contextWindow", "maxTokens", "image", "video", "reasoning"] as const) {
					const value = info[field];
					if (value === undefined) continue;
					const byValue = entry.references[field] ??= new Map();
					const refs = byValue.get(value) ?? [];
					refs.push(reference); byValue.set(value, refs);
				}
				if (typeof canonical === "string" && Object.hasOwn(labModels, canonical)) {
					bump(entry.canonical, canonical);
					const refs = entry.canonicalReferences.get(canonical) ?? [];
					refs.push(reference); entry.canonicalReferences.set(canonical, refs);
				}
			}
		}
	}

	// Lab models reachable by their own name, for ids no provider entry points at.
	const labByKey = new Map<string, string>();
	for (const labId of Object.keys(labModels)) {
		for (const key of indexKeys(labId)) if (!labByKey.has(key)) labByKey.set(key, labId);
	}

	const index = new Map<string, ModelProbeInfo>();
	for (const key of new Set([...votes.keys(), ...labByKey.keys()])) {
		const entry = votes.get(key);
		const voted: ModelProbeInfo = {};
		if (entry) {
			const contextWindow = winner(entry.contextWindow);
			const maxTokens = winner(entry.maxTokens);
			const image = winner(entry.image);
			const video = winner(entry.video);
			const reasoning = winner(entry.reasoning);
			if (contextWindow !== undefined) voted.contextWindow = contextWindow;
			if (maxTokens !== undefined) voted.maxTokens = maxTokens;
			if (image !== undefined) voted.image = image;
			if (video !== undefined) voted.video = video;
			if (reasoning !== undefined) voted.reasoning = reasoning;
		}

		const labId = (entry ? winner(entry.canonical) : undefined) ?? labByKey.get(key);
		const lab = labId ? labModels[labId] : undefined;
		const published = lab && typeof lab === "object" ? parseSharedFields(lab) : {};
		const info: ModelProbeInfo = lab && lab.open_weights !== true ? { ...voted, ...published } : { ...published, ...voted };
		const sources: MetadataProvenance = {};
		for (const field of ["contextWindow", "maxTokens", "image", "video", "reasoning"] as const) {
			if (info[field] === undefined) continue;
			const fromLab = published[field] !== undefined && (lab?.open_weights !== true || voted[field] === undefined);
			const references = fromLab && labId
				? [{ modelId: labId, canonicalModelId: labId }, ...(entry?.canonicalReferences.get(labId) ?? [])]
				: entry?.references[field]?.get(voted[field]!) ?? [];
			const names = [...new Set(references.map((ref) => ref.modelId))];
			sources[field] = { source: "models.dev", match: references.length > 1 ? "aggregate" : "exact", infer: false,
				referenceModelId: fromLab ? labId : names.length === 1 ? names[0] : undefined, references };
			if ((fromLab && getMetadataProvenance(published)[field]?.derivation) || (!fromLab && references.length > 0 && references.every((ref) => ref.derivedFields?.includes(field)))) {
				sources[field] = { source: "api-default", match: "default", infer: true, derivation: "limit-reconciliation", references };
			}
		}

		const maker = labId?.split("/")[0];
		const offers = [...(entry?.offers ?? []), ...(labId ? canonicalOffers.get(labId) ?? [] : [])]
			.filter(({ reference }) => !labId || !reference.canonicalModelId || reference.canonicalModelId === labId);
		const priority = ({ reference }: ReferenceOffer) => (maker && reference.providerId === maker ? 2 : 0) + (reference.modelId.toLowerCase() === key ? 1 : 0);
		offers.sort((a, b) => priority(b) - priority(a));
		for (const field of REFERENCE_FIELDS) {
			if (field === "effortOptions" && info.reasoning === false) continue;
			const offer = offers.find((row) => row[field] !== undefined);
			if (!offer) continue;
			if (field === "cost") info.cost = offer.cost;
			else info.effortOptions = offer.effortOptions;
			sources[field] = { source: "models.dev", match: "exact", infer: true, referenceModelId: offer.reference.modelId, references: [offer.reference] };
		}

		// The two limits can now come from different sources — keep them coherent.
		if (info.contextWindow !== undefined && info.maxTokens !== undefined) {
			const output = normalizeModelLimits(info.contextWindow, info.maxTokens).maxTokens;
			if (output !== info.maxTokens) sources.maxTokens = { source: "api-default", match: "default", infer: true, derivation: "limit-reconciliation", references: sources.maxTokens?.references };
			info.maxTokens = output;
		}
		if (Object.keys(info).length > 0) index.set(key, withMetadataProvenance(info, sources));
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
			if (!info) continue;
			const sources = getMetadataProvenance(info);
			for (const field of METADATA_FIELDS) {
				const source = sources[field];
				if (source?.source !== "models.dev") continue;
				const exact = candidate === id && source.references?.some((ref) => ref.modelId === id);
				const aggregate = source.match === "aggregate" && !source.referenceModelId;
				sources[field] = { ...source, candidate, infer: source.infer || !exact || aggregate, match: exact ? source.match : "normalized" };
			}
			out.set(id, withMetadataProvenance({ ...info }, sources));
			break;
		}
	}
	return out;
}

// The catalog provider serving a probed base URL, if any.
async function providerIdForBaseUrl(baseUrl: string): Promise<string | undefined> {
	const providers = await fetchModelsDevProviders();
	for (const provider of providers.values()) {
		if (sameBaseUrl(provider.baseUrl, baseUrl)) return provider.id;
	}
	try {
		const url = new URL(baseUrl);
		return PROBED_HOST_ALIASES.find((alias) => alias.matches(url))?.providerId;
	} catch {
		return undefined;
	}
}

// Model metadata for the provider serving this base URL. When `ids` is given,
// any model the host's own catalog entry does not cover is looked up by id
// across the whole catalog — a relay gets real metadata instead of nothing.
export async function fetchModelsDevInfoForBaseUrl(baseUrl: string, ids?: string[]): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	try {
		const providerId = await providerIdForBaseUrl(baseUrl);
		if (providerId) {
			const provider = await fetchModelsDevModels(providerId);
			for (const [id, info] of provider) out.set(id, info);
			for (const id of ids ?? []) {
				if (out.has(id)) continue;
				for (const candidate of normalizeModelIdCandidates(id)) {
					const info = provider.get(candidate);
					if (!info) continue;
					const sources = getMetadataProvenance(info);
					for (const field of METADATA_FIELDS) {
						const source = sources[field];
						if (source?.source === "models.dev") sources[field] = { ...source, candidate, match: "normalized", infer: true };
					}
					out.set(id, withMetadataProvenance({ ...info }, sources));
					break;
				}
			}
		}
	} catch {
		// catalog unreachable — try the id index alone below
	}
	if (ids && ids.length > 0) {
		const byId = await fetchModelsDevInfoByModelIds(ids.filter((id) => {
			const info = out.get(id);
			return !info?.cost || (info.reasoning !== false && !info.effortOptions?.length);
		}));
		for (const [id, info] of byId) {
			const host = out.get(id);
			if (!host) { out.set(id, info); continue; }
			const merged = { ...host };
			const sources = getMetadataProvenance(host), references = getMetadataProvenance(info);
			if (!host.cost && info.cost) {
				merged.cost = info.cost;
				sources.cost = references.cost;
			}
			if (!host.effortOptions?.length && host.reasoning !== false && info.effortOptions?.length) {
				merged.effortOptions = info.effortOptions;
				sources.effortOptions = references.effortOptions;
			}
			out.set(id, withMetadataProvenance(merged, sources));
		}
	}
	return out;
}
