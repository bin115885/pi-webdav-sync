import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distUrl = (relativePath) =>
	pathToFileURL(path.join(root, "dist/src", relativePath)).href;
const { collectAgentArchive } = await import(distUrl("collector.js"));
const { isExcludedRelativePath } = await import(distUrl("paths.js"));
const { saveFileModes } = await import(distUrl("file-modes.js"));
const { createManifest } = await import(distUrl("manifest.js"));
const { isRemotePackageSpec } = await import(distUrl("package-specs.js"));
const { createLatestZip, listZipEntries, parseArchive } = await import(
	distUrl("zip-store.js")
);
const { runWebdavSyncCommand } = await import(distUrl("commands.js"));
const { loadBackup, applyArchiveToAgent } = await import(distUrl("backup.js"));

class MemoryBackend {
	files = new Map();
	async getJson(remotePath) {
		const bytes = await this.getBytes(remotePath);
		return JSON.parse(Buffer.from(bytes).toString("utf8"));
	}
	async getBytes(remotePath) {
		const bytes = this.files.get(remotePath);
		if (!bytes) throw new Error(`missing remote file: ${remotePath}`);
		return bytes;
	}
	async putJson(remotePath, data) {
		this.files.set(
			remotePath,
			Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8"),
		);
	}
	async putBytes(remotePath, bytes) {
		this.files.set(remotePath, Buffer.from(bytes));
	}
	async exists(remotePath) {
		return this.files.has(remotePath);
	}
	async list() {
		return [...this.files.keys()]
			.sort()
			.map((file) => ({ path: file, type: "file" }));
	}
}

const tempRoot = await fs.mkdtemp(
	path.join(os.tmpdir(), "pi-webdav-sync-test-"),
);
const sourceAgent = path.join(tempRoot, "source-pi", "agent");
const targetAgent = path.join(tempRoot, "target-pi", "agent");
const initAgent = path.join(tempRoot, "init-pi", "agent");
const externalDir = path.join(tempRoot, "external package");

