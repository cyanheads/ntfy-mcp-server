/**
 * @fileoverview A count input with a per-call cap: `limit` (rows one call
 * serves) and `wait_seconds` (seconds one call waits). With `NTFY_CLAMP_LIMITS`
 * on (the default) the schema advertises a default and a minimum but no
 * maximum, and `clampLimit` serves a larger value as the cap, with a log line
 * and a counter increment; the tool's own notice names both values. Off, the
 * schema advertises and enforces `maximum: cap`. The mode is read through
 * `getServerConfig()` on every `tools/list` emission and every parse. That
 * config is parsed from the environment once, on its first read, which is the
 * schema emission the framework runs when a tool module loads, so the mode
 * holds for the life of the process.
 * @module mcp-server/tools/utils/limit-clamp
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';

const clamps = createCounter(
  'ntfy.limit.clamps',
  'Tool calls whose `limit` or `wait_seconds` exceeded its per-call cap and was served as the cap.',
  '{clamp}',
);

function clamping(): boolean {
  return getServerConfig().clampLimits;
}

/** The sentence about the cap that holds in each `NTFY_CLAMP_LIMITS` mode. */
interface CapRules {
  clamping: string;
  strict: string;
}

interface LimitSchemaOptions {
  /** The largest value one call is served. */
  cap: number;
  /** Cap sentences for an input other than a row count; the `limit` wording by default. */
  capRules?: CapRules;
  defaultLimit: number;
  /** The field description, built around `capRule`: the sentence about the cap that holds in the active mode. */
  describe: (capRule: string) => string;
  /** The smallest value accepted; 1 by default. */
  min?: number;
}

/**
 * The Zod field for a capped count: an integer of at least `min` with
 * `defaultLimit`. Zod emits `maximum: Number.MAX_SAFE_INTEGER` for any
 * `.int()`; the `.meta()` getter replaces it with nothing while clamping and
 * with `cap` when not, and the description getter follows the same mode. Both
 * getters are read on each JSON Schema emission, which the SDK repeats on every
 * `tools/list`, so the field needs no outer `.describe()` (one would replace
 * the getter's).
 */
export function limitSchema({
  cap,
  capRules,
  defaultLimit,
  describe,
  min = 1,
}: LimitSchemaOptions) {
  const rules = capRules ?? {
    clamping: `One call returns at most ${cap}; a larger value is served as ${cap}, and the notice says so whenever more remain.`,
    strict: `At most ${cap} per call.`,
  };
  return z
    .number()
    .int()
    .min(min)
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
        return describe(clamping() ? rules.clamping : rules.strict);
      },
    });
}

/**
 * The value to serve for `requested`: `cap` when it is larger, with one
 * `Clamped limit` info line naming `input` (`limit` by default) and one
 * `ntfy.limit.clamps` increment attributed to `tool`; otherwise `requested`,
 * silently.
 */
export function clampLimit(
  requested: number,
  { cap, tool, input = 'limit' }: { cap: number; input?: string; tool: string },
  ctx: Pick<Context, 'log'>,
): { applied: number; clamped: boolean } {
  if (requested <= cap) return { applied: requested, clamped: false };
  ctx.log.info('Clamped limit', { tool, input, requested, applied: cap });
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
  return { applied: cap, clamped: true };
}
