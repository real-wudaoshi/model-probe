#!/usr/bin/env node
// model-probe CLI: probe an OpenAI-compatible gateway for models + metadata.
//
//   model-probe <baseUrl> [--key <apiKey>] [--ollama] [--api <flavor>] [--developer-role] [--no-fallback] [--json]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelProbeInfo } from "./src/types.ts";
import { isLocalHost, normalizeBaseUrl } from "./src/url.ts";

const HELP = `Usage: model-probe <baseUrl> [options]

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

The base URL may omit the scheme and the /v1 suffix; both variants are tried.
HTTP_PROXY / HTTPS_PROXY / NO_PROXY are honored (local gateways are reached
directly).`;

// ---------------------------------------------------------------------------
// Proxy support
//
// Node's fetch ignores HTTP_PROXY / HTTPS_PROXY unless the process was started
// with NODE_USE_ENV_PROXY=1 — the variable is read once at startup. A probe
// that silently bypasses the user's proxy just times out, so when a proxy is
// configured the CLI restarts itself once with the switch on.
function proxyConfigured(): boolean {
	return ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((name) => (process.env[name] ?? "").trim() !== "");
}

function runtimeSupportsEnvProxy(): boolean {
	const [major, minor] = process.versions.node.split(".").map(Number);
	return major >= 24 || (major === 22 && minor >= 21);
}

// A proxy is configured, but this process was not started in a way that uses
// it. (Bun's fetch honors the proxy variables by itself.)
const proxyIgnored =
	proxyConfigured() && !process.versions.bun && process.env.NODE_USE_ENV_PROXY === undefined && !process.execArgv.includes("--use-env-proxy");

// Restart with the proxy switched on. A gateway on this machine or the local
// network is exempted: with the switch on, Node would otherwise send even
// localhost requests to the proxy.
function relaunchThroughProxy(baseUrl: string): void {
	if (!proxyIgnored || !runtimeSupportsEnvProxy()) return;
	const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: "1" };
	try {
		const hostname = new URL(normalizeBaseUrl(baseUrl)).hostname;
		if (isLocalHost(hostname)) {
			const existing = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
			const merged = [...new Set([...existing, hostname.replace(/^\[|\]$/g, ""), "localhost", "127.0.0.1"])].join(",");
			env.NO_PROXY = merged;
			env.no_proxy = merged;
		}
	} catch {
		// Unreadable base URL — the probe itself will report that.
	}
	const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env });
	process.exit(child.status ?? (child.signal ? 130 : 1));
}

// ---------------------------------------------------------------------------
// Arguments

type Options = {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	ollama: boolean;
	developerRole: boolean;
	fallback: boolean;
	json: boolean;
	help: boolean;
	version: boolean;
};

function parseArgs(argv: string[]): Options | { error: string } {
	const options: Options = { ollama: false, developerRole: false, fallback: true, json: false, help: false, version: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		// Both "--key value" and "--key=value".
		const valueOf = (name: string): string | { error: string } | undefined => {
			if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
			if (arg !== name) return undefined;
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) return { error: `${name} needs a value` };
			i++;
			return next;
		};

		const key = valueOf("--key");
		if (key !== undefined) {
			if (typeof key !== "string") return key;
			options.apiKey = key;
			continue;
		}
		const api = valueOf("--api");
		if (api !== undefined) {
			if (typeof api !== "string") return api;
			options.api = api;
			continue;
		}

		if (arg === "-h" || arg === "--help") options.help = true;
		else if (arg === "-v" || arg === "--version") options.version = true;
		else if (arg === "--ollama") options.ollama = true;
		else if (arg === "--developer-role") options.developerRole = true;
		else if (arg === "--no-fallback") options.fallback = false;
		else if (arg === "--json") options.json = true;
		else if (!arg.startsWith("-") && options.baseUrl === undefined) options.baseUrl = arg;
		else return { error: arg.startsWith("-") ? `Unknown option: ${arg}` : `Unexpected argument: ${arg}` };
	}
	return options;
}

function packageVersion(): string {
	// package.json sits next to cli.ts in the sources and one level above dist/cli.js.
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [join(here, "package.json"), join(here, "..", "package.json")]) {
		try {
			if (!existsSync(candidate)) continue;
			const pkg = JSON.parse(readFileSync(candidate, "utf8"));
			if (pkg?.name === "model-probe" && typeof pkg.version === "string") return pkg.version;
		} catch {
			// try the next candidate
		}
	}
	return "unknown";
}

