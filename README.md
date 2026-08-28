# model-probe

Probe OpenAI-compatible gateways for their model list and per-model metadata
(context window, image/video input, reasoning, endpoint types). Works with LiteLLM,
One API, New API, OpenRouter, Google's native Gemini API, Ollama, and generic
OpenAI-compatible servers.

Runs on Node >= 22.18 (TypeScript type stripping, no build step).

## What it does

- **Model listing** — `GET {baseUrl}/models`, with automatic ±`/v1` adaptation:
  quirky gateways that hang or 404 on `/v1/models` (or serve their web console
  HTML there) are retried at the other variant, and the base URL that actually
  answered is returned. Non-local `http://` URLs additionally fall back to
  `https://` (many public gateways don't listen on :80 at all). Google's
  native Gemini list shape (`{ models: [{ name: "models/...", inputTokenLimit }] }`)
  is recognized too, and the API key is sent as both `Authorization: Bearer`
  and `x-goog-api-key`.
- **Inline metadata** — OpenRouter-style `context_length` / `architecture`,
  One API / New API `meta` fields and `supported_endpoint_types` carried by
  the `/models` list itself.
- **Gateway-wide endpoints** (one call covers every model):
  - LiteLLM `GET /model/info` and `GET /model_group/info` (server root)
  - New API-style site catalog `GET {site}/api/models/public` (no auth)
- **Per-model details** — `GET /models/{id}`, or Ollama native
  `GET /api/tags` + `POST /api/show`.
- **Local rules** — a built-in table of well-known models (OpenAI, Anthropic,
  DeepSeek, Qwen, Kimi, GLM, Gemini, ...) fills any fields the gateway and
  models.dev didn't report. Fields filled this way are tagged (`inferred` /
  `inferredFields`). Rules are matched against normalized id candidates
  (`normalizeModelIdCandidates`), so relay-decorated ids like
  `bailian/deepseek-v4-pro`, `gpt-5@20250807`, or `claude-sonnet-4-6[1m]`
  still hit the base rule.
  The table is data (`rules.json`), not code — see [Custom rules](#custom-rules).
- **models.dev** — the [models.dev](https://models.dev) catalog fills any
  fields the gateway didn't report, tagged in `modelsDevFields`. Entries are
  exact per-model records, so they outrank the local rules (which are regex
  guesses). Data comes from the official SDK (`@opencode-ai/models`) with
  three sources in order: the live API; then the latest published snapshot
  served from the jsDelivr npm CDN (cached on disk per day — this keeps the
  data fresh on networks where models.dev itself is unreachable); then the
  snapshot bundled with the installed SDK, so the tier also works fully
  offline. Matched per gateway base URL against the catalog's provider list,
  cached for the session, and never blocks a probe. Disable with
  `profile: { modelsDev: false }`. Degenerate catalog limits
  (`maxTokens == contextWindow`) are clamped by `normalizeModelLimits` to
  `min(32K, ctx/4)` before they reach callers.
- **API fallback** — when the gateway, the catalog, and the rules all stay
  silent on a model's limits, the caller's api flavor (`api` option / CLI
  `--api`) supplies protocol-level limits (`API_FALLBACK_LIMITS`: anthropic
  200K/32K, google 1M/64K, openai 258K/32K). Tagged in `defaultedFields`.
- **Defaults** — fields nothing else answered are filled from
  `MODEL_INFO_DEFAULTS` (`image: false`, `video: false`, `reasoning: true`)
  and tagged in
  `defaultedFields`. Priority: detected > models.dev > local rule > api
  fallback > default.
  `describeProbeInfo` only renders values that differ from the defaults
  (defaulted `contextWindow` / `maxTokens` are hidden too — they carry no
  real information about the model).
- **Developer-role probe** (opt-in) — one tiny chat completion with a
  `developer`-role message tells you whether the gateway accepts the OpenAI
  developer role. Gateways that don't (Kimi's subscription endpoint, some
  One API forks) reject it with a 400, and clients must fall back to `system`.
  An inconclusive probe defaults to `false` (`developerRoleSource: "default"`).

All fetches time out after 4s and run with bounded concurrency; everything
beyond the model list itself is best-effort.

## CLI

```sh
npm install -g model-probe

model-probe https://api.openai.com/v1 --key sk-...
model-probe http://localhost:4000          # LiteLLM, no /v1 needed
model-probe http://localhost:11434/v1 --ollama
model-probe https://openrouter.ai/api/v1 --json
```

```
Usage: model-probe <baseUrl> [options]

Options:
  --key <apiKey>     Bearer token for the gateway
  --ollama           Use Ollama native endpoints (/api/tags, /api/show)
  --api <flavor>     pi api flavor (openai-completions, openai-responses,
                     anthropic-messages, google-generative-ai) — enables
                     protocol-level fallback limits
  --developer-role   Also probe whether the gateway accepts the OpenAI
                     "developer" role (one tiny chat completion)
  --no-fallback      Do not fill gaps from the built-in known-model rules
  --json             Print the raw result as JSON
  -h, --help         Show this help
```

## Library

```ts
import { detectModels, probeModels, describeProbeInfo } from "model-probe";

// Full detection: /models + gateway-wide + per-model + local rules.
const result = await detectModels("https://api.example.com/v1", {
	apiKey: "sk-...",
	// profile: { modelInfo: true, publicCatalog: false, ... } — tune which
	// extra endpoints are tried; defaults to trying everything.
	// ollama: true — use Ollama native endpoints instead of /models/{id}.
	// knownModelFallback: false — disable the built-in model table.
	// api: "openai-completions" — the pi api flavor; enables protocol-level
	//   fallback limits when nothing else knows a model's limits.
	// developerRole: true — also probe developer-role support (one tiny
	//   chat completion); result.supportsDeveloperRole is true/false, or
	//   undefined when the probe was inconclusive.
});

console.log(result.baseUrl); // the base that actually answered (±/v1 adapted)
for (const id of result.ids) {
	console.log(id, describeProbeInfo(result.models.get(id)));
}

// Just the model list:
const { ids, infoById, baseUrl } = await probeModels("http://localhost:4000");
```

### API

- `probeModels(baseUrl, apiKey?)` → `{ ids, infoById, baseUrl }`
- `detectModels(baseUrl, options?)` → `ProbeResult & { models, supportsDeveloperRole?, developerRoleSource? }`
- `probeDeveloperRole(baseUrl, apiKey?, modelId)` → `true | false | undefined`
- `fetchGatewayWideInfo(baseUrl, { apiKey?, profile?, ollama? })`
- `fetchPerModelInfo(baseUrl, ids, { apiKey?, ollama? })`
- `finalizeModelInfo(ids, maps, { modelsDev?, api? }?)` — merge metadata maps + local rules + models.dev + api fallback + defaults
- `resolveModelInfo(id, info?, modelsDev?, api?)` — the full fallback chain for one model
- `applyKnownModelFallback(id, info?)` — fill gaps from the local rules
- `normalizeModelIdCandidates(id)` — the id normalization chain (decorated relay ids → base id)
- `normalizeModelLimits(ctx, out)` / `MAX_OUTPUT_TOKEN_CAP` — clamp degenerate catalog limits
- `API_FALLBACK_LIMITS` — protocol-level fallback limits per api flavor
- `applyModelDefaults(info?)` / `MODEL_INFO_DEFAULTS` — the default tier
- `fetchModelsDevProviders()` / `fetchModelsDevModels(providerId)` /
  `fetchModelsDevInfoForBaseUrl(baseUrl)` — the models.dev catalog tier
- `registerKnownModelRules(rules)` / `reloadKnownModelRules()` — extend the rules
- `describeProbeInfo(info)` / `probeInfoSummary(info)` — formatting helpers
- `enrichLiteLLMModelInfo` / `enrichLiteLLMModelGroupInfo` /
  `enrichPublicModelInfo` / `enrichOpenAIModelDetails` /
  `enrichOllamaModelDetails` — individual metadata sources

### Types

```ts
type ModelProbeInfo = {
	contextWindow?: number;
	maxTokens?: number; // max output tokens
	image?: boolean;    // accepts image input
	video?: boolean;    // accepts video input
	reasoning?: boolean;
	alwaysThinking?: boolean;
	effortOptions?: string[];
	endpointTypes?: string[]; // New API / One API supported_endpoint_types
	inferred?: boolean;       // at least one field came from the local rules
	inferredFields?: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning">;
	modelsDevFields?: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning">; // from models.dev
	defaultedFields?: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning">; // api fallback / MODEL_INFO_DEFAULTS
};
```

## Custom rules

The known-model table ships as [`rules.json`](rules.json) and is read at
runtime. Each entry is a regex matched against the model id:

```json
[
	{ "pattern": "^my-model", "contextWindow": 65536, "maxTokens": 8192, "image": true, "video": false, "reasoning": false }
]
```

- `pattern` — RegExp source; `flags` optional, defaults to `"i"`.
- `contextWindow` / `maxTokens` / `image` / `video` / `reasoning` — all optional; omit what you don't know.

To add or override rules, drop a JSON file with the same shape at
`~/.model-probe-rules.json`, or point the `MODEL_PROBE_RULES` env var at any
path. Matching is per-field and first-match-wins: your rules are consulted
before the built-in table, and fields your rule doesn't define still fall
through to built-in rules (e.g. override just `contextWindow` for `gpt-5-mini`
and it keeps the built-in `image`/`reasoning`).

Library users can also register rules in code:

```ts
import { registerKnownModelRules } from "model-probe";

registerKnownModelRules([{ pattern: "^my-model", contextWindow: 65536 }]);
```

## License

MIT
