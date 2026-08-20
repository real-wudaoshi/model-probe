# model-probe

Probe OpenAI-compatible gateways for their model list and per-model metadata
(context window, vision, reasoning, endpoint types). Works with LiteLLM,
One API, New API, OpenRouter, Ollama, and generic OpenAI-compatible servers.

Runs on Node >= 22.18 (TypeScript type stripping, no build step).

## What it does

- **Model listing** — `GET {baseUrl}/models`, with automatic ±`/v1` adaptation:
  quirky gateways that hang or 404 on `/v1/models` (or serve their web console
  HTML there) are retried at the other variant, and the base URL that actually
  answered is returned.
- **Inline metadata** — OpenRouter-style `context_length` / `architecture`,
  One API / New API `meta` fields and `supported_endpoint_types` carried by
  the `/models` list itself.
- **Gateway-wide endpoints** (one call covers every model):
  - LiteLLM `GET /model/info` and `GET /model_group/info` (server root)
  - USTC-style site catalog `GET {site}/api/models/public` (no auth)
- **Per-model details** — `GET /models/{id}`, or Ollama native
  `GET /api/tags` + `POST /api/show`.
- **Local rules** — a built-in table of well-known models (OpenAI, Anthropic,
  DeepSeek, Qwen, Kimi, GLM, Gemini, ...) fills any fields the gateway didn't
  report. Fields filled this way are tagged (`inferred` / `inferredFields`).

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
  --key <apiKey>    Bearer token for the gateway
  --ollama          Use Ollama native endpoints (/api/tags, /api/show)
  --no-fallback     Do not fill gaps from the built-in known-model rules
  --json            Print the raw result as JSON
  -h, --help        Show this help
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
- `detectModels(baseUrl, options?)` → `ProbeResult & { models }`
- `fetchGatewayWideInfo(baseUrl, { apiKey?, profile?, ollama? })`
- `fetchPerModelInfo(baseUrl, ids, { apiKey?, ollama? })`
- `finalizeModelInfo(ids, ...maps)` — merge metadata maps + local rules
- `applyKnownModelFallback(id, info?)` — fill gaps from the local rules
- `describeProbeInfo(info)` / `probeInfoSummary(info)` — formatting helpers
- `enrichLiteLLMModelInfo` / `enrichLiteLLMModelGroupInfo` /
  `enrichPublicModelInfo` / `enrichOpenAIModelDetails` /
  `enrichOllamaModelDetails` — individual metadata sources

### Types

```ts
type ModelProbeInfo = {
	contextWindow?: number;
	vision?: boolean;
	reasoning?: boolean;
	alwaysThinking?: boolean;
	effortOptions?: string[];
	endpointTypes?: string[]; // New API / One API supported_endpoint_types
	inferred?: boolean;       // filled from local rules, not the gateway
	inferredFields?: Array<"contextWindow" | "vision" | "reasoning">;
};
```

## License

MIT
