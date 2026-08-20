export function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}

export function buildProbeUrl(baseUrl: string): string {
	const withSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL("models", withSlash).toString();
}

export function getPath(obj: any, path: string): any {
	let current = obj;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = current[key];
	}
	return current;
}

export function firstFiniteNumber(obj: any, ...paths: string[]): number | undefined {
	for (const path of paths) {
		const value = getPath(obj, path);
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}
