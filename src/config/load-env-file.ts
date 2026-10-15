/**
 * @fileoverview Loads `./.env` into `process.env` as a side effect of being
 * imported. `src/index.ts` imports it first, so the file is read before any
 * definition module evaluates: the framework reads `.env` only inside
 * `createApp()` (cyanheads/mcp-ts-core#562), after the `NTFY_ENABLE_EMOJI_TAGS`
 * gate has already resolved at module load. Uses the same native
 * `process.loadEnvFile()`, so a variable already set is never overridden and
 * the framework's own later load changes nothing.
 * @module config/load-env-file
 */

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
