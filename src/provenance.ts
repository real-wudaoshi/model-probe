import type { FieldProvenance, MetadataField, MetadataProvenance, ModelProbeInfo, ResolvedModelMetadata } from "./types.ts";

export const METADATA_FIELDS: readonly MetadataField[] = ["contextWindow", "maxTokens", "image", "video", "reasoning", "cost", "alwaysThinking", "effortOptions", "endpointTypes"];
// Keep old public objects flat: detailed traces are opt-in, not enumerable
// properties that break existing consumers' JSON or exact-object comparisons.
const traces = new WeakMap<ModelProbeInfo, MetadataProvenance>();
const has = (fields: readonly string[] | undefined, field: string) => fields?.includes(field) ?? false;

export function getMetadataProvenance(info: ModelProbeInfo | undefined): MetadataProvenance {
	if (!info) return {};
	const recorded = traces.get(info) ?? {};
	const out: MetadataProvenance = {};
	for (const field of METADATA_FIELDS) {
		if (info[field] === undefined) continue;
		out[field] = recorded[field] ?? (has(info.defaultedFields, field) ? { source: "default", match: "default", infer: true }
			: has(info.inferredFields, field) ? { source: "rule", match: "rule", infer: true }
			: has(info.modelsDevFields, field) ? { source: "models.dev", match: "exact", infer: false }
			: { source: "gateway", match: "exact", infer: false });
	}
	return out;
}

export function withMetadataProvenance<T extends ModelProbeInfo>(info: T, provenance: MetadataProvenance): T {
	traces.set(info, { ...provenance });
	return info;
}

export function mergeMetadataInfo(left: ModelProbeInfo | undefined, right: ModelProbeInfo): ModelProbeInfo {
	const info = { ...left, ...right };
	const sources = getMetadataProvenance(left), incoming = getMetadataProvenance(right);
	for (const field of METADATA_FIELDS) if (right[field] !== undefined) sources[field] = incoming[field];
	return withMetadataProvenance(info, sources);
}

function isAuthoritative(source: FieldProvenance | undefined): boolean {
	return !!source && !source.infer && (source.source === "gateway" || source.source === "models.dev" || source.source === "custom");
}

export function isMetadataAuthoritative(info: ModelProbeInfo, field: MetadataField): boolean {
	return isAuthoritative(getMetadataProvenance(info)[field]);
}

export function getMetadataSourceLabel(info: ModelProbeInfo | undefined, field: MetadataField, reasoningLevel = false): string {
	if (reasoningLevel && info?.reasoning === true) {
		if (info.alwaysThinking) return getMetadataSourceLabel(info, "alwaysThinking");
		return info.effortOptions?.length ? getMetadataSourceLabel(info, "effortOptions") : "default";
	}
	if (!info || info[field] === undefined) return "default";
	const value = getMetadataProvenance(info)[field];
	if (!value) return "default";
	const source = value.source === "api-default" ? "default" : value.source === "id-hint" ? "ID hint" : value.source;
	if (!value.infer || value.source === "default" || value.source === "api-default") return source;
	const ids = value.referenceModelId ? [value.referenceModelId] : [...new Set(value.references?.map((ref) => ref.modelId) ?? [])];
	const model = ids.length ? `${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ` +${ids.length - 3}` : ""}` : value.ruleMatch || value.rulePattern || value.candidate;
	const provider = field === "cost" || field === "effortOptions" ? value.references?.[0]?.providerId : undefined;
	const reference = provider && model ? `${model} (${provider})` : model;
	return `infer · ${source}${reference ? ` · ${reference}` : ""}`;
}

export function savedModelMetadata(info: ModelProbeInfo, provenance?: MetadataProvenance): ModelProbeInfo {
	const sources: MetadataProvenance = {};
	for (const field of METADATA_FIELDS) if (info[field] !== undefined) sources[field] = provenance?.[field] ?? { source: "saved", match: "exact", infer: false };
	return withMetadataProvenance({ ...info }, sources);
}

export function mergeWithExistingMetadata(fresh: ModelProbeInfo, existing?: ModelProbeInfo): ModelProbeInfo {
	if (!existing) return fresh;
	const info = { ...fresh }, sources = getMetadataProvenance(fresh), previous = getMetadataProvenance(existing);
	for (const field of METADATA_FIELDS) {
		if ((field === "effortOptions" || field === "alwaysThinking") && previous.reasoning?.source === "custom") {
			delete info[field];
			delete sources[field];
			continue;
		}
		if (existing[field] === undefined) continue;
		if (previous[field]?.source === "custom" || !isMetadataAuthoritative(fresh, field)) {
			(info as Record<string, unknown>)[field] = existing[field];
			sources[field] = previous[field] ?? { source: "saved", match: "exact", infer: false };
		}
	}
	return withMetadataProvenance(info, sources);
}

export function metadataUpdateFields(fresh: ModelProbeInfo, existing: ModelProbeInfo = {}): MetadataField[] {
	const incoming = getMetadataProvenance(fresh), previous = getMetadataProvenance(existing);
	const fields = METADATA_FIELDS.filter((field) => {
		const source = incoming[field];
		if (!source || previous[field]?.source === "custom") return false;
		if (isAuthoritative(source)) return true;
		if (existing[field] !== undefined) return false;
		return source.infer && (source.source === "models.dev" || source.source === "rule" || source.source === "id-hint");
	});
	const reasoning = fields.includes("reasoning") ? fresh.reasoning : existing.reasoning;
	const context = fields.includes("contextWindow") ? fresh.contextWindow : existing.contextWindow;
	const output = fields.includes("maxTokens") ? fresh.maxTokens : existing.maxTokens;
	return fields.filter((field) => {
		if ((field === "contextWindow" || field === "maxTokens") && context !== undefined && output !== undefined && output > context && !isAuthoritative(incoming[field])) return false;
		if (field !== "effortOptions" && field !== "alwaysThinking") return true;
		if (reasoning === false || previous.reasoning?.source === "custom") return false;
		const other = field === "effortOptions" ? "alwaysThinking" : "effortOptions";
		return !existing[other] || isAuthoritative(incoming[field]);
	});
}

export function markCustomMetadata(info: ModelProbeInfo, fields: readonly MetadataField[], provenance?: MetadataProvenance): ModelProbeInfo {
	const sources = provenance ?? getMetadataProvenance(info);
	for (const field of fields) if (info[field] !== undefined) sources[field] = { source: "custom", match: "exact", infer: false };
	return withMetadataProvenance(info, sources);
}

// Project legacy source arrays only for the opt-in result, preserving the old
// APIs' flat shape and their local-rule-only meaning of inferredFields.
export function resolvedMetadata(id: string, info: ModelProbeInfo): ResolvedModelMetadata {
	const provenance = getMetadataProvenance(info), out = { ...info };
	delete out.modelsDevFields; delete out.inferredFields; delete out.defaultedFields; delete out.inferred;
	for (const field of ["contextWindow", "maxTokens", "image", "video", "reasoning", "cost"] as const) {
		const source = provenance[field]?.source;
		if (source === "models.dev") (out.modelsDevFields ??= []).push(field);
		if (field === "cost") continue;
		if (source === "rule" || source === "id-hint") { (out.inferredFields ??= []).push(field); out.inferred = true; }
		if (source === "default" || source === "api-default") (out.defaultedFields ??= []).push(field);
	}
	return { id, info: withMetadataProvenance(out, provenance), provenance };
}

export const gatewaySource = (): FieldProvenance => ({ source: "gateway", match: "exact", infer: false });