// Ids and messages come from the gateway. Keep control characters (terminal
// escape sequences) out of the terminal.
function printable(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

const METADATA_FIELDS = ["contextWindow", "maxTokens", "image", "video", "reasoning", "cost"] as const;

// Where the best information about a model came from.
function metadataSource(info: ModelProbeInfo | undefined): "gateway" | "modelsDev" | "rules" | "none" {
	if (!info) return "none";
	const tagged = new Set<string>([...(info.modelsDevFields ?? []), ...(info.inferredFields ?? []), ...(info.defaultedFields ?? [])]);
	if (METADATA_FIELDS.some((field) => info[field] !== undefined && !tagged.has(field))) return "gateway";
	if ((info.modelsDevFields ?? []).length > 0) return "modelsDev";
	if ((info.inferredFields ?? []).length > 0) return "rules";
	return "none";
}

// ---------------------------------------------------------------------------

const parsed = parseArgs(process.argv.slice(2));
if ("error" in parsed) {
	console.error(`${parsed.error}\n\n${HELP}`);
	process.exitCode = 2;
} else if (parsed.help) {
	console.log(HELP);
} else if (parsed.version) {
	console.log(packageVersion());
} else if (!parsed.baseUrl) {
	console.error(`Missing <baseUrl>\n\n${HELP}`);
	process.exitCode = 2;
} else {
	relaunchThroughProxy(parsed.baseUrl);
	await run(parsed, parsed.baseUrl);
}

async function run(options: Options, baseUrl: string): Promise<void> {
	const { API_FALLBACK_LIMITS, describeProbeInfo, detectModels } = await import("./index.ts");

	if (options.api !== undefined && !Object.hasOwn(API_FALLBACK_LIMITS, options.api)) {
		console.error(
			`Warning: unknown --api flavor "${printable(options.api)}" — expected one of ${Object.keys(API_FALLBACK_LIMITS).join(", ")}. Protocol-level fallback limits are off.`,
		);
	}

	try {
		const result = await detectModels(baseUrl, {
			apiKey: options.apiKey ?? (process.env.MODEL_PROBE_API_KEY || undefined),
			ollama: options.ollama,
			api: options.api,
			knownModelFallback: options.fallback,
			developerRole: options.developerRole,
		});

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						baseUrl: result.baseUrl,
						ids: result.ids,
						models: Object.fromEntries(result.models),
						...(options.developerRole
							? { supportsDeveloperRole: result.supportsDeveloperRole ?? null, developerRoleSource: result.developerRoleSource ?? null }
							: {}),
					},
					null,
					2,
				),
			);
			return;
		}

		console.log(`Base URL: ${printable(result.baseUrl)}`);
		console.log(`Models:   ${result.ids.length}`);
		if (options.developerRole) {
			const note = result.developerRoleSource === "default" ? " (default — probe inconclusive)" : "";
			console.log(`Developer role: ${result.supportsDeveloperRole ? "supported" : "NOT supported"}${note}`);
		}
		const counts = { gateway: 0, modelsDev: 0, rules: 0, none: 0 };
		for (const id of result.ids) {
			const info = result.models.get(id);
			counts[metadataSource(info)]++;
			const description = describeProbeInfo(info);
			console.log(`  ${printable(id)}${description ? ` — ${printable(description)}` : ""}`);
		}
		if (result.ids.length > 0) {
			const summary = options.fallback
				? [
						`${counts.gateway} from the gateway`,
						`${counts.modelsDev} from models.dev`,
						`${counts.rules} from local rules`,
						`${counts.none} defaults only`,
					]
				: [`${counts.gateway} reported by the gateway`, `${counts.none} without metadata (fallbacks are off)`];
			console.log(`\nMetadata: ${summary.join(", ")}`);
		}
	} catch (error) {
		const message = printable(error instanceof Error ? error.message : String(error));
		console.error(message.startsWith("Probe ") ? message : `Probe failed: ${message}`);
		if (proxyIgnored) {
			console.error(
				"Note: HTTP_PROXY/HTTPS_PROXY is set, but this Node version's fetch cannot use it. Upgrade to Node >= 22.21 or >= 24.",
			);
		}
		process.exitCode = 1;
	}
}
