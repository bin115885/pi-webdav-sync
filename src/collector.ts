import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_REMOTE_MODEL, readConfig } from "./config.js";
import { loadFileModes, selectFileMode } from "./file-modes.js";
import {
	createSyncAllowlist,
	isExcludedRelativePath,
	resolveSyncPath,
	safeRelativePath,
	toPosixPath,
} from "./paths.js";
import {
	createManifest,
	type ExternalResourceEntry,
	type ManifestFileEntry,
	sha256Bytes,
	sha256String,
	type SyncManifest,
} from "./manifest.js";
import { rewriteSettingsFile } from "./settings-rewriter.js";
import { filterMcpConfigForSync } from "./mcp-settings.js";

export type CollectedArchive = {
	agentDir: string;
	zipEntries: Map<string, Buffer>;
	manifest: SyncManifest;
	warnings: string[];
};

type MutableExternalResource = {
	id: string;
	originalPathHash: string;
	baseName: string;
	files: ManifestFileEntry[];
};

type CollectState = {
	agentDir: string;
	zipEntries: Map<string, Buffer>;
	manifestFiles: ManifestFileEntry[];
	externalResources: MutableExternalResource[];
	packageSpecs: string[];
	platform: NodeJS.Platform;
	preservedModes: Map<string, number>;
	excludeMcpServers: string[];
	remoteDefaultModel: string;
	warnings: string[];
};

export async function collectAgentArchive(
	agentDir: string,
	platform: NodeJS.Platform = process.platform,
): Promise<CollectedArchive> {
	const resolvedAgentDir = path.resolve(agentDir);
	const config = await readConfig(resolvedAgentDir);
	const allowlist = createSyncAllowlist(
		config?.extraSyncFiles,
		config?.extraSyncDirs,
		resolvedAgentDir,
	);
	const state: CollectState = {
		agentDir: resolvedAgentDir,
		zipEntries: new Map(),
		manifestFiles: [],
		externalResources: [],
		packageSpecs: [],
		platform,
		preservedModes:
			platform === "win32" ? await loadFileModes(resolvedAgentDir) : new Map(),
		warnings: [],
		excludeMcpServers: config?.excludeMcpServers || [],
		remoteDefaultModel: config?.remoteDefaultModel || DEFAULT_REMOTE_MODEL,
	};

	for (const fileName of allowlist.files) {
		const absolutePath = resolveSyncPath(resolvedAgentDir, fileName);
		if (await exists(absolutePath)) {
			if (fileName === "settings.json") {
				await addRewrittenSettings(state, absolutePath);
			} else if (fileName === "mcp.json") {
				await addAllowlistFile(
					state,
					absolutePath,
					fileName,
					filterMcpConfigForSync(
						await fs.readFile(absolutePath),
						state.excludeMcpServers,
					),
				);
			} else {
				await addAllowlistFile(state, absolutePath, fileName);
			}
		}
	}

	for (const dirName of allowlist.dirs) {
		const absolutePath = resolveSyncPath(resolvedAgentDir, dirName);
		if (await exists(absolutePath)) {
			await walkAllowlistPath(state, absolutePath, dirName);
		}
	}

	const manifest = createManifest({
		files: state.manifestFiles,
		externalResources: state.externalResources as ExternalResourceEntry[],
		packageSpecs: state.packageSpecs,
		warnings: state.warnings,
	});
	state.zipEntries.set(
		"manifest.json",
		Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
	);

	return {
		agentDir: resolvedAgentDir,
		zipEntries: new Map(
			[...state.zipEntries.entries()].sort(([a], [b]) => a.localeCompare(b)),
		),
		manifest,
		warnings: manifest.warnings,
	};
}

async function addRewrittenSettings(
	state: CollectState,
	absolutePath: string,
): Promise<void> {
	const config = await readConfig(state.agentDir);
	const allowlist = createSyncAllowlist(
		config?.extraSyncFiles,
		config?.extraSyncDirs,
		state.agentDir,
	);
	const rewrite = await rewriteSettingsFile(
		state.agentDir,
		absolutePath,
		allowlist,
		state.remoteDefaultModel,
	);
	for (const warning of rewrite.warnings) state.warnings.push(warning);
	state.packageSpecs.push(...rewrite.packageSpecs);

	const relativePath = "settings.json";
	addZipEntry(state, `files/${relativePath}`, rewrite.content);
	state.manifestFiles.push(
		fileEntry(
			relativePath,
			rewrite.content,
			selectFileMode(
				await modeOf(absolutePath),
				state.preservedModes.get(relativePath),
				state.platform,
			),
		),
	);

	for (const reference of rewrite.externalReferences) {
		if (!(await exists(reference.sourcePath))) {
			state.warnings.push(
				`External settings path does not exist: ${reference.sourcePath}`,
			);
			continue;
		}
		const resource: MutableExternalResource = {
			id: reference.id,
			originalPathHash: sha256String(toPosixPath(reference.sourcePath)),
			baseName: externalResourceBaseName(reference),
			files: [],
		};
		await walkExternalResource(
			state,
			reference.sourcePath,
			reference.zipRoot,
			resource,
		);
		state.externalResources.push(resource);
	}
}

