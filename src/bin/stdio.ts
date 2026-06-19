#!/usr/bin/env node
/** Entry point: stdio transport (spawned by a local MCP client). */
import { loadConfig, ConfigError } from "../config.js";
import { startStdio } from "../stdio.js";

async function main(): Promise<void> {
  const config = loadConfig({ transport: "stdio" });
  await startStdio(config);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`[devspace] configuration error: ${err.message}\n`);
  } else {
    process.stderr.write(`[devspace] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  }
  process.exit(1);
});
