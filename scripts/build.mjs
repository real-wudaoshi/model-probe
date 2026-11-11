// Build the published package: compile the TypeScript sources to dist/.
//
// Node refuses to strip types from files under node_modules, so the package
// has to ship JavaScript. tsc rewrites the relative ".ts" import specifiers to
// ".js" in the emitted code but leaves them alone in the .d.ts files, so those
// are rewritten here — a declaration file must point at its sibling
// declarations, not at sources that are not shipped.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const compiled = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

function declarationFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...declarationFiles(path));
		else if (entry.name.endsWith(".d.ts")) files.push(path);
	}
	return files;
}

for (const file of declarationFiles(dist)) {
	const source = readFileSync(file, "utf8");
	// from "./x.ts" / import("./x.ts")  ->  "./x.js"
	const rewritten = source.replace(/((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g, "$1$2.js$3");
	if (rewritten !== source) writeFileSync(file, rewritten);
}
