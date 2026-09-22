import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const ALLOWLIST_FILES = [
  "settings.json",
  "auth.json",
  "models.json",
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "keybindings.json",
  "mcp.json",
  "zentui.json",
  "pi/web-search.json",
] as const;

export const ALLOWLIST_DIRS = [
  "prompts",
  "skills",
  "extensions",
  "themes",
  "scripts",
  "private",
] as const;

export type SyncAllowlist = {
  files: readonly string[];
  dirs: readonly string[];
  legacyFiles: readonly string[];
  legacyDirs: readonly string[];
};

const PI_ROOT_PREFIX = "pi";
const HOME_ROOT_PREFIX = "home";
const EXCLUDED_DIR_NAMES = new Set([
  "npm",
  "git",
  "node_modules",
  "sessions",
  "cache",
  "logs",
  "webdav-sync",
  ".webdav-sync",
  "local-state",
  ".git",
]);

const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "settings.webdav.json"]);

export function getAgentDir(explicit?: string): string {
  const value = explicit || process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.resolve(expandHome(value));
}

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value));
  return normalized === "." ? "" : normalized;
}

export function safeRelativePath(value: string): string {
  const raw = toPosixPath(value);
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`Unsafe path: ${value}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`Unsafe path: ${value}`);
  }
  return normalized;
}

export function isSafeZipPath(value: string): boolean {
  try {
    safeRelativePath(value);
    return !toPosixPath(value).includes("\\");
  } catch {
    return false;
  }
}

export function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function relativeToAgent(agentDir: string, absolutePath: string): string {
  return toPosixPath(path.relative(agentDir, absolutePath));
}

export function resolveSyncPath(agentDir: string, relativePath: string): string {
  const safeRel = safeRelativePath(relativePath);
  if (safeRel.startsWith(`${HOME_ROOT_PREFIX}/`)) {
    const resolvedAgentDir = path.resolve(agentDir);
    const piDir = path.dirname(resolvedAgentDir);
    const homeDir = path.basename(resolvedAgentDir) === "agent" && path.basename(piDir) === ".pi"
      ? path.dirname(piDir)
      : os.homedir();
    const absolutePath = path.resolve(homeDir, safeRel.slice(HOME_ROOT_PREFIX.length + 1));
    if (!pathInside(homeDir, absolutePath)) throw new Error(`Unsafe home sync path: ${relativePath}`);
    return absolutePath;
  }
  if (safeRel.startsWith(`${PI_ROOT_PREFIX}/`)) {
    const piDir = path.dirname(path.resolve(agentDir));
    const absolutePath = path.resolve(piDir, safeRel.slice(PI_ROOT_PREFIX.length + 1));
    if (!pathInside(piDir, absolutePath)) throw new Error(`Unsafe Pi sync path: ${relativePath}`);
    return absolutePath;
  }
  const resolvedAgentDir = path.resolve(agentDir);
  const absolutePath = path.resolve(resolvedAgentDir, safeRel);
  if (!pathInside(resolvedAgentDir, absolutePath)) throw new Error(`Unsafe agent sync path: ${relativePath}`);
  return absolutePath;
}

export function normalizeConfiguredSyncPath(value: string): string {
  const safePath = safeRelativePath(value);
  return safePath.startsWith(`${HOME_ROOT_PREFIX}/`)
    ? safePath
    : safeRelativePath(path.posix.join(PI_ROOT_PREFIX, safePath));
}

export function createSyncExclusions(
  values: readonly string[] = [],
  agentDir = getAgentDir(),
): readonly string[] {
  return [...new Set(values.map((value) => resolveSyncPath(agentDir, normalizeConfiguredSyncPath(value))))];
}

export function isSyncPathExcluded(
  agentDir: string,
  relativePath: string,
  exclusions: readonly string[],
): boolean {
  const absolutePath = resolveSyncPath(agentDir, relativePath);
  return exclusions.some((excludedPath) => pathInside(excludedPath, absolutePath));
}

export function isExcludedRelativePath(relativePath: string, isDirectory = false): boolean {
  const rel = normalizeRelativePath(relativePath);
  if (!rel) return false;
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((part) => EXCLUDED_DIR_NAMES.has(part))) return true;
  const base = parts[parts.length - 1] || "";
  if (!isDirectory && parts.slice(-2).join("/") === "anysearch/runtime.conf") return true;
  if (!isDirectory && EXCLUDED_FILE_NAMES.has(base)) return true;
  if (!isDirectory && /(^|[.-])log$/i.test(base)) return true;
  if (!isDirectory && /\.log$/i.test(base)) return true;
  if (!isDirectory && /\.(tmp|temp|swp)$/i.test(base)) return true;
  return false;
}

const AGENTS_MODEL_FILE = /^AGENTS\..+\.md$/i;

export function createSyncAllowlist(
  extraFiles: readonly string[] = [],
  extraDirs: readonly string[] = [],
  agentDir?: string,
): SyncAllowlist {
  const toConfiguredPath = normalizeConfiguredSyncPath;
  // 自动收集 agent 根目录下的 AGENTS.<model>.md（如 AGENTS.grok.md / AGENTS.deepseek.md），
  // 避免每新增一个模型规则文件都要手动加 extraSyncFiles。
  const agentsFiles = listAgentModelFiles(agentDir).map((f) =>
    toConfiguredPath(`agent/${f}`),
  );
  return {
    files: [...new Set([...ALLOWLIST_FILES, ...extraFiles.map(toConfiguredPath), ...agentsFiles])],
    dirs: [...new Set([...ALLOWLIST_DIRS, ...extraDirs.map(toConfiguredPath)])],
    legacyFiles: extraFiles.map(safeRelativePath),
    legacyDirs: extraDirs.map(safeRelativePath),
  };
}

function listAgentModelFiles(agentDir?: string): string[] {
  try {
    return fs.readdirSync(agentDir ?? getAgentDir()).filter((f) => AGENTS_MODEL_FILE.test(f));
  } catch {
    return [];
  }
}

export function isAllowlistedRelativePath(
  relativePath: string,
  allowlist = createSyncAllowlist(),
): boolean {
  const rel = normalizeRelativePath(relativePath);
  if (allowlist.files.includes(rel) || allowlist.legacyFiles.includes(rel)) return true;
  return [...allowlist.dirs, ...allowlist.legacyDirs].some(
    (dir) => rel === dir || rel.startsWith(`${dir}/`),
  );
}

export function resolveMaybeRelativePath(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(baseDir, expanded);
}

export function externalResourceZipRoot(id: string, baseName: string): string {
  return safeRelativePath(path.posix.join("external-resources", id, baseName));
}
