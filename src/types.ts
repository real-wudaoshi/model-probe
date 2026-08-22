// Best-effort model metadata detected while probing a gateway.
//
// Every field has one of four sources, highest priority first:
//   1. detected   — real data from the gateway (no tag)
//   2. models.dev — exact per-model catalog entries (listed in modelsDevFields)
//   3. local rule — regex guesses from the known-model table (listed in inferredFields)
//   4. default    — filled from MODEL_INFO_DEFAULTS (listed in defaultedFields)
export type ModelProbeInfo = {
	contextWindow?: number;
	vision?: boolean;
	reasoning?: boolean;
	alwaysThinking?: boolean; // reasoning exists but cannot be turned off
	effortOptions?: string[]; // provider reasoning-effort names (none/minimal/low/.../max)
	endpointTypes?: string[]; // New API / One API: supported_endpoint_types (chat, embeddings, ...)
	inferred?: boolean; // at least one field was filled from the local rules
	inferredFields?: Array<"contextWindow" | "vision" | "reasoning">; // which fields came from the local rules
	modelsDevFields?: Array<"contextWindow" | "vision" | "reasoning">; // which fields came from models.dev
	defaultedFields?: Array<"vision" | "reasoning">; // which fields came from MODEL_INFO_DEFAULTS
};

export type ProbeResult = {
	/** Model ids discovered from /models, sorted. */
	ids: string[];
	/** Metadata discovered alongside the listing (inline list fields, Ollama tags, ...). */
	infoById: Map<string, ModelProbeInfo>;
	// The base variant that actually answered /models (may differ from the
	// given baseUrl by a /v1 suffix on quirky gateways).
	baseUrl: string;
};

/**
 * Which extra endpoints to try when probing a gateway:
 * - `modelInfo`: LiteLLM /model/info
 * - `modelGroupInfo`: LiteLLM /model_group/info
 * - `publicCatalog`: USTC/New API style /api/models/public (on the site host)
 * - `perModelDetails`: per-model GET /models/{id}
 * - `modelsDev`: models.dev catalog matched by base URL (sits below the local
 *   rules in priority)
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

export const PROBE_CONCURRENCY = 4;
export const PROBE_TIMEOUT_MS = 4000;