async function walkAllowlistPath(
	state: CollectState,
	absolutePath: string,
	relativePath: string,
): Promise<void> {
	const stat = await fs.lstat(absolutePath);
	if (stat.isSymbolicLink()) {
		state.warnings.push(`Skipping symlink: ${relativePath}`);
		return;
	}
	if (isExcludedRelativePath(relativePath, stat.isDirectory())) return;
	if (stat.isDirectory()) {
		const children = await fs.readdir(absolutePath);
		children.sort();
		for (const child of children) {
			await walkAllowlistPath(
				state,
				path.join(absolutePath, child),
				path.posix.join(relativePath, child),
			);
		}
		return;
	}
	if (stat.isFile()) {
		await addAllowlistFile(state, absolutePath, relativePath);
	}
}

async function addAllowlistFile(
	state: CollectState,
	absolutePath: string,
	relativePath: string,
	content?: Buffer,
): Promise<void> {
	const stat = await fs.lstat(absolutePath);
	if (stat.isSymbolicLink()) {
		state.warnings.push(`Skipping symlink: ${relativePath}`);
		return;
	}
	if (!stat.isFile() || isExcludedRelativePath(relativePath, false)) return;
	const safeRel = safeRelativePath(relativePath);
	const bytes = content ?? await fs.readFile(absolutePath);
	addZipEntry(state, `files/${safeRel}`, bytes);
	state.manifestFiles.push(
		fileEntry(
			safeRel,
			bytes,
			selectFileMode(
				stat.mode,
				state.preservedModes.get(safeRel),
				state.platform,
			),
		),
	);
}

async function walkExternalResource(
	state: CollectState,
	absolutePath: string,
	zipPath: string,
	resource: MutableExternalResource,
): Promise<void> {
	const stat = await fs.lstat(absolutePath);
	if (stat.isSymbolicLink()) {
		state.warnings.push(
			`Skipping symlink in external resource: ${absolutePath}`,
		);
		return;
	}
	if (isExcludedRelativePath(zipPath, stat.isDirectory())) return;
	if (stat.isDirectory()) {
		const children = await fs.readdir(absolutePath);
		children.sort();
		for (const child of children) {
			const childPath = path.join(absolutePath, child);
			const childZipPath = safeRelativePath(path.posix.join(zipPath, child));
			if (isExcludedRelativePath(child, true)) continue;
			await walkExternalResource(state, childPath, childZipPath, resource);
		}
		return;
	}
	if (stat.isFile()) {
		if (isExcludedRelativePath(zipPath, false)) return;
		const bytes = await fs.readFile(absolutePath);
		addZipEntry(state, zipPath, bytes);
		resource.files.push(
			fileEntry(
				zipPath,
				bytes,
				selectFileMode(
					stat.mode,
					state.preservedModes.get(zipPath),
					state.platform,
				),
			),
		);
	}
}

function externalResourceBaseName(reference: {
	sourcePath: string;
	zipRoot: string;
}): string {
	const parts = safeRelativePath(reference.zipRoot).split("/");
	if (parts[0] === "external-resources" && parts.length >= 3) return parts[2];
	return path.basename(reference.sourcePath) || "resource";
}

function addZipEntry(
	state: CollectState,
	zipPath: string,
	bytes: Buffer,
): void {
	const safePath = safeRelativePath(zipPath);
	if (state.zipEntries.has(safePath)) {
		throw new Error(`Duplicate zip entry: ${safePath}`);
	}
	state.zipEntries.set(safePath, bytes);
}

function fileEntry(
	relativePath: string,
	bytes: Buffer,
	mode?: number,
): ManifestFileEntry {
	return {
		path: safeRelativePath(relativePath),
		type: "file",
		size: bytes.byteLength,
		sha256: sha256Bytes(bytes),
		mode,
	};
}

async function exists(absolutePath: string): Promise<boolean> {
	try {
		await fs.lstat(absolutePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function modeOf(absolutePath: string): Promise<number | undefined> {
	try {
		return (await fs.stat(absolutePath)).mode;
	} catch {
		return undefined;
	}
}
