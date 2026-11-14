/**
 * @fileoverview The `limit` input of a tool that serves at most `cap` rows per
 * call. With `NTFY_CLAMP_LIMITS` on (the default) the schema advertises a
 * default and a minimum but no maximum, and `clampLimit` serves a larger value
 * as the cap, with a log line and a counter increment; the tool's own notice
 * names both values. Off, the schema advertises and enforces `maximum: cap`.
 * The mode is read through `getServerConfig()` on every `tools/list` emission
 * and every parse. That config is parsed from the environment once, on its
 * first read, which is the schema emission the framework runs when a tool
 * module loads, so the mode holds for the life of the process.
 * @module mcp-server/tools/utils/limit-clamp
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';

const clamps = createCounter(
  'ntfy.limit.clamps',
  'Tool calls whose `limit` exceeded the per-call cap and was served as the cap.',
  '{clamp}',
);

function clamping(): boolean {
  return getServerConfig().clampLimits;
}

interface LimitSchemaOptions {
  /** Rows one call serves. */
  cap: number;
  defaultLimit: number;
  /** The field description, built around `capRule`: the sentence about the cap that holds in the active mode. */
  describe: (capRule: string) => string;
}

/**
 * The Zod field for `limit`: an integer of at least 1 with `defaultLimit`.
 * Zod emits `maximum: Number.MAX_SAFE_INTEGER` for any `.int()`; the `.meta()`
 * getter replaces it with nothing while clamping and with `cap` when not, and
 * the description getter follows the same mode. Both getters are read on each
 * JSON Schema emission, which the SDK repeats on every `tools/list`, so the
 * field needs no outer `.describe()` (one would replace the getter's).
 */
export function limitSchema({ cap, defaultLimit, describe }: LimitSchemaOptions) {
  return z
    .number()
    .int()
    .min(1)
    .check((payload) => {
      if (payload.value > cap && !clamping()) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: cap,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .default(defaultLimit)
    .meta({
      get maximum() {
        return clamping() ? undefined : cap;
      },
      get description() {
        return describe(
          clamping()
            ? `One call returns at most ${cap}; a larger value is served as ${cap}, and the notice says so whenever more remain.`
            : `At most ${cap} per call.`,
        );
      },
    });
}

/**
 * The number of rows to serve for `requested`: `cap` when it is larger, with
 * one `Clamped limit` info line and one `ntfy.limit.clamps` increment
 * attributed to `tool`; otherwise `requested`, silently.
 */
export function clampLimit(
  requested: number,
  { cap, tool }: { cap: number; tool: string },
  ctx: Pick<Context, 'log'>,
): { applied: number; clamped: boolean } {
  if (requested <= cap) return { applied: requested, clamped: false };
  ctx.log.info('Clamped limit', { tool, requested, applied: cap });
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
  return { applied: cap, clamped: true };
}
