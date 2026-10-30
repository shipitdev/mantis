import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import codingAgentConfig from "../packages/coding-agent/vitest.config.ts";
import baseConfig, { workspaceSourcePaths } from "../vitest.base.ts";

export default mergeConfig(
	mergeConfig(baseConfig, codingAgentConfig),
	defineConfig({
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-coding-agent$/,
					replacement: workspaceSourcePaths.codingAgentIndex,
				},
				{
					find: /^@earendil-works\/pi-ai$/,
					replacement: workspaceSourcePaths.aiIndex,
				},
			],
		},
		test: {
			root: fileURLToPath(new URL(".", import.meta.url)),
			include: ["extensions/**/*.test.ts"],
		},
	}),
);
