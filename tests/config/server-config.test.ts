/**
 * @fileoverview Tests for server-config — covers both env-var shapes:
 * (1) NTFY_SERVERS JSON registry, (2) single-server shorthand. Validates
 * mutual exclusion of token vs basic auth, trailing-slash stripping, the
 * startup refusal of credentials in a base URL (and the duplicate-base check)
 * with no credential in the banner, an empty userinfo read as none, the
 * precedence of NTFY_SERVERS over the shorthand vars when both are set, the
 * deprecated NTFY_API_KEY alias, defaultTopic / numeric-coercion validation,
 * the NTFY_BLOCK_PRIVATE_HOSTS and NTFY_CLAMP_LIMITS boolean flags, blank / whitespace / whole-value
 * `${…}` placeholder values reading as unset, and the memoization behavior of
 * `getServerConfig` / `resetServerConfig`. Also covers `isEmojiTagsEnabled`
 * (NTFY_ENABLE_EMOJI_TAGS), parsed apart from the rest of the config.
 * @module tests/config/server-config
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerConfig, isEmojiTagsEnabled, resetServerConfig } from '@/config/server-config.js';

/** A probe credential: no startup banner may carry either half. */
const USER = 'probeuser';
const PASSWORD = 'pwSECRET';
const SECRET_PATTERN = new RegExp(`${USER}|${PASSWORD}`);

/** The `ConfigurationError` the next `getServerConfig()` fails with. */
function configError(): McpError {
  try {
    getServerConfig();
  } catch (err) {
    expect(err).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    return err as McpError;
  }
  throw new Error('Expected getServerConfig() to fail.');
}

const KEYS = [
  'NTFY_SERVERS',
  'NTFY_BASE_URL',
  'NTFY_DEFAULT_TOPIC',
  'NTFY_AUTH_TOKEN',
  'NTFY_API_KEY',
  'NTFY_AUTH_USERNAME',
  'NTFY_AUTH_PASSWORD',
  'NTFY_REQUEST_TIMEOUT_MS',
  'NTFY_MAX_RETRIES',
  'NTFY_BLOCK_PRIVATE_HOSTS',
  'NTFY_CLAMP_LIMITS',
  'NTFY_ENABLE_EMOJI_TAGS',
] as const;

