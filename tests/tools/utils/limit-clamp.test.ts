/**
 * @fileoverview Tests for the count-input clamp at its own seam — `limitSchema`
 * in both `NTFY_CLAMP_LIMITS` modes (what a value parses to, the JSON Schema
 * `tools/list` advertises, the mode-dependent description, the mode read on
 * every emission rather than at definition) and `clampLimit` (the served value,
 * one log line, and one counter increment attributed to the tool, on a clamp
 * only). The tools' own suites prove only their wiring.
 * @module tests/tools/utils/limit-clamp
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { clampLimit, limitSchema } from '@/mcp-server/tools/utils/limit-clamp.js';

/**
 * The counter is created when `limit-clamp.ts` loads, so its creation and every
 * increment are recorded here, in the hoisted factory, rather than on a mock's
 * `calls`.
 */
const telemetry = vi.hoisted(() => ({
  created: [] as Array<{ name: string; description: string; unit: string | undefined }>,
  adds: [] as Array<{ value: number; attributes: unknown }>,
}));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string, description: string, unit?: string) => {
    telemetry.created.push({ name, description, unit });
    return {
      add: (value: number, attributes?: unknown) => {
        telemetry.adds.push({ value, attributes });
      },
    };
  },
}));

const FLAG = 'NTFY_CLAMP_LIMITS';

const field = limitSchema({
  cap: 200,
  defaultLimit: 25,
  describe: (capRule) => `Rows to return. Default 25. ${capRule}`,
});

/** The `limit` property as `tools/list` advertises it. */
function advertised(): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object({ limit: field }).strict(), {
    io: 'input',
    target: 'draft-2020-12',
  }) as unknown as { properties: { limit: Record<string, unknown> } };
  return schema.properties.limit;
}

beforeEach(() => {
  delete process.env[FLAG];
  resetServerConfig();
  telemetry.adds.length = 0;
});
afterEach(() => {
  delete process.env[FLAG];
  resetServerConfig();
});

describe('limitSchema with clamping on (the default)', () => {
  it('parses a value above the cap as sent, and applies the default when omitted', () => {
    expect(field.parse(5000)).toBe(5000);
    expect(field.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(field.parse(undefined)).toBe(25);
  });

  it.each([0, -1, 1.5])('rejects %j', (value) => {
    expect(field.safeParse(value).success).toBe(false);
  });

  it('advertises an integer of at least 1 with its default, no maximum, and the clamping rule', () => {
    const limit = advertised();
    expect(limit).toMatchObject({ type: 'integer', minimum: 1, default: 25 });
    expect(limit).not.toHaveProperty('maximum');
    expect(limit).not.toHaveProperty('exclusiveMinimum');
    expect(limit.description).toBe(
      'Rows to return. Default 25. One call returns at most 200; a larger value is served as 200, and the notice says so whenever more remain.',
    );
    expect(field.description).toBe(limit.description);
  });

  it.each(['', '   ', `\${${FLAG}}`, `\${user_config.clamp}`])(
    'reads the blank or placeholder value %j as unset, so clamping',
    (value) => {
      process.env[FLAG] = value;
      expect(advertised()).not.toHaveProperty('maximum');
      expect(field.parse(201)).toBe(201);
    },
  );
});

describe('limitSchema with NTFY_CLAMP_LIMITS=false', () => {
  beforeEach(() => {
    process.env[FLAG] = 'false';
  });

  it('advertises the cap as its maximum and the strict rule', () => {
    const limit = advertised();
    expect(limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200, default: 25 });
    expect(limit.description).toBe('Rows to return. Default 25. At most 200 per call.');
  });

  it('rejects a value above the cap at parse, naming the bound, and accepts the cap', () => {
    const rejected = field.safeParse(201);
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues).toEqual([
      expect.objectContaining({ code: 'too_big', maximum: 200, inclusive: true }),
    ]);
    expect(rejected.error?.issues[0]?.message).toContain('200');
    expect(field.parse(200)).toBe(200);
    expect(field.parse(undefined)).toBe(25);
  });
});

describe('limitSchema reads the mode on every use', () => {
  it('changes what it advertises and enforces when the setting changes after definition', () => {
    expect(advertised()).not.toHaveProperty('maximum');
    expect(field.safeParse(500).success).toBe(true);

    process.env[FLAG] = 'false';
    resetServerConfig();
    expect(advertised()).toMatchObject({ maximum: 200 });
    expect(field.safeParse(500).success).toBe(false);

    process.env[FLAG] = 'true';
    resetServerConfig();
    expect(advertised()).not.toHaveProperty('maximum');
    expect(field.safeParse(500).success).toBe(true);
  });
});

describe('clampLimit', () => {
  it('creates one `ntfy.limit.clamps` counter in `{clamp}` units when the module loads', () => {
    expect(telemetry.created).toEqual([
      { name: 'ntfy.limit.clamps', description: expect.any(String), unit: '{clamp}' },
    ]);
  });

  it('serves a value above the cap as the cap, with one log line and one count for the tool', () => {
    const ctx = createMockContext();
    expect(clampLimit(500, { cap: 200, tool: 'some_tool' }, ctx)).toEqual({
      applied: 200,
      clamped: true,
    });
    expect((ctx.log as MockContextLogger).calls).toEqual([
      {
        level: 'info',
        msg: 'Clamped limit',
        data: { tool: 'some_tool', requested: 500, applied: 200 },
      },
    ]);
    expect(telemetry.adds).toEqual([{ value: 1, attributes: { 'mcp.tool.name': 'some_tool' } }]);
  });

  it.each([1, 25, 200])('passes %d through with no log line and no count', (requested) => {
    const ctx = createMockContext();
    expect(clampLimit(requested, { cap: 200, tool: 'some_tool' }, ctx)).toEqual({
      applied: requested,
      clamped: false,
    });
    expect((ctx.log as MockContextLogger).calls).toEqual([]);
    expect(telemetry.adds).toEqual([]);
  });
});