try {
	assert.equal(isExcludedRelativePath("local-state", true), true, "local state should never be synchronized");
	const initCreated = await runWebdavSyncCommand(["init"], {
		agentDir: initAgent,
	});
	assert.equal(initCreated.ok, true, "init should create config template");
	const initConfigPath = path.join(initAgent, "settings.webdav.json");
	const initConfig = JSON.parse(await fs.readFile(initConfigPath, "utf8"));
	assert.equal(
		initConfig.backend,
		"webdav",
		"init template should be WebDAV config",
	);
	assert.equal(
		initConfig.passwordEnv,
		"PI_WEBDAV_PASSWORD",
		"init template should prefer passwordEnv",
	);
	const initExisting = await runWebdavSyncCommand(["init"], {
		agentDir: initAgent,
	});
	assert.match(
		initExisting.text,
		/init: exists/,
		"init should not overwrite existing config by default",
	);
	initConfig.remoteDir = "/custom";
	await fs.writeFile(
		initConfigPath,
		`${JSON.stringify(initConfig, null, 2)}\n`,
		"utf8",
	);
	let askedOverwritePath;
	const initOverwrite = await runWebdavSyncCommand(["init"], {
		agentDir: initAgent,
		confirmOverwriteConfig: async (filePath) => {
			askedOverwritePath = filePath;
			return true;
		},
	});
	assert.match(
		initOverwrite.text,
		/init: overwritten/,
		"init should overwrite when confirmed",
	);
	assert.equal(
		askedOverwritePath,
		initConfigPath,
		"init overwrite should expose config path",
	);
	assert.notEqual(
		JSON.parse(await fs.readFile(initConfigPath, "utf8")).remoteDir,
		"/custom",
		"init overwrite should replace existing config",
	);
	const remoteInit = await runWebdavSyncCommand(
		["init", "https://example.invalid/pi-webdav.json"],
		{
			agentDir: initAgent,
			confirmOverwriteConfig: async () => true,
			fetchRemoteConfig: async (url) => ({
				backend: "webdav",
				remoteBaseUrl: url.replace("pi-webdav.json", "dav/"),
				username: "remote-user@example.com",
				passwordEnv: "REMOTE_WEBDAV_PASSWORD",
				remoteDir: "/remote-sync",
				installMissingPackages: "never",
				backupRetention: 3,
			}),
		},
	);
	assert.match(
		remoteInit.text,
		/source: remote config/,
		"init should report remote config source",
	);
	const remoteConfig = JSON.parse(await fs.readFile(initConfigPath, "utf8"));
	assert.equal(
		remoteConfig.remoteBaseUrl,
		"https://example.invalid/dav/",
		"init remote URL should write fetched config",
	);
	assert.equal(
		remoteConfig.passwordEnv,
		"REMOTE_WEBDAV_PASSWORD",
		"init remote URL should preserve fetched passwordEnv",
	);
	const remoteTextInit = await runWebdavSyncCommand(
		["init", "https://example.invalid/plain-config.txt"],
		{
			agentDir: initAgent,
			confirmOverwriteConfig: async () => true,
			fetchRemoteConfig: async () =>
				[
					"{",
					'  "backend": "webdav",',
					'  "remoteBaseUrl": "https://plain.example/dav/",',
					'  "username": "plain-user@example.com",',
					'  "passwordEnv": "PLAIN_WEBDAV_PASSWORD",',
					'  "remoteDir": "/plain-sync"',
					"}",
				].join("\n"),
		},
	);
	assert.match(
		remoteTextInit.text,
		/source: remote config/,
		"init should accept remote text config",
	);
	assert.equal(
		JSON.parse(await fs.readFile(initConfigPath, "utf8")).remoteBaseUrl,
		"https://plain.example/dav/",
		"init remote text should write fetched text",
	);
	const badRemoteInit = await runWebdavSyncCommand(
		["init", "file:///bad.json"],
		{
			agentDir: path.join(tempRoot, "bad-init-agent"),
		},
	);
	assert.equal(
		badRemoteInit.ok,
		false,
		"init should reject non-http remote config URLs",
	);

	await seedSourceAgent(sourceAgent, externalDir);
	await writeTestConfig(sourceAgent);

	const collected = await collectAgentArchive(sourceAgent);
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	const zipEntries = listZipEntries(zip.zipBytes);
	assert(
		isRemotePackageSpec("pi-skills"),
		"bare package names should be remote package specs",
	);
	assert(
		isRemotePackageSpec("@org/pkg"),
		"scoped package names should be remote package specs",
	);
	assert(
		!isRemotePackageSpec("./local-package"),
		"relative paths should not be remote package specs",
	);
	assert(
		collected.manifest.packageSpecs.includes("pi-skills"),
		"bare package names should enter manifest packageSpecs",
	);
	const manifestPaths = collected.manifest.files
		.map((file) => file.path)
		.sort();

	assert(
		manifestPaths.includes("AGENTS.md"),
		"allowlist file should enter manifest",
	);
	assert(
		!manifestPaths.includes("settings.webdav.json"),
		"WebDAV config should not enter manifest",
	);
	assert(
		manifestPaths.includes("pi/agent/AGENTS.grok.md"),
		"configured Pi-root extra sync file should enter manifest",
	);
	assert(
		manifestPaths.includes("pi/web-search.json"),
		"configured Pi-root web search config should enter manifest",
	);
	assert(
		manifestPaths.includes("auth.json"),
		"secret allowlist file should enter manifest",
	);
	assert(
		manifestPaths.includes("skills/good/skill.md"),
		"allowlist directory file should enter manifest",
	);
	assert(
		manifestPaths.includes("extensions/foo/index.js"),
		"allowlist extension file should enter manifest",
	);
	assert(
		manifestPaths.includes("scripts/pi-idea"),
		"allowlist script file should enter manifest",
	);
	const scriptPath = path.join(sourceAgent, "scripts", "pi-idea");
	const scriptMode = collected.manifest.files.find(
		(file) => file.path === "scripts/pi-idea",
	)?.mode;
	if (process.platform !== "win32") assert.equal(scriptMode & 0o777, 0o751, "source mode should enter manifest");
	const modeManifest = process.platform === "win32"
		? {
			...collected.manifest,
			files: collected.manifest.files.map((file) => file.path === "scripts/pi-idea" ? { ...file, mode: 0o751 } : file),
		}
		: collected.manifest;
	await saveFileModes(sourceAgent, modeManifest);
	if (process.platform !== "win32") await fs.chmod(scriptPath, 0o600);
	const windowsCollected = await collectAgentArchive(sourceAgent, "win32");
	assert.equal(
		windowsCollected.manifest.files.find(
			(file) => file.path === "scripts/pi-idea",
		)?.mode,
		0o751,
		"Windows push should reuse modes saved during pull",
	);
	if (process.platform !== "win32") await fs.chmod(scriptPath, 0o751);

	const allPaths = [...manifestPaths, ...zipEntries].join("\n");
	assert(
		!allPaths.includes("npm/pkg"),
		"npm install artifact should be excluded",
	);
	assert(
		!allPaths.includes("git/pkg"),
		"git install artifact should be excluded",
	);
	assert(
		!allPaths.includes("node_modules/bad"),
		"node_modules should be excluded",
	);
	assert(!allPaths.includes("sessions/session"), "sessions should be excluded");
	assert(
		!allPaths.includes(".webdav-sync/config"),
		"webdav-sync config should be excluded",
	);
	assert(!allPaths.includes("pi-crash.log"), "log files should be excluded");
	assert(
		!allPaths.includes("anysearch/runtime.conf"),
		"AnySearch runtime config should be excluded",
	);
	assert(
		allPaths.includes("other/runtime.conf"),
		"unrelated runtime config should remain syncable",
	);

	const legacyAgent = path.join(tempRoot, "legacy-agent");
	const excludedRuntimePath = "scripts/anysearch/runtime.conf";
	const includedRuntimePath = "scripts/other/runtime.conf";
	await applyArchiveToAgent(legacyAgent, {
		manifest: {
			...collected.manifest,
			files: [{ path: excludedRuntimePath }, { path: includedRuntimePath }],
			externalResources: [],
		},
		entries: new Map([
			[`files/${excludedRuntimePath}`, Buffer.from("excluded\n")],
			[`files/${includedRuntimePath}`, Buffer.from("included\n")],
		]),
	});
	assert.equal(
		await exists(path.join(legacyAgent, excludedRuntimePath)),
		false,
		"pull should skip old AnySearch runtime config",
	);
	assert.equal(
		await exists(path.join(legacyAgent, includedRuntimePath)),
		true,
		"pull should restore unrelated runtime config",
	);

	assert.equal(
		collected.manifest.externalResources.length,
		2,
		"settings external paths should be copied as external resources",
	);
	assert(
		zipEntries.some(
			(entry) =>
				entry.startsWith("external-resources/") &&
				entry.endsWith("package.json"),
		),
		"external package file should be in zip",
	);
	assert(
		zipEntries.some(
			(entry) =>
				entry.startsWith("external-resources/") &&
				entry.endsWith("src/index.js"),
		),
		"external nested file should be in zip",
	);

	const rewrittenSettings = collected.zipEntries
		.get("files/settings.json")
		.toString("utf8");
	const remoteSkillPath = JSON.parse(rewrittenSettings).skills[0].replace(
		/^\.\//,
		"",
	);
	assert(
		rewrittenSettings.includes("./external-resources/"),
		"settings external paths should be rewritten",
	);
	assert(
		rewrittenSettings.includes("npm:pi-web-access"),
		"remote npm package spec should be preserved",
	);
	assert(
		!rewrittenSettings.includes(externalDir),
		"rewritten settings should not keep external absolute path",
	);
	for (const key of ["shellPath", "npmCommand", "sessionDir"]) {
		assert(
			!rewrittenSettings.includes(key),
			`local-only ${key} should be omitted from rewritten settings`,
		);
	}

	for (const entry of zipEntries) {
		assert(!entry.startsWith("/"), `zip entry must not be absolute: ${entry}`);
		assert(
			!entry.includes(".."),
			`zip entry must not contain path traversal: ${entry}`,
		);
		assert(
			!entry.includes("\\"),
			`zip entry must not contain backslash: ${entry}`,
		);
	}
	assert.throws(
		() => parseArchive(zip.zipBytes, "0".repeat(64)),
		/zipSha256/,
		"zip hash mismatch should be rejected",
	);
	const badManifest = createManifest({
		files: [
			{
				path: ".webdav-sync/config.json",
				type: "file",
				size: 2,
				sha256:
					"44136fa355b3678a1146ad16f7e8649e94fb4f90eec5f8a7772cc7c5b5d50a14",
			},
		],
		externalResources: [],
		packageSpecs: [],
		warnings: [],
	});
	const badZip = createLatestZip(
		new Map([
			["files/.webdav-sync/config.json", Buffer.from("{}")],
			[
				"manifest.json",
				Buffer.from(`${JSON.stringify(badManifest, null, 2)}\n`, "utf8"),
			],
		]),
		badManifest,
	);
	assert.throws(
		() => parseArchive(badZip.zipBytes, badZip.latest.zipSha256),
		/not allowlisted/,
		"manifest paths outside allowlist should be rejected",
	);

	await writeTestConfig(sourceAgent);
	const cancelledBackend = new MemoryBackend();
	let pushPreview;
	const cancelledPush = await runWebdavSyncCommand(["push"], {
		agentDir: sourceAgent,
		backend: cancelledBackend,
		confirmPush: async (preview) => {
			pushPreview = preview;
			return false;
		},
	});
	assert.equal(cancelledPush.ok, true, "cancelled push should return cleanly");
	assert.equal(
		cancelledBackend.files.size,
		0,
		"cancelled push should not upload",
	);
	assert.equal(
		pushPreview.fileCount,
		zip.latest.fileCount,
		"push confirmation should expose file count",
	);

	const backend = new MemoryBackend();
	const push = await runWebdavSyncCommand(["push"], {
		agentDir: sourceAgent,
		backend,
		confirmPush: async () => true,
	});
	assert.equal(push.ok, true, "confirmed push should upload to backend");
	const remoteKeys = [...backend.files.keys()].sort();
	assert.equal(remoteKeys[0], "latest.json");
	assert.equal(remoteKeys[1], "latest.zip");
	assert.equal(
		remoteKeys.filter(
			(key) => key.startsWith("snapshots/") && key.endsWith(".json"),
		).length,
		1,
	);
	assert.equal(
		remoteKeys.filter(
			(key) => key.startsWith("snapshots/") && key.endsWith(".zip"),
		).length,
		1,
	);

	await seedTargetAgent(targetAgent);
	await writeTestConfig(targetAgent);
	let selectedSnapshot;
	let askedToInstall;
	const installedSpecs = [];
	const pull = await runWebdavSyncCommand(["pull"], {
		agentDir: targetAgent,
		backend,
		selectSnapshot: async (choices) => {
			selectedSnapshot = choices[1]?.id;
			return selectedSnapshot;
		},
		confirmInstallPackages: async (specs) => {
			askedToInstall = specs;
			return true;
		},
		installPackage: async (spec) => {
			installedSpecs.push(spec);
			return 0;
		},
	});
	assert.equal(pull.ok, true, "pull should apply archive");
	assert(
		selectedSnapshot?.startsWith("20"),
		"pull should expose snapshot choices",
	);
	assert.deepEqual(
		askedToInstall,
		["npm:pi-web-access", "pi-skills"],
		"ask mode should prompt for snapshot packages",
	);
	assert.deepEqual(
		installedSpecs,
		["npm:pi-web-access", "pi-skills"],
		"ask mode should install packages when confirmed",
	);
	assert.equal(
		await fs.readFile(path.join(targetAgent, "AGENTS.md"), "utf8"),
		"agent rules\n",
		"pull should restore allowlist file",
	);
	assert.equal(
		await fs.readFile(
			path.join(path.dirname(targetAgent), "web-search.json"),
			"utf8",
		),
		"source web search\n",
		"pull should restore Pi-root web search config",
	);
	if (process.platform === "darwin") {
		assert.equal(
			await exists(path.join(targetAgent, "skills", "good", "skill.md")),
			false,
			"macOS pull should skip agent skills",
		);
		assert.equal(
			(await fs.stat(path.join(targetAgent, "scripts", "pi-idea"))).mode &
				0o777,
			0o751,
			"pull should restore manifest file modes",
		);
	} else {
		assert.equal(
			await fs.readFile(
				path.join(targetAgent, "skills", "good", "skill.md"),
				"utf8",
			),
			"skill\n",
			"pull should restore skill",
		);
	}
	assert.equal(
		await exists(path.join(targetAgent, "old-only.txt")),
		true,
		"non-allowlisted file should not be touched",
	);
	assert.equal(
		await exists(path.join(targetAgent, "extensions", "old")),
		false,
		"allowlisted directory absent from remote should be replaced",
	);
	assert.equal(
		await exists(path.join(targetAgent, "external-resources")),
		true,
		"pull should restore external resources",
	);
	const pulledSettings = await fs.readFile(
		path.join(targetAgent, "settings.json"),
		"utf8",
	);
	if (process.platform === "darwin") {
		assert.deepEqual(
			JSON.parse(pulledSettings).skills,
			["~/.cc-switch/skills"],
			"macOS pull should keep the cc-switch skills path",
		);
		assert.equal(
			await exists(path.join(targetAgent, remoteSkillPath)),
			false,
			"macOS pull should skip remote skills",
		);
	} else {
		const backupAfterPull = await collectAgentArchive(targetAgent);
		assert(
			backupAfterPull.manifest.externalResources.length > 0,
			"backup collection should preserve restored external-resources references",
		);
	}
	assert(
		pulledSettings.includes("./external-resources/"),
		"pulled settings should reference restored external resources",
	);
	assert(
		!pulledSettings.includes(externalDir),
		"pulled settings should not contain source absolute external path",
	);
	for (const key of ["shellPath", "npmCommand", "sessionDir"]) {
		assert(
			!pulledSettings.includes(key),
			`pulled settings should not restore local-only ${key}`,
		);
	}

	const backups = await fs.readdir(
		path.join(targetAgent, ".webdav-sync", "backups"),
	);
	assert.equal(backups.length, 1, "pull should create one local backup");
	const { archive } = await loadBackup(targetAgent, "latest");
	await applyArchiveToAgent(targetAgent, archive);
	assert.equal(
		await fs.readFile(path.join(targetAgent, "AGENTS.md"), "utf8"),
		"old target\n",
		"restore should recover pre-pull file",
	);
	assert.equal(
		await fs.readFile(path.join(targetAgent, "AGENTS.grok.md"), "utf8"),
		"old grok\n",
		"restore should recover configured Pi-root extra sync file",
	);
	assert.equal(
		await fs.readFile(
			path.join(path.dirname(targetAgent), "web-search.json"),
			"utf8",
		),
		"old web search\n",
		"restore should recover Pi-root web search config",
	);
	assert.equal(
		await exists(path.join(targetAgent, "extensions", "old", "old.js")),
		true,
		"restore should recover pre-pull allowlisted dir",
	);

	console.log("self-test passed");
} finally {
	await fs.rm(tempRoot, { recursive: true, force: true });
}