describe('getServerConfig', () => {
  beforeEach(() => {
    resetServerConfig();
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
    resetServerConfig();
    vi.restoreAllMocks();
  });

  describe('single-server shorthand', () => {
    it('defaults to a single ntfy.sh server with no env vars set', () => {
      const cfg = getServerConfig();
      expect(cfg.servers).toHaveLength(1);
      expect(cfg.servers[0]?.baseUrl).toBe('https://ntfy.sh');
      expect(cfg.requestTimeoutMs).toBe(15_000);
      expect(cfg.maxRetries).toBe(3);
    });

    it('strips a trailing slash from the base URL', () => {
      process.env.NTFY_BASE_URL = 'https://ntfy.example.com/';
      const cfg = getServerConfig();
      expect(cfg.servers[0]?.baseUrl).toBe('https://ntfy.example.com');
    });

    it('rejects mixing bearer and basic auth', () => {
      process.env.NTFY_AUTH_TOKEN = 'tk_abc';
      process.env.NTFY_AUTH_USERNAME = 'user';
      process.env.NTFY_AUTH_PASSWORD = 'pass';
      expect(() => getServerConfig()).toThrow(/mutually exclusive/i);
    });

    it('rejects partial basic auth', () => {
      process.env.NTFY_AUTH_USERNAME = 'user';
      expect(() => getServerConfig()).toThrow(/Basic auth requires both/i);
    });

    it('accepts a bearer token alone', () => {
      process.env.NTFY_AUTH_TOKEN = 'tk_abc';
      const cfg = getServerConfig();
      expect(cfg.servers[0]?.authToken).toBe('tk_abc');
      expect(cfg.servers[0]?.authUsername).toBeUndefined();
    });

    it('accepts paired basic auth', () => {
      process.env.NTFY_AUTH_USERNAME = 'user';
      process.env.NTFY_AUTH_PASSWORD = 'pass';
      const cfg = getServerConfig();
      expect(cfg.servers[0]?.authUsername).toBe('user');
      expect(cfg.servers[0]?.authPassword).toBe('pass');
    });

    /** #58: credentials belong in the auth variables, never in the URL. */
    it.each([
      ['a user and a password', `https://${USER}:${PASSWORD}@ntfy.example.com`],
      ['a user alone', `https://${USER}@ntfy.example.com/`],
      ['a password alone', `https://:${PASSWORD}@ntfy.example.com`],
      ['percent-encoded userinfo', `HTTPS://${USER}%40corp:${PASSWORD}@ntfy.example.com`],
    ])(
      'fails startup on NTFY_BASE_URL with %s, naming the auth variables and no credential',
      (_label, value) => {
        process.env.NTFY_BASE_URL = value;
        const err = configError();
        expect(err.message).toContain('NTFY_BASE_URL (servers.0.baseUrl)');
        for (const name of ['NTFY_AUTH_USERNAME', 'NTFY_AUTH_PASSWORD', 'NTFY_AUTH_TOKEN']) {
          expect(err.message).toContain(name);
        }
        expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(
          SECRET_PATTERN,
        );
      },
    );

    it('fails startup on an NTFY_BASE_URL that does not parse, quoting none of it', () => {
      process.env.NTFY_BASE_URL = `http://${USER}:${PASSWORD}@[::1`;
      const err = configError();
      expect(err.message).toContain('NTFY_BASE_URL (servers.0.baseUrl)');
      expect(err.message).not.toMatch(SECRET_PATTERN);
    });

    it('reads an empty userinfo as none, so the stored base carries no `@`', () => {
      process.env.NTFY_BASE_URL = 'https://@ntfy.example.com/';
      expect(getServerConfig().servers[0]?.baseUrl).toBe('https://ntfy.example.com');
    });
  });

  describe('NTFY_SERVERS registry', () => {
    it('parses a multi-entry registry', () => {
      process.env.NTFY_SERVERS = JSON.stringify([
        { baseUrl: 'https://ntfy.sh' },
        { baseUrl: 'https://ntfy.example.com', authToken: 'tk_xyz' },
        { baseUrl: 'https://ntfy.corp.com/', authUsername: 'u', authPassword: 'p' },
      ]);
      const cfg = getServerConfig();
      expect(cfg.servers).toHaveLength(3);
      expect(cfg.servers[0]?.baseUrl).toBe('https://ntfy.sh');
      expect(cfg.servers[1]?.authToken).toBe('tk_xyz');
      expect(cfg.servers[2]?.baseUrl).toBe('https://ntfy.corp.com');
      expect(cfg.servers[2]?.authUsername).toBe('u');
    });

    it('takes precedence over the shorthand vars when both are set', () => {
      process.env.NTFY_BASE_URL = 'https://shorthand.example.com';
      process.env.NTFY_AUTH_TOKEN = 'tk_shorthand';
      process.env.NTFY_SERVERS = JSON.stringify([{ baseUrl: 'https://registry.example.com' }]);
      const cfg = getServerConfig();
      expect(cfg.servers).toHaveLength(1);
      expect(cfg.servers[0]?.baseUrl).toBe('https://registry.example.com');
      expect(cfg.servers[0]?.authToken).toBeUndefined();
    });

    it('rejects invalid JSON', () => {
      process.env.NTFY_SERVERS = '{not json';
      expect(() => getServerConfig()).toThrow(/not valid JSON/i);
    });

    it.each([
      [
        'an unquoted token',
        '[{"baseUrl":"https://ntfy.internal.test","authToken":tk_SECRETVALUE}]',
      ],
      [
        'a trailing comma after a password',
        '[{"baseUrl":"https://ntfy.internal.test","authUsername":"u","authPassword":"hunter2SECRET"},]',
      ],
      ['a bare URL', 'http://u:SECRET@h.io'],
    ])('quotes no part of a value that is not valid JSON: %s', (_case, raw) => {
      process.env.NTFY_SERVERS = raw;
      let failure: unknown;
      try {
        getServerConfig();
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(Error);
      const { message, cause } = failure as Error;
      expect(message).toMatch(/not valid JSON/i);
      expect(message).not.toMatch(/SECRET|hunter2|tk_|internal\.test|h\.io/);
      expect(cause).toBeUndefined();
    });

    it('rejects a non-array value', () => {
      process.env.NTFY_SERVERS = JSON.stringify({ baseUrl: 'https://ntfy.sh' });
      expect(() => getServerConfig()).toThrow(/JSON array/i);
    });

    it('rejects an empty array', () => {
      process.env.NTFY_SERVERS = '[]';
      expect(() => getServerConfig()).toThrow();
    });

    it('rejects duplicate baseUrls', () => {
      process.env.NTFY_SERVERS = JSON.stringify([
        { baseUrl: 'https://ntfy.sh' },
        { baseUrl: 'https://ntfy.sh/' },
      ]);
      expect(() => getServerConfig()).toThrow(/Duplicate server baseUrl/i);
    });

    it('names the earlier entry of a duplicate, never the URL', () => {
      process.env.NTFY_SERVERS = JSON.stringify([
        { baseUrl: 'https://ntfy.example.com/team' },
        { baseUrl: 'https://ntfy.example.com/team/' },
      ]);
      const err = configError();
      expect(err.message).toContain('NTFY_SERVERS[1].baseUrl (servers.1.baseUrl)');
      expect(err.message).toContain('NTFY_SERVERS[0]');
      expect(err.message).not.toContain('ntfy.example.com');
    });

    it("fails startup on an entry whose baseUrl carries credentials, naming the entry's own auth fields", () => {
      process.env.NTFY_SERVERS = JSON.stringify([
        { baseUrl: 'https://ntfy.sh' },
        { baseUrl: `https://${USER}:${PASSWORD}@ntfy.example.com`, authToken: 'tk_other' },
      ]);
      const err = configError();
      expect(err.message).toContain('NTFY_SERVERS[1].baseUrl (servers.1.baseUrl)');
      for (const field of ['`authUsername`', '`authPassword`', '`authToken`']) {
        expect(err.message).toContain(field);
      }
      expect(err.message).not.toContain('NTFY_AUTH_');
      expect(err.message).not.toContain('NTFY_SERVERS[0]');
      expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(SECRET_PATTERN);
    });

    it('quotes no credential when two entries carrying it differ only by a trailing slash', () => {
      process.env.NTFY_SERVERS = JSON.stringify([
        { baseUrl: `https://${USER}:${PASSWORD}@ntfy.example.com` },
        { baseUrl: `https://${USER}:${PASSWORD}@ntfy.example.com/` },
      ]);
      const err = configError();
      expect(err.message).toContain('NTFY_SERVERS[0].baseUrl (servers.0.baseUrl)');
      expect(err.message).toContain('NTFY_SERVERS[1].baseUrl (servers.1.baseUrl)');
      expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(SECRET_PATTERN);
    });

    it('rejects mixing bearer and basic auth on a single entry', () => {
      process.env.NTFY_SERVERS = JSON.stringify([
        { baseUrl: 'https://ntfy.sh', authToken: 'tk_abc', authUsername: 'u', authPassword: 'p' },
      ]);
      expect(() => getServerConfig()).toThrow(/mutually exclusive/i);
    });

    it('rejects partial basic auth on a single entry', () => {
      process.env.NTFY_SERVERS = JSON.stringify([
        { baseUrl: 'https://ntfy.sh', authUsername: 'u' },
      ]);
      expect(() => getServerConfig()).toThrow(/Basic auth requires both/i);
    });
  });

  describe('NTFY_API_KEY (deprecated alias)', () => {
    it('promotes NTFY_API_KEY into authToken when NTFY_AUTH_TOKEN is unset', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.env.NTFY_API_KEY = 'tk_legacy';
      const cfg = getServerConfig();
      expect(cfg.servers[0]?.authToken).toBe('tk_legacy');
      expect(stderr).toHaveBeenCalled();
      const writes = stderr.mock.calls.map((c) => String(c[0]));
      expect(writes.some((w) => /NTFY_API_KEY is deprecated/i.test(w))).toBe(true);
    });

    it('NTFY_AUTH_TOKEN takes precedence over NTFY_API_KEY without warning', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.env.NTFY_AUTH_TOKEN = 'tk_new';
      process.env.NTFY_API_KEY = 'tk_legacy';
      const cfg = getServerConfig();
      expect(cfg.servers[0]?.authToken).toBe('tk_new');
      const warned = stderr.mock.calls
        .map((c) => String(c[0]))
        .some((w) => /NTFY_API_KEY is deprecated/i.test(w));
      expect(warned).toBe(false);
    });
  });

  describe('default topic and numeric coercion', () => {
    it('rejects a default topic with disallowed characters', () => {
      process.env.NTFY_DEFAULT_TOPIC = 'has spaces';
      expect(() => getServerConfig()).toThrow();
    });

    it('rejects a default topic longer than 64 chars', () => {
      process.env.NTFY_DEFAULT_TOPIC = 'a'.repeat(65);
      expect(() => getServerConfig()).toThrow();
    });

    it('accepts a valid default topic', () => {
      process.env.NTFY_DEFAULT_TOPIC = 'my_default-topic';
      const cfg = getServerConfig();
      expect(cfg.defaultTopic).toBe('my_default-topic');
    });

    it('coerces NTFY_REQUEST_TIMEOUT_MS / NTFY_MAX_RETRIES from strings', () => {
      process.env.NTFY_REQUEST_TIMEOUT_MS = '5000';
      process.env.NTFY_MAX_RETRIES = '7';
      const cfg = getServerConfig();
      expect(cfg.requestTimeoutMs).toBe(5000);
      expect(cfg.maxRetries).toBe(7);
    });

    it('rejects a non-positive request timeout', () => {
      process.env.NTFY_REQUEST_TIMEOUT_MS = '0';
      expect(() => getServerConfig()).toThrow();
    });

    it('rejects a negative max-retries value', () => {
      process.env.NTFY_MAX_RETRIES = '-1';
      expect(() => getServerConfig()).toThrow();
    });
  });

  describe('NTFY_BLOCK_PRIVATE_HOSTS', () => {
    it('defaults to off so existing deployments are unaffected', () => {
      expect(getServerConfig().blockPrivateHosts).toBe(false);
    });

    it.each(['true', '1', 'yes', 'on'])('reads %j as on', (value) => {
      process.env.NTFY_BLOCK_PRIVATE_HOSTS = value;
      expect(getServerConfig().blockPrivateHosts).toBe(true);
    });

    it.each(['false', '0', 'no', 'off'])('reads %j as off', (value) => {
      process.env.NTFY_BLOCK_PRIVATE_HOSTS = value;
      expect(getServerConfig().blockPrivateHosts).toBe(false);
    });

    it('treats an empty value as unset rather than a parse failure', () => {
      process.env.NTFY_BLOCK_PRIVATE_HOSTS = '';
      expect(getServerConfig().blockPrivateHosts).toBe(false);
    });

    it('names the env var when the value is not a recognized boolean', () => {
      process.env.NTFY_BLOCK_PRIVATE_HOSTS = 'maybe';
      expect(() => getServerConfig()).toThrow(/NTFY_BLOCK_PRIVATE_HOSTS/);
    });
  });

  describe('NTFY_CLAMP_LIMITS', () => {
    it('defaults to on, clamping an over-cap `limit` rather than rejecting it', () => {
      expect(getServerConfig().clampLimits).toBe(true);
    });

    it.each(['true', '1', 'yes', 'on'])('reads %j as on', (value) => {
      process.env.NTFY_CLAMP_LIMITS = value;
      expect(getServerConfig().clampLimits).toBe(true);
    });

    it.each(['false', '0', 'no', 'off', 'FALSE'])('reads %j as off', (value) => {
      process.env.NTFY_CLAMP_LIMITS = value;
      expect(getServerConfig().clampLimits).toBe(false);
    });

    it('fails with a ConfigurationError naming the variable for an unrecognized value', () => {
      process.env.NTFY_CLAMP_LIMITS = 'maybe';
      expect(() => getServerConfig()).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringMatching(/NTFY_CLAMP_LIMITS \(clampLimits\)/),
        }),
      );
    });
  });

  describe('blank and unsubstituted placeholder values', () => {
    const DEFAULTS = {
      servers: [{ baseUrl: 'https://ntfy.sh' }],
      requestTimeoutMs: 15_000,
      maxRetries: 3,
      blockPrivateHosts: false,
      clampLimits: true,
    };

    /** A whole-value `${name}` reference an install host forwarded unsubstituted. */
    const placeholder = (name: string) => `\${${name}}`;

    const cases = KEYS.flatMap((key) => [
      [key, ''],
      [key, '   '],
      [key, placeholder(key)],
      [key, placeholder('user_config.value')],
    ]);

    it.each(cases)('reads %s=%j as unset', (key, value) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.env[key] = value;
      const cfg = getServerConfig();
      expect(cfg).toEqual(DEFAULTS);
      expect(cfg.defaultTopic).toBeUndefined();
      expect(stderr).not.toHaveBeenCalled();
    });

    it('falls back to NTFY_API_KEY, with the deprecation warning, when NTFY_AUTH_TOKEN is blank', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.env.NTFY_AUTH_TOKEN = '';
      process.env.NTFY_API_KEY = 'tk_legacy';
      expect(getServerConfig().servers[0]?.authToken).toBe('tk_legacy');
      const writes = stderr.mock.calls.map((c) => String(c[0]));
      expect(writes.some((w) => /NTFY_API_KEY is deprecated/i.test(w))).toBe(true);
    });

    it('treats a placeholder username as unset, so a lone password still fails naming NTFY_AUTH_USERNAME', () => {
      process.env.NTFY_AUTH_USERNAME = placeholder('NTFY_AUTH_USERNAME');
      process.env.NTFY_AUTH_PASSWORD = 'pass';
      expect(() => getServerConfig()).toThrow(/NTFY_AUTH_USERNAME.*Basic auth requires both/);
    });

    it('keeps a value that only contains a placeholder', () => {
      const token = `tk_${placeholder('suffix')}`;
      process.env.NTFY_AUTH_TOKEN = token;
      expect(getServerConfig().servers[0]?.authToken).toBe(token);
    });

    it('still names the env var for a non-blank invalid value', () => {
      process.env.NTFY_REQUEST_TIMEOUT_MS = 'soon';
      expect(() => getServerConfig()).toThrow(/NTFY_REQUEST_TIMEOUT_MS/);
    });
  });

  describe('memoization', () => {
    it('caches the parsed config across calls', () => {
      const a = getServerConfig();
      const b = getServerConfig();
      expect(a).toBe(b);
    });

    it('resetServerConfig forces re-parse on the next call', () => {
      const before = getServerConfig();
      expect(before.servers[0]?.baseUrl).toBe('https://ntfy.sh');
      resetServerConfig();
      process.env.NTFY_BASE_URL = 'https://later.example.com';
      const after = getServerConfig();
      expect(after.servers[0]?.baseUrl).toBe('https://later.example.com');
      expect(after).not.toBe(before);
    });
  });
});

