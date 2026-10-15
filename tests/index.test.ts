/**
 * @fileoverview Tests for the entry point's wiring, with `createApp` replaced
 * by a spy so each boot can be read back: `./.env` is loaded before the
 * definition modules evaluate, `NTFY_ENABLE_EMOJI_TAGS` wraps
 * `ntfy_search_emoji_tags` in `disabledTool()` and drops the pointer sentence
 * from `instructions`, an invalid value fails at load naming the variable, and
 * an invalid `NTFY_BASE_URL` is left for `setup()` (and so the startup banner).
 * @module tests/index
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AnyToolDefinition, type createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: vi.fn(),
}));

const FLAG = 'NTFY_ENABLE_EMOJI_TAGS';

/** `instructions` as shipped before the flag existed — the enabled state must match it byte for byte. */
const INSTRUCTIONS_ENABLED =
  'The ntfy_* tools publish and manage push notifications on ntfy, a pub/sub service where messages live on topics (arbitrary string channels) and a topic name works as an access token, so treat it as a secret. Send with `ntfy_publish_message` (look up `tags` short codes with `ntfy_search_emoji_tags`), poll cached history with `ntfy_fetch_messages`, and clear or delete a notification with `ntfy_manage_message`. Each published message gets a server-assigned `id`; pass it back as `sequence_id` to update, replace, clear, or delete that message later.';

const INSTRUCTIONS_DISABLED =
  'The ntfy_* tools publish and manage push notifications on ntfy, a pub/sub service where messages live on topics (arbitrary string channels) and a topic name works as an access token, so treat it as a secret. Send with `ntfy_publish_message`, poll cached history with `ntfy_fetch_messages`, and clear or delete a notification with `ntfy_manage_message`. Each published message gets a server-assigned `id`; pass it back as `sequence_id` to update, replace, clear, or delete that message later.';

/** The marker `disabledTool()` attaches, read through the public wrapper rather than named. */
const DISABLED_MARKER = Object.keys(disabledTool({} as AnyToolDefinition, { reason: 'probe' }));
const isDisabled = (def: object) => DISABLED_MARKER.every((key) => key in def);

type AppOptions = NonNullable<Parameters<typeof createApp>[0]>;

/** Evaluate `src/index.ts` afresh and return the options it handed `createApp`. */
async function boot(): Promise<AppOptions> {
  vi.resetModules();
  await import('@/index.js');
  const app = await import('@cyanheads/mcp-ts-core');
  const options = vi.mocked(app.createApp).mock.calls.at(-1)?.[0];
  if (!options) throw new Error('src/index.ts did not call createApp.');
  return options;
}

function toolsByName(options: AppOptions) {
  return new Map((options.tools ?? []).map((def) => [def.name, def as object]));
}

describe('src/index.ts', () => {
  const originalCwd = process.cwd();
  let cwd: string;

  beforeEach(() => {
    // An empty working directory, so no `.env` is read unless a test writes one.
    cwd = mkdtempSync(join(tmpdir(), 'ntfy-index-test-'));
    process.chdir(cwd);
    delete process.env[FLAG];
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
    delete process.env[FLAG];
  });

  it('registers all four tools, none disabled, and ships the unchanged instructions by default', async () => {
    const options = await boot();
    const tools = toolsByName(options);

    expect([...tools.keys()]).toEqual([
      'ntfy_publish_message',
      'ntfy_manage_message',
      'ntfy_fetch_messages',
      'ntfy_search_emoji_tags',
    ]);
    for (const def of tools.values()) expect(isDisabled(def)).toBe(false);
    expect(options.instructions).toBe(INSTRUCTIONS_ENABLED);
  });

  it.each(['', '   ', 'true'])('treats %j exactly like an unset flag', async (value) => {
    const unset = await boot();
    vi.stubEnv(FLAG, value);
    const set = await boot();

    expect(set.instructions).toBe(unset.instructions);
    const before = toolsByName(unset);
    for (const [name, def] of toolsByName(set)) {
      expect(isDisabled(def)).toBe(false);
      expect((def as AnyToolDefinition).description).toBe(
        (before.get(name) as AnyToolDefinition).description,
      );
    }
  });

  it('disables only the emoji tool and drops its pointer from `instructions` when the flag is false', async () => {
    vi.stubEnv(FLAG, 'false');
    const options = await boot();
    const tools = toolsByName(options);

    expect(tools.size).toBe(4);
    expect(isDisabled(tools.get('ntfy_search_emoji_tags') as object)).toBe(true);
    for (const name of ['ntfy_publish_message', 'ntfy_manage_message', 'ntfy_fetch_messages']) {
      expect(isDisabled(tools.get(name) as object)).toBe(false);
    }
    expect(options.instructions).toBe(INSTRUCTIONS_DISABLED);
  });

  it('reads the flag from `./.env` before the definition modules evaluate', async () => {
    writeFileSync(join(cwd, '.env'), `${FLAG}=false\n`);
    const options = await boot();

    expect(process.env[FLAG]).toBe('false');
    expect(isDisabled(toolsByName(options).get('ntfy_search_emoji_tags') as object)).toBe(true);
    expect(options.instructions).toBe(INSTRUCTIONS_DISABLED);
  });

  it('never overrides a variable the process environment already set', async () => {
    writeFileSync(join(cwd, '.env'), `${FLAG}=false\n`);
    vi.stubEnv(FLAG, 'true');
    const options = await boot();

    expect(process.env[FLAG]).toBe('true');
    expect(options.instructions).toBe(INSTRUCTIONS_ENABLED);
  });

  it('surfaces a `.env` read failure other than a missing file', async () => {
    mkdirSync(join(cwd, '.env'));
    await expect(boot()).rejects.toThrow();
  });

  it('fails at load, naming the variable, on an unrecognized flag value', async () => {
    vi.stubEnv(FLAG, 'maybe');
    await expect(boot()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining(FLAG),
    });
  });

  it.each(['true', 'false'])(
    'leaves an invalid NTFY_BASE_URL for setup() with the flag %s',
    async (value) => {
      vi.stubEnv(FLAG, value);
      vi.stubEnv('NTFY_BASE_URL', 'not-a-url');
      const options = await boot();

      expect(() => options.setup?.(undefined as never)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringContaining('NTFY_BASE_URL'),
        }),
      );
    },
  );
});
