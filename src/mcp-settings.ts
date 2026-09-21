type McpConfig = Record<string, unknown> & {
	mcpServers?: Record<string, unknown>;
};

export function filterMcpConfigForSync(
	bytes: Buffer,
	excludedServers: readonly string[],
): Buffer {
	if (!excludedServers.length) return bytes;
	const config = parseMcpConfig(bytes);
	const servers = { ...(config.mcpServers || {}) };
	for (const name of excludedServers) delete servers[name];
	return serialize({ ...config, mcpServers: servers });
}

function parseMcpConfig(bytes: Buffer): McpConfig {
	const value = JSON.parse(bytes.toString("utf8")) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("mcp.json root must be an object");
	}
	const config = value as McpConfig;
	if (
		config.mcpServers !== undefined &&
		(!config.mcpServers ||
			typeof config.mcpServers !== "object" ||
			Array.isArray(config.mcpServers))
	) {
		throw new Error("mcp.json mcpServers must be an object");
	}
	return config;
}

const serialize = (value: McpConfig): Buffer =>
	Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
