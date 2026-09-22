import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgentDir,
  isExcludedRelativePath,
  safeRelativePath,
} from "./paths.js";

export const DEFAULT_REMOTE_MODEL = "antigravity/gemini-3.8-flash";
export type WebdavSyncConfig = {
  backend: "webdav";
  remoteBaseUrl?: string;
  username?: string;
  passwordEnv?: string;
  password?: string;
  remoteDir?: string;
  installMissingPackages?: "ask" | "always" | "never";
  backupRetention?: number;
  extraSyncFiles?: string[];
  extraSyncDirs?: string[];
  excludeSyncPaths?: string[];
  excludeMcpServers?: string[];
  remoteDefaultModel?: string;
};

export function configDir(agentDir = getAgentDir()): string {
  return agentDir;
}

export function configPath(agentDir = getAgentDir()): string {
  return path.join(configDir(agentDir), "settings.webdav.json");
}

export function stateDir(agentDir = getAgentDir()): string {
  return path.join(agentDir, ".webdav-sync");
}

export function defaultConfig(): WebdavSyncConfig {
  return {
    backend: "webdav",
    remoteDir: "/",
    installMissingPackages: "ask",
    backupRetention: 5,
    remoteDefaultModel: DEFAULT_REMOTE_MODEL,
  };
}

export async function readConfig(agentDir = getAgentDir()): Promise<WebdavSyncConfig | undefined> {
  try {
    const raw = await fs.readFile(configPath(agentDir), "utf8");
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeConfig(config: WebdavSyncConfig, agentDir = getAgentDir()): Promise<void> {
  await fs.mkdir(configDir(agentDir), { recursive: true });
  await fs.writeFile(configPath(agentDir), `${JSON.stringify(validateConfig(config), null, 2)}\n`, "utf8");
}

export function validateConfig(value: unknown): WebdavSyncConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be an object");
  }
  const input = value as Record<string, unknown>;
  const config: WebdavSyncConfig = { ...defaultConfig(), ...(input as Partial<WebdavSyncConfig>) };
  if (config.backend !== "webdav") throw new Error("only webdav backend is supported by config schema");
  for (const key of ["remoteBaseUrl", "username", "passwordEnv", "password", "remoteDir", "remoteDefaultModel"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "string") throw new Error(`${key} must be a string`);
  }
  if (!config.remoteDefaultModel || !/^[^/\s]+\/\S+$/.test(config.remoteDefaultModel)) {
    throw new Error("remoteDefaultModel must use provider/model format");
  }
  if (!["ask", "always", "never"].includes(config.installMissingPackages || "ask")) {
    throw new Error("installMissingPackages must be ask, always, or never");
  }
  if (config.backupRetention !== undefined && (!Number.isInteger(config.backupRetention) || config.backupRetention < 0)) {
    throw new Error("backupRetention must be a non-negative integer");
  }
  config.extraSyncFiles = validateExtraSyncPaths(config.extraSyncFiles, "extraSyncFiles", false);
  config.extraSyncDirs = validateExtraSyncPaths(config.extraSyncDirs, "extraSyncDirs", true);
  config.excludeSyncPaths = validateExtraSyncPaths(config.excludeSyncPaths, "excludeSyncPaths", false);
  config.excludeMcpServers = validateStringList(config.excludeMcpServers, "excludeMcpServers");
  return config;
}

function validateExtraSyncPaths(
  value: unknown,
  key: "extraSyncFiles" | "extraSyncDirs" | "excludeSyncPaths",
  isDirectory: boolean,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of relative paths`);
  }
  const paths = [...new Set(value.map((item) => safeRelativePath(item as string)))];
  if (paths.some((item) => isExcludedRelativePath(item, isDirectory))) {
    throw new Error(`${key} contains an excluded path`);
  }
  return paths;
}

function validateStringList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}
