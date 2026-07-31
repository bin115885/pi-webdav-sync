import fs from "node:fs/promises";
import path from "node:path";
import type { SyncManifest } from "./manifest.js";
import { safeRelativePath } from "./paths.js";

const STATE_VERSION = 1;
const STATE_FILE = "file-modes.json";

type FileModeState = {
	version: typeof STATE_VERSION;
	files: Record<string, number>;
};

export async function saveFileModes(
	agentDir: string,
	manifest: SyncManifest,
): Promise<void> {
	const files: Record<string, number> = {};
	for (const file of [
		...manifest.files,
		...manifest.externalResources.flatMap((resource) => resource.files),
	]) {
		if (file.mode !== undefined)
			files[safeRelativePath(file.path)] = file.mode & 0o777;
	}
	const state: FileModeState = { version: STATE_VERSION, files };
	const stateDir = path.join(agentDir, ".webdav-sync");
	const statePath = path.join(stateDir, STATE_FILE);
	const tempPath = `${statePath}.${process.pid}.tmp`;
	await fs.mkdir(stateDir, { recursive: true });
	await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await fs.rename(tempPath, statePath);
}

export async function loadFileModes(
	agentDir: string,
): Promise<Map<string, number>> {
	const statePath = path.join(agentDir, ".webdav-sync", STATE_FILE);
	let raw: string;
	try {
		raw = await fs.readFile(statePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw error;
	}
	const state = JSON.parse(raw) as Partial<FileModeState>;
	if (
		state.version !== STATE_VERSION ||
		!state.files ||
		typeof state.files !== "object" ||
		Array.isArray(state.files)
	)
		throw new Error(`Invalid file mode state: ${statePath}`);
	return new Map(
		Object.entries(state.files).map(([filePath, mode]) => {
			if (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
				throw new Error(`Invalid file mode for ${filePath}: ${mode}`);
			return [safeRelativePath(filePath), mode];
		}),
	);
}

export const selectFileMode = (
	actualMode: number | undefined,
	preservedMode: number | undefined,
	platform = process.platform,
): number | undefined =>
	platform === "win32" ? (preservedMode ?? actualMode) : actualMode;
