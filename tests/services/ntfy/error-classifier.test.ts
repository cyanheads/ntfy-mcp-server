/**
 * @fileoverview Tests for the pure-data error classifiers — code/message
 * extraction, the auth/rate/invalid/not-found predicates, the
 * "retry-exhausted" heuristic, and the keyword-based 4xx sub-reason split
 * (`payload_too_large` vs `unverified_contact`).
 * @module tests/services/ntfy/error-classifier
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  classifyInvalidParams,
  getCode,
  getDataBody,
  getMessage,
  isAuthCode,
  isInvalidParamsCode,
  isNotFoundCode,
  isRateLimitedCode,
  isUpstreamUnreachable,
} from '@/services/ntfy/error-classifier.js';

describe('error-classifier shape extractors', () => {
  it('getCode returns the code field on McpError', () => {
    const err = new McpError(JsonRpcErrorCode.NotFound, 'gone');
    expect(getCode(err)).toBe(JsonRpcErrorCode.NotFound);
  });

  it('getCode returns undefined on a plain Error', () => {
    expect(getCode(new Error('boom'))).toBeUndefined();
  });

  it('getCode is null-safe', () => {
    expect(getCode(undefined)).toBeUndefined();
    expect(getCode(null)).toBeUndefined();
    expect(getCode('a string')).toBeUndefined();
  });

  it('getMessage returns the string message', () => {
    expect(getMessage(new Error('hello'))).toBe('hello');
  });

  it('getMessage returns "" when message is missing or non-string', () => {
    expect(getMessage({})).toBe('');
    expect(getMessage({ message: 42 })).toBe('');
    expect(getMessage(undefined)).toBe('');
  });

  it('getDataBody returns data.body when it is a string', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'bad', {
      body: '{"error":"too large"}',
    });
    expect(getDataBody(err)).toBe('{"error":"too large"}');
  });

  it('getDataBody returns "" when data.body is absent or non-string', () => {
    expect(getDataBody(new Error('plain'))).toBe('');
    expect(getDataBody(new McpError(JsonRpcErrorCode.InvalidParams, 'x', { body: 99 }))).toBe('');
    expect(getDataBody({ data: {} })).toBe('');
    expect(getDataBody(null)).toBe('');
  });
});

describe('error-classifier predicates', () => {
  it('isAuthCode matches Forbidden and Unauthorized', () => {
    expect(isAuthCode(JsonRpcErrorCode.Forbidden)).toBe(true);
    expect(isAuthCode(JsonRpcErrorCode.Unauthorized)).toBe(true);
    expect(isAuthCode(JsonRpcErrorCode.NotFound)).toBe(false);
    expect(isAuthCode(undefined)).toBe(false);
  });

  it('isRateLimitedCode matches RateLimited', () => {
    expect(isRateLimitedCode(JsonRpcErrorCode.RateLimited)).toBe(true);
    expect(isRateLimitedCode(JsonRpcErrorCode.InvalidParams)).toBe(false);
  });

  it('isInvalidParamsCode matches both InvalidParams and ValidationError', () => {
    expect(isInvalidParamsCode(JsonRpcErrorCode.InvalidParams)).toBe(true);
    expect(isInvalidParamsCode(JsonRpcErrorCode.ValidationError)).toBe(true);
    expect(isInvalidParamsCode(JsonRpcErrorCode.NotFound)).toBe(false);
  });

  it('isNotFoundCode matches NotFound', () => {
    expect(isNotFoundCode(JsonRpcErrorCode.NotFound)).toBe(true);
    expect(isNotFoundCode(JsonRpcErrorCode.Forbidden)).toBe(false);
  });
});

describe('isUpstreamUnreachable', () => {
  it('matches the framework retry-exhausted suffix on a plain Error', () => {
    const err = new Error('connection refused (failed after 3 attempts)');
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('matches when the suffix reports a single attempt', () => {
    const err = new Error('econnreset (failed after 1 attempt)');
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('matches when the underlying code is the InternalError fallback', () => {
    const err = new McpError(
      JsonRpcErrorCode.InternalError,
      'fetch failed (failed after 3 attempts)',
    );
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('rejects retried errors that surfaced a non-internal JSON-RPC code', () => {
    // 4xx-classed retries (rare, but the helper wouldn't retry them) — the
    // upstream status should win, not the network classifier.
    const err = new McpError(JsonRpcErrorCode.RateLimited, 'throttled (failed after 3 attempts)');
    expect(isUpstreamUnreachable(err)).toBe(false);
  });

  it('rejects errors that lack the retry-exhausted suffix', () => {
    expect(isUpstreamUnreachable(new Error('connection refused'))).toBe(false);
    expect(isUpstreamUnreachable(new Error(''))).toBe(false);
  });
});

describe('classifyInvalidParams', () => {
  it('returns `payload_too_large` when the message hints at attachment size', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'attachment too large for topic');
    expect(classifyInvalidParams(err)).toBe('payload_too_large');
  });

  it('returns `payload_too_large` when the captured body mentions 413', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'request rejected', {
      body: 'HTTP 413 Payload Too Large',
    });
    expect(classifyInvalidParams(err)).toBe('payload_too_large');
  });

  it('returns `unverified_contact` for email-verification phrasing', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'email address is not verified');
    expect(classifyInvalidParams(err)).toBe('unverified_contact');
  });

  it('returns `unverified_contact` for phone-verification phrasing', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'phone number is not verified');
    expect(classifyInvalidParams(err)).toBe('unverified_contact');
  });

  it('matches case-insensitively', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'ATTACHMENT TOO LARGE');
    expect(classifyInvalidParams(err)).toBe('payload_too_large');
  });

  it('checks both the message and the captured body', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'request rejected', {
      body: 'unverified email address on this account',
    });
    expect(classifyInvalidParams(err)).toBe('unverified_contact');
  });

  it('returns undefined when neither pattern matches', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'something else went wrong');
    expect(classifyInvalidParams(err)).toBeUndefined();
  });

  it('payload_too_large takes precedence when both keywords are present', () => {
    // Order in the implementation: too large/attachment/413 checked before
    // email/phone/verified. Lock that in so a refactor doesn't silently flip it.
    const err = new McpError(
      JsonRpcErrorCode.InvalidParams,
      'attachment too large; email recipient also unverified',
    );
    expect(classifyInvalidParams(err)).toBe('payload_too_large');
  });
});
