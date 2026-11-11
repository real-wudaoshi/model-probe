// Best-effort model metadata detected while probing a gateway.
//
// Every field has one of five sources, highest priority first:
//   1. detected   — real data from the gateway (no tag)
//   2. models.dev — exact per-model catalog entries (listed in modelsDevFields)
//   3. local rule — regex guesses from the known-model table, or a context
//                   window spelled out in the id itself, e.g. "[1m]" (listed
//                   in inferredFields)
//   4. api fallback — protocol-level limits when nothing else spoke (listed in defaultedFields)
//   5. default    — filled from MODEL_INFO_DEFAULTS (listed in defaultedFields)

// USD per 1M tokens — pi's ModelCostRates convention (and models.dev's).
// No local-rule or default source: a guessed price is worse than none, so
// cost only ever comes from the gateway itself or the models.dev catalog.
export type ModelCostInfo = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export type ModelProbeInfo = {
	contextWindow?: number;
	maxTokens?: number; // max output tokens
	image?: boolean; // accepts image input
	video?: boolean; // accepts video input
	reasoning?: boolean;
	cost?: ModelCostInfo; // list prices, USD per 1M tokens
	alwaysThinking?: boolean; // reasoning exists but cannot be turned off
	effortOptions?: string[]; // provider reasoning-effort names (none/minimal/low/.../max)
	endpointTypes?: string[]; // New API / One API: supported_endpoint_types (chat, embeddings, ...)
	inferred?: boolean; // at least one field was filled from the local rules
	inferredFields?: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning">; // which fields came from the local rules
	modelsDevFields?: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning" | "cost">; // which fields came from models.dev
	defaultedFields?: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning">; // which fields came from the api fallback / MODEL_INFO_DEFAULTS
};

export type ProbeResult = {
	/** Model ids discovered from /models, sorted. */
	ids: string[];
	/** Metadata discovered alongside the listing (inline list fields, Ollama tags, ...). */
	infoById: Map<string, ModelProbeInfo>;
	// The base that actually answered /models: it may differ from the given
	// baseUrl by a /v1 suffix on quirky gateways, by the scheme (http -> https),
	// or by whatever a redirect led to.
	baseUrl: string;
};

/**
 * Which extra endpoints to try when probing a gateway:
 * - `modelInfo`: LiteLLM /model/info
 * - `modelGroupInfo`: LiteLLM /model_group/info
 * - `publicCatalog`: New API style /api/models/public (on the site host)
 * - `perModelDetails`: per-model GET /models/{id}
 * - `modelsDev`: models.dev catalog matched by base URL, then by model id
 *   (sits above the local rules in priority, below detected values)
 */
export interface DetectProfile {
	modelInfo?: boolean;
	modelGroupInfo?: boolean;
	publicCatalog?: boolean;
	perModelDetails?: boolean;
	modelsDev?: boolean;
}

/** Try every known metadata source. Used when no profile is given. */
export const FULL_PROFILE: Required<DetectProfile> = {
	modelInfo: true,
	modelGroupInfo: true,
	publicCatalog: true,
	perModelDetails: true,
	modelsDev: true,
};

function timeoutFromEnv(): number | undefined {
	const raw = process.env.MODEL_PROBE_TIMEOUT_MS?.trim();
	if (!raw || !/^\d+$/.test(raw)) return undefined;
	const value = Number(raw);
	return value >= 50 && value <= 120_000 ? value : undefined;
}

export const PROBE_CONCURRENCY = 4;
/**
 * How long a probe request may stay silent: the response headers must arrive
 * within it, and no gap between chunks of the body may exceed it. 4 seconds,
 * unless the MODEL_PROBE_TIMEOUT_MS environment variable says otherwise (for
 * slow links).
 */
export const PROBE_TIMEOUT_MS = timeoutFromEnv() ?? 4000;
