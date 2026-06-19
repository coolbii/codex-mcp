#!/usr/bin/env node
/** Entry point: Streamable HTTP transport. */
import { loadConfig, ConfigError } from "../config.js";
import { startHttp } from "../http.js";

async function main(): Promise<void> {
  const config = loadConfig({ transport: "http" });
  await startHttp(config);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`[devspace] configuration error: ${err.message}\n`);
  } else {
    process.stderr.write(`[devspace] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  }
  process.exit(1);
});
