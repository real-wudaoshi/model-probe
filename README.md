# model-probe

Probe OpenAI-compatible gateways for their model list and per-model metadata
(context window, image/video input, reasoning, list prices, endpoint types).
Works with LiteLLM, One API, New API, OpenRouter, Google's native Gemini API,
Ollama, and generic OpenAI-compatible servers.

Runs on Node >= 22 (and Bun). The package ships compiled JavaScript in
`dist/`; working on the TypeScript sources needs Node >= 22.18.

## What it does

- **Model listing** — `GET {baseUrl}/models`, with automatic ±`/v1` adaptation:
  when the base as given does not produce a model list (timeout, 404, a web
  console's HTML, a proxy's 401/403/5xx, an empty list), the other variant is
  tried, and the base URL that actually answered is returned. Non-local
  `http://` URLs additionally fall back to `https://` (many public gateways
  don't listen on :80 at all).
  - The input is forgiving: a missing scheme, a trailing slash, or a pasted
    endpoint URL (`.../chat/completions`, `.../models`) are normalized first.
  - A `200` carrying an error envelope (`{"error": ...}`,
    `{"success": false, ...}`) is reported as the error it is, not as "0 models".
  - Paginated lists are followed (Gemini `nextPageToken`, Anthropic `has_more`).
  - The API key goes in the header the endpoint expects — `Authorization:
    Bearer` by default, `x-goog-api-key` for Google's native API, `x-api-key`
    for Anthropic's — never several at once.
  - Redirects are followed, but the key is only forwarded on the same origin or
    an `http → https` upgrade of the same host, never to another host or port.
- **Inline metadata** carried by the `/models` list itself: OpenRouter
  (`context_length`, `architecture`, `supported_parameters`, `pricing`), Vercel
  AI Gateway, Cerebras, Chutes, DeepInfra, Venice, Novita, Groq, Gemini, and
  One API / New API `meta` fields and `supported_endpoint_types`.
- **Gateway-wide endpoints** (one call covers every model):
  - LiteLLM `GET /model/info` and `GET /model_group/info` (server root)
  - New API-style site catalog `GET {site}/api/models/public` (no auth; the API
    key is never sent to it)
- **Per-model details** — `GET /models/{id}` for models no gateway-wide source
  described, or Ollama native `GET /api/tags` + `POST /api/show` (context
  length, `num_ctx`, vision and thinking capabilities). The per-model round
  stops early once it is clear the gateway has nothing to add there.
- **Local rules** — a built-in table of well-known models (OpenAI, Anthropic,
  DeepSeek, Qwen, Kimi, GLM, Gemini, ...) fills any fields the gateway and
  models.dev didn't report. Fields filled this way are tagged (`inferred` /
  `inferredFields`). Rules are matched against normalized id candidates
  (`normalizeModelIdCandidates`), so relay-decorated ids like
  `bailian/deepseek-v4-pro`, `gpt-5@20250807`, `deepseek/deepseek-r1:free`,
  `gpt-4.1-2025-04-14` or `aws/claude-sonnet-4-5-thinking` still hit the base
  rule. A context window spelled out in the id (`claude-sonnet-4-6[1m]`) is
  honored. The table is data (`rules.json`), not code — see
  [Custom rules](#custom-rules).
- **models.dev** — the [models.dev](https://models.dev) catalog fills any
  fields the gateway didn't report, tagged in `modelsDevFields`. Entries are
  exact per-model records, so they outrank the local rules (which are regex
  guesses). Data comes from the official SDK (`@opencode-ai/models`), in this
  order: the last live download, cached on disk for an hour; the live API; an
  older download (up to a day) when the API is unreachable; the latest
  published snapshot from the jsDelivr npm CDN; the snapshot bundled with the
  installed SDK, so the tier also works fully offline. Everything cached is
  plain JSON in a per-user cache directory (`MODEL_PROBE_CACHE_DIR` to
  override) — the CDN snapshot is parsed as data and never executed. An
  unreachable models.dev is remembered for ten minutes, so it slows down one
  run, not every run.

  Models are matched per gateway base URL against the catalog's provider list,
  then — for every model the host's own entry doesn't cover — by **model id
  across the whole catalog**, so relays that aren't in the catalog still get
  real metadata for well-known ids, with decorated ids matched through the same
  normalization chain as the local rules. The id tier answers a proprietary
  model with what its maker published, and an open-weights model with the
  value most hosts serve. It deliberately carries **no cost** — resellers price
  differently, so prices only come from a base-URL match or from the gateway
  itself. Disable with `profile: { modelsDev: false }`. Degenerate catalog
  limits (`maxTokens == contextWindow`) are clamped by `normalizeModelLimits`
  to `min(32K, ctx/4)` before they reach callers.
- **API fallback** — when the gateway, the catalog, and the rules all stay
  silent on a model's limits, the caller's api flavor (`api` option / CLI
  `--api`) supplies protocol-level limits (`API_FALLBACK_LIMITS`: anthropic
  200K/32K, google 1M/64K, openai 258K/32K). The output fallback never exceeds
  a quarter of a context window that is known. Tagged in `defaultedFields`.
- **Defaults** — fields nothing else answered are filled from
  `MODEL_INFO_DEFAULTS` (`image: false`, `video: false`, `reasoning: true`)
  and tagged in
  `defaultedFields`. Priority: detected > models.dev > local rule > api
  fallback > default.
  `describeProbeInfo` only renders values that differ from the defaults
  (defaulted `contextWindow` / `maxTokens` are hidden too — they carry no
  real information about the model).
- **List prices** — `cost` (USD per 1M tokens: input / output / cacheRead /
  cacheWrite) from the gateway itself (LiteLLM `input_cost_per_token` & co.,
  inline `pricing` in either per-token or per-1M units) or the models.dev
  catalog. There is no local rule or default for cost — a guessed price is
  worse than none.
- **Developer-role probe** (opt-in) — one tiny chat completion with a
  `developer`-role message tells you whether the gateway accepts the OpenAI
  developer role. Gateways that don't (Kimi's subscription endpoint, some
  One API forks) reject it with a 400, and clients must fall back to `system`.
  Only an error that is about the message role counts as a rejection; auth,
  quota and "not a chat model" errors are inconclusive. `detectModels` probes
  with a likely chat model and reports an inconclusive probe as `false`
  (`developerRoleSource: "default"`).

Every request gives up after 4s of silence — no response headers, or a body
that stops arriving (`MODEL_PROBE_TIMEOUT_MS` to change). Requests run with
bounded concurrency; everything beyond the model list itself is best-effort.

## CLI

```sh
npm install -g model-probe

model-probe https://api.openai.com/v1 --key sk-...
model-probe localhost:4000                 # LiteLLM, no scheme or /v1 needed
model-probe http://localhost:11434/v1 --ollama
model-probe https://openrouter.ai/api/v1 --json
```

```
Usage: model-probe <baseUrl> [options]

Options:
  --key <apiKey>     API key for the gateway (or set MODEL_PROBE_API_KEY)
  --ollama           Use Ollama native endpoints (/api/tags, /api/show)
  --api <flavor>     pi api flavor (openai-completions, openai-responses,
                     anthropic-messages, google-generative-ai) — enables
                     protocol-level fallback limits
  --developer-role   Also probe whether the gateway accepts the OpenAI
                     "developer" role (one tiny chat completion)
  --no-fallback      Show only what the gateway itself reports: no models.dev,
                     no built-in rules, no defaults
  --json             Print the raw result as JSON
  -v, --version      Print the version
  -h, --help         Show this help
```

Exit codes: `0` success, `1` the probe failed (reason on stderr), `2` wrong
usage.

`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are honored (Node >= 22.21 or >= 24);
a gateway on this machine or the local network is always reached directly.
Library users: Node's `fetch` only reads those variables when the process is
started with `NODE_USE_ENV_PROXY=1`.

## Library

```ts
import { detectModels, probeModels, describeProbeInfo } from "model-probe";

// Full detection: /models + gateway-wide + per-model + models.dev + local rules.
const result = await detectModels("https://api.example.com/v1", {
	apiKey: "sk-...",
	// profile: { modelInfo: true, publicCatalog: false, ... } — tune which
	// extra endpoints are tried; defaults to trying everything.
	// ollama: true — use Ollama native endpoints instead of /models/{id}.
	// knownModelFallback: false — report only what the gateway itself said
	//   (no models.dev, no built-in table, no defaults).
	// api: "openai-completions" — the pi api flavor; enables protocol-level
	//   fallback limits when nothing else knows a model's limits.
	// developerRole: true — also probe developer-role support (one tiny
	//   chat completion); result.supportsDeveloperRole is true/false and
	//   result.developerRoleSource says whether it was "detected" or is the
	//   "default" after an inconclusive probe.
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
- `probeDeveloperRole(baseUrl, apiKey?, modelId | modelIds)` → `true | false | undefined`
- `chatModelCandidates(ids)` — order ids so likely chat models come first (for the developer-role probe)
- `fetchGatewayWideInfo(baseUrl, { apiKey?, profile?, ollama? })`
- `fetchPerModelInfo(baseUrl, ids, { apiKey?, ollama?, known? })`
- `finalizeModelInfo(ids, maps, { modelsDev?, api? }?)` — merge metadata maps + local rules + models.dev + api fallback + defaults
- `resolveModelInfo(id, info?, modelsDev?, api?)` — the full fallback chain for one model
- `applyKnownModelFallback(id, info?)` — fill gaps from the local rules
- `normalizeModelIdCandidates(id)` — the id normalization chain (decorated relay ids → base id)
- `normalizeBaseUrl(input)` — what `probeModels` does to its input first
- `normalizeModelLimits(ctx, out)` / `MAX_OUTPUT_TOKEN_CAP` — clamp degenerate catalog limits
- `API_FALLBACK_LIMITS` — protocol-level fallback limits per api flavor
- `applyModelDefaults(info?)` / `MODEL_INFO_DEFAULTS` — the default tier
- `fetchModelsDevProviders()` / `fetchModelsDevModels(providerId, { requireLive? }?)` /
  `fetchModelsDevInfoForBaseUrl(baseUrl, ids?)` / `fetchModelsDevInfoByModelIds(ids)` —
  the models.dev catalog tier. `requireLive: true` rejects instead of answering
  from a published snapshot (CDN / bundled): use it before treating a table as
  the truth to sync against, since a snapshot can be older than what this
  machine already saw.
- `getModelsDevCatalogInfo()` → `{ source: "live" | "cache" | "cdn" | "bundled", asOf }`;
  `preloadModelsDevCatalog()`; `resetModelsDevCatalog()`
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
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }; // USD per 1M tokens
	alwaysThinking?: boolean;
	effortOptions?: string[];
	endpointTypes?: string[]; // New API / One API supported_endpoint_types
	inferred?: boolean;       // at least one field came from the local rules
	inferredFields?: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning">;
	modelsDevFields?: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning" | "cost">; // from models.dev
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
and it keeps the built-in `image`/`reasoning`). A file that cannot be parsed is
skipped with a warning on stderr; UTF-8 with a BOM and UTF-16 are fine.

Library users can also register rules in code:

```ts
import { registerKnownModelRules } from "model-probe";

registerKnownModelRules([{ pattern: "^my-model", contextWindow: 65536 }]);
```

## Development

```sh
npm install      # also builds dist/
npm test         # type-check + tests (mock gateways, no network)
npm run build    # compile the sources to dist/
```

## License

MIT