describe('isEmojiTagsEnabled', () => {
  beforeEach(() => {
    resetServerConfig();
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
    resetServerConfig();
  });

  it('defaults to on when NTFY_ENABLE_EMOJI_TAGS is unset', () => {
    expect(isEmojiTagsEnabled()).toBe(true);
  });

  it.each(['', '   ', `\${NTFY_ENABLE_EMOJI_TAGS}`, `\${user_config.emoji}`])(
    'reads the blank or placeholder value %j as unset, so on',
    (value) => {
      process.env.NTFY_ENABLE_EMOJI_TAGS = value;
      expect(isEmojiTagsEnabled()).toBe(true);
    },
  );

  it.each(['true', '1', 'yes', 'on', 'TRUE'])('reads %j as on', (value) => {
    process.env.NTFY_ENABLE_EMOJI_TAGS = value;
    expect(isEmojiTagsEnabled()).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'False'])('reads %j as off', (value) => {
    process.env.NTFY_ENABLE_EMOJI_TAGS = value;
    expect(isEmojiTagsEnabled()).toBe(false);
  });

  it('fails with a ConfigurationError naming the variable for an unrecognized value', () => {
    process.env.NTFY_ENABLE_EMOJI_TAGS = 'maybe';
    expect(() => isEmojiTagsEnabled()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('NTFY_ENABLE_EMOJI_TAGS'),
      }),
    );
  });

  it('reads only its own variable, so another invalid NTFY_* value is left for getServerConfig', () => {
    process.env.NTFY_BASE_URL = 'not-a-url';
    process.env.NTFY_ENABLE_EMOJI_TAGS = 'false';
    expect(isEmojiTagsEnabled()).toBe(false);
    expect(() => getServerConfig()).toThrow(/NTFY_BASE_URL/);
  });

  it('caches the first parse until resetServerConfig', () => {
    process.env.NTFY_ENABLE_EMOJI_TAGS = 'false';
    expect(isEmojiTagsEnabled()).toBe(false);
    process.env.NTFY_ENABLE_EMOJI_TAGS = 'true';
    expect(isEmojiTagsEnabled()).toBe(false);
    resetServerConfig();
    expect(isEmojiTagsEnabled()).toBe(true);
  });
});
