#!/usr/bin/env node
// model-probe CLI: probe an OpenAI-compatible gateway for models + metadata.
//
//   model-probe <baseUrl> [--key <apiKey>] [--ollama] [--no-fallback] [--json]
//
// Requires Node >= 22.18 (runs TypeScript natively via type stripping).
import { applyKnownModelFallback, describeProbeInfo, detectModels, probeInfoSummary } from "./index.ts";

function usage(): never {
	console.log(`Usage: model-probe <baseUrl> [options]

Options:
  --key <apiKey>    Bearer token for the gateway
  --ollama          Use Ollama native endpoints (/api/tags, /api/show)
  --no-fallback     Do not fill gaps from the built-in known-model rules
  --json            Print the raw result as JSON
  -h, --help        Show this help`);
	process.exit(0);
}

const args = process.argv.slice(2);
let baseUrl: string | undefined;
let apiKey: string | undefined;
let ollama = false;
let knownModelFallback = true;
let json = false;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "-h" || arg === "--help") usage();
	else if (arg === "--key") apiKey = args[++i];
	else if (arg === "--ollama") ollama = true;
	else if (arg === "--no-fallback") knownModelFallback = false;
	else if (arg === "--json") json = true;
	else if (!arg.startsWith("-") && baseUrl === undefined) baseUrl = arg;
	else {
		console.error(`Unknown argument: ${arg}`);
		usage();
	}
}

if (!baseUrl) usage();

try {
	const result = await detectModels(baseUrl, { apiKey, ollama, knownModelFallback });

	if (json) {
		console.log(
			JSON.stringify(
				{
					baseUrl: result.baseUrl,
					ids: result.ids,
					models: Object.fromEntries(result.models),
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	console.log(`Base URL: ${result.baseUrl}`);
	console.log(`Models:   ${result.ids.length}`);
	let detected = 0;
	let inferred = 0;
	for (const id of result.ids) {
		const info = result.models.get(id);
		if (info && !info.inferred && probeInfoSummary(info).length > 0) detected++;
		else if (info?.inferred) inferred++;
		console.log(`  ${id}${describeProbeInfo(info) ? ` — ${describeProbeInfo(info)}` : ""}`);
	}
	console.log(`\nMetadata: ${detected} detected, ${inferred} from local rules, ${result.ids.length - detected - inferred} unknown`);
} catch (error) {
	console.error(`Probe failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
