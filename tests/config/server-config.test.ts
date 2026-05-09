/**
 * @fileoverview Tests for server-config — env-var mapping, mutual exclusion of
 * token vs basic auth, and trailing-slash stripping.
 * @module tests/config/server-config
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

const KEYS = [
  'NTFY_BASE_URL',
  'NTFY_DEFAULT_TOPIC',
  'NTFY_AUTH_TOKEN',
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
  });

  it('defaults to ntfy.sh with no env vars set', () => {
    const cfg = getServerConfig();
    expect(cfg.baseUrl).toBe('https://ntfy.sh');
    expect(cfg.requestTimeoutMs).toBe(15_000);
    expect(cfg.maxRetries).toBe(3);
  });

  it('strips a trailing slash from the base URL', () => {
    process.env.NTFY_BASE_URL = 'https://ntfy.example.com/';
    const cfg = getServerConfig();
    expect(cfg.baseUrl).toBe('https://ntfy.example.com');
  });

  it('rejects mixing bearer and basic auth', () => {
    process.env.NTFY_AUTH_TOKEN = 'tk_abc';
    process.env.NTFY_AUTH_USERNAME = 'user';
    process.env.NTFY_AUTH_PASSWORD = 'pass';
    expect(() => getServerConfig()).toThrow(/mutually exclusive/i);
  });

  it('rejects partial basic auth', () => {
    process.env.NTFY_AUTH_USERNAME = 'user';
    expect(() => getServerConfig()).toThrow(
      /NTFY_AUTH_USERNAME and NTFY_AUTH_PASSWORD must be set together/i,
    );
  });

  it('accepts a bearer token alone', () => {
    process.env.NTFY_AUTH_TOKEN = 'tk_abc';
    const cfg = getServerConfig();
    expect(cfg.authToken).toBe('tk_abc');
    expect(cfg.authUsername).toBeUndefined();
  });

  it('accepts paired basic auth', () => {
    process.env.NTFY_AUTH_USERNAME = 'user';
    process.env.NTFY_AUTH_PASSWORD = 'pass';
    const cfg = getServerConfig();
    expect(cfg.authUsername).toBe('user');
    expect(cfg.authPassword).toBe('pass');
  });
});