async function seedSourceAgent(agentDir, externalDir) {
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.join(agentDir, "skills", "good"), { recursive: true });
	await fs.mkdir(
		path.join(agentDir, "extensions", "foo", "node_modules", "bad"),
		{ recursive: true },
	);
	await fs.mkdir(path.join(agentDir, "prompts"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "scripts"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "npm", "pkg"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "git", "pkg"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true });
	await fs.mkdir(path.join(agentDir, ".webdav-sync", "backups"), {
		recursive: true,
	});
	await fs.mkdir(path.join(externalDir, "src"), { recursive: true });
	await fs.mkdir(path.join(externalDir, "anysearch"), { recursive: true });
	await fs.mkdir(path.join(externalDir, "other"), { recursive: true });
	await fs.mkdir(path.join(externalDir, "node_modules", "bad"), {
		recursive: true,
	});
	await fs.mkdir(path.join(externalDir, ".git"), { recursive: true });

	await fs.writeFile(path.join(agentDir, "AGENTS.md"), "agent rules\n");
	await fs.writeFile(path.join(agentDir, "AGENTS.grok.md"), "grok rules\n");
	await fs.writeFile(
		path.join(path.dirname(agentDir), "web-search.json"),
		"source web search\n",
	);
	await fs.writeFile(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ token: "secret" }),
	);
	await fs.writeFile(
		path.join(agentDir, "skills", "good", "skill.md"),
		"skill\n",
	);
	await fs.writeFile(
		path.join(agentDir, "extensions", "foo", "index.js"),
		"export default {};\n",
	);
	await fs.writeFile(
		path.join(agentDir, "scripts", "pi-idea"),
		'#!/bin/sh\nexec idea "$@" --wait\n',
	);
	await fs.chmod(path.join(agentDir, "scripts", "pi-idea"), 0o751);
	await fs.writeFile(
		path.join(agentDir, "extensions", "foo", "node_modules", "bad", "bad.js"),
		"bad\n",
	);
	await fs.writeFile(
		path.join(agentDir, "npm", "pkg", "installed.js"),
		"bad\n",
	);
	await fs.writeFile(
		path.join(agentDir, "git", "pkg", "installed.js"),
		"bad\n",
	);
	await fs.writeFile(path.join(agentDir, "sessions", "session.json"), "bad\n");
	await fs.writeFile(
		path.join(agentDir, ".webdav-sync", "state.json"),
		"bad\n",
	);
	await fs.writeFile(path.join(agentDir, "pi-crash.log"), "bad\n");
	await fs.writeFile(
		path.join(externalDir, "anysearch", "runtime.conf"),
		"excluded\n",
	);
	await fs.writeFile(
		path.join(externalDir, "other", "runtime.conf"),
		"included\n",
	);
	await fs.writeFile(
		path.join(externalDir, "package.json"),
		JSON.stringify({ name: "external" }),
	);
	await fs.writeFile(path.join(externalDir, "src", "index.js"), "external\n");
	await fs.writeFile(
		path.join(externalDir, "node_modules", "bad", "bad.js"),
		"bad\n",
	);
	await fs.writeFile(path.join(externalDir, ".git", "config"), "bad\n");

	await fs.writeFile(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				packages: [
					"npm:pi-web-access",
					"pi-skills",
					{ source: externalDir, extensions: ["x"] },
				],
				skills: [path.join(externalDir, "src")],
				shellPath: "/local/only/shell",
				npmCommand: ["local-node-manager", "npm"],
				sessionDir: "/local/only/sessions",
			},
			null,
			2,
		)}\n`,
	);
}

async function writeTestConfig(agentDir) {
	await fs.writeFile(
		path.join(agentDir, "settings.webdav.json"),
		`${JSON.stringify(
			{
				backend: "webdav",
				remoteBaseUrl: "https://example.invalid/dav/",
				username: "user",
				passwordEnv: "PI_WEBDAV_TEST_PASSWORD",
				remoteDir: "/pi",
				extraSyncFiles: ["agent/AGENTS.grok.md"],
			},
			null,
			2,
		)}\n`,
	);
}

async function seedTargetAgent(agentDir) {
	await fs.mkdir(path.join(agentDir, "extensions", "old"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "skills", "old"), { recursive: true });
	await fs.writeFile(path.join(agentDir, "AGENTS.md"), "old target\n");
	await fs.writeFile(path.join(agentDir, "AGENTS.grok.md"), "old grok\n");
	await fs.writeFile(
		path.join(path.dirname(agentDir), "web-search.json"),
		"old web search\n",
	);
	await fs.writeFile(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify({ packages: [] }, null, 2)}\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "extensions", "old", "old.js"),
		"old\n",
	);
	await fs.writeFile(path.join(agentDir, "skills", "old", "old.md"), "old\n");
	await fs.writeFile(path.join(agentDir, "old-only.txt"), "keep\n");
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
