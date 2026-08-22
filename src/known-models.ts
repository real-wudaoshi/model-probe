import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelProbeInfo } from "./types.ts";

// Known-model rules classify well-known model ids and preset their context
// window, image/video input, and reasoning support. Used when a gateway
// exposes no metadata (stock One API / New API, bare proxies, manually added
// models).
//
// Rules are DATA, loaded at runtime (rules.json shipped with the package),
// so users can extend them:
//   - a JSON file at ~/.model-probe-rules.json, or the path in the
//     MODEL_PROBE_RULES env var, is merged in (user rules win on conflicts)
//   - library users can call registerKnownModelRules()
//
// Entry order matters — more specific patterns (e.g. claude-sonnet-4-5) must
// come before their prefix (claude-sonnet-4). Precedence: programmatic rules,
// then the user file, then the built-in table.
export type KnownModelRule = {
	/** RegExp source, e.g. "^gpt-5". */
	pattern: string;
	/** RegExp flags, default "i". */
	flags?: string;
	contextWindow?: number;
	image?: boolean;
	video?: boolean;
	reasoning?: boolean;
};

type CompiledRule = {
	regex: RegExp;
	contextWindow?: number;
	image?: boolean;
	video?: boolean;
	reasoning?: boolean;
};

const BUILTIN_RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "rules.json");

const programmaticRules: KnownModelRule[] = [];
let cache: CompiledRule[] | null = null;

// Register extra rules from library code. They take precedence over both the
// user file and the built-in table.
export function registerKnownModelRules(rules: KnownModelRule[]): void {
	programmaticRules.push(...rules);
	cache = null;
}

// Drop the compiled cache so the next lookup re-reads the rule files.
export function reloadKnownModelRules(): void {
	cache = null;
}

function compileRules(raw: unknown, source: string): CompiledRule[] {
	if (!Array.isArray(raw)) return [];
	const out: CompiledRule[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || typeof entry.pattern !== "string") continue;
		try {
			out.push({
				regex: new RegExp(entry.pattern, typeof entry.flags === "string" ? entry.flags : "i"),
				contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : undefined,
				image: typeof entry.image === "boolean" ? entry.image : undefined,
				video: typeof entry.video === "boolean" ? entry.video : undefined,
				reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
			});
		} catch {
			console.warn(`model-probe: skipping invalid rule in ${source}: ${entry.pattern}`);
		}
	}
	return out;
}

function readRulesFile(path: string): CompiledRule[] {
	try {
		return compileRules(JSON.parse(readFileSync(path, "utf8")), path);
	} catch {
		return [];
	}
}

function userRulesPath(): string {
	return process.env.MODEL_PROBE_RULES || join(homedir(), ".model-probe-rules.json");
}

function loadRules(): CompiledRule[] {
	if (cache) return cache;
	const rules = [...compileRules(programmaticRules, "registerKnownModelRules")];
	const userPath = userRulesPath();
	if (existsSync(userPath)) rules.push(...readRulesFile(userPath));
	rules.push(...readRulesFile(BUILTIN_RULES_PATH));
	cache = rules;
	return rules;
}

// Classify a model id against the rules and return the preset metadata.
// Matching is per-field: the first matching rule that defines a field wins,
// later rules fill fields it didn't define — so a user rule that only sets
// contextWindow still inherits image/video/reasoning from the built-in table.
function matchKnownModelRule(modelId: string): ModelProbeInfo | undefined {
	const info: ModelProbeInfo = {};
	let matched = false;
	for (const rule of loadRules()) {
		if (!rule.regex.test(modelId)) continue;
		matched = true;
		if (info.contextWindow === undefined && rule.contextWindow !== undefined) info.contextWindow = rule.contextWindow;
		if (info.image === undefined && rule.image !== undefined) info.image = rule.image;
		if (info.video === undefined && rule.video !== undefined) info.video = rule.video;
		if (info.reasoning === undefined && rule.reasoning !== undefined) info.reasoning = rule.reasoning;
		if (info.contextWindow !== undefined && info.image !== undefined && info.video !== undefined && info.reasoning !== undefined) break;
	}
	return matched ? info : undefined;
}

// Fill any fields the probe couldn't determine from the known-model rules.
// Real detected values always win; the rules only fill gaps. inferredFields
// records exactly which fields came from the rules.
export function applyKnownModelFallback(modelId: string, info: ModelProbeInfo | undefined): ModelProbeInfo | undefined {
	const known = matchKnownModelRule(modelId);
	if (!known) return info;
	const filled: ModelProbeInfo = {};
	const inferredFields: Array<"contextWindow" | "image" | "video" | "reasoning"> = [];
	if (info?.contextWindow === undefined && known.contextWindow !== undefined) {
		filled.contextWindow = known.contextWindow;
		inferredFields.push("contextWindow");
	}
	if (info?.image === undefined && known.image !== undefined) {
		filled.image = known.image;
		inferredFields.push("image");
	}
	if (info?.video === undefined && known.video !== undefined) {
		filled.video = known.video;
		inferredFields.push("video");
	}
	if (info?.reasoning === undefined && known.reasoning !== undefined) {
		filled.reasoning = known.reasoning;
		inferredFields.push("reasoning");
	}
	if (inferredFields.length === 0) return info;
	return { ...(info ?? {}), ...filled, inferred: true, inferredFields };
}
