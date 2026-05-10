/**
 * @fileoverview Tests for server-config — covers both env-var shapes:
 * (1) NTFY_SERVERS JSON registry, (2) single-server shorthand. Validates
 * mutual exclusion of token vs basic auth, trailing-slash stripping, the
 * precedence of NTFY_SERVERS over the shorthand vars when both are set, the
 * deprecated NTFY_API_KEY alias, defaultTopic / numeric-coercion validation,
 * and the memoization behavior of `getServerConfig` / `resetServerConfig`.
 * @module tests/config/server-config
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

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
