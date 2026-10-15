/**
 * @fileoverview Tests for the pure-data error classifiers — code/message/status
 * extraction, upstream JSON error-body parsing, the auth/rate/invalid/not-found
 * predicates, the malformed-poll-body marker, the "retry-exhausted" heuristic
 * (call-deadline expiry included), the keyword-based 4xx sub-reason split
 * (`invalid_delay` vs `invalid_attachment` vs `payload_too_large` vs
 * `unverified_contact`), and which publish field an oversize rejection names.
 * @module tests/services/ntfy/error-classifier
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  classifyInvalidParams,
  getCode,
  getDataBody,
  getDataStatus,
  getMessage,
  isAuthCode,
  isInvalidParamsCode,
  isNotFoundCode,
  isRateLimitedCode,
  isUpstreamMalformed,
  isUpstreamUnreachable,
  oversizedPublishField,
  upstreamErrorDetail,
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

  it('getDataStatus returns the canonical numeric data.status', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidRequest, 'too big', { status: 413 });
    expect(getDataStatus(err)).toBe(413);
  });

  it('getDataStatus returns undefined when status is absent or non-numeric', () => {
    expect(getDataStatus(new Error('plain'))).toBeUndefined();
    expect(
      getDataStatus(new McpError(JsonRpcErrorCode.InvalidParams, 'x', { status: '413' })),
    ).toBeUndefined();
    expect(getDataStatus({ data: {} })).toBeUndefined();
    expect(getDataStatus(null)).toBeUndefined();
  });
});

describe('upstreamErrorDetail', () => {
  it('extracts the error string and docs link from an ntfy JSON body', () => {
    const body = JSON.stringify({
      code: 40004,
      http: 400,
      error: 'invalid delay parameter: unable to parse delay',
      link: 'https://ntfy.sh/docs/publish/#scheduled-delivery',
    });
    expect(upstreamErrorDetail(body)).toBe(
      'invalid delay parameter: unable to parse delay (see https://ntfy.sh/docs/publish/#scheduled-delivery)',
    );
  });

  it('returns the error string alone when no link is present', () => {
    const body = JSON.stringify({ code: 41303, http: 413, error: 'JSON body too large' });
    expect(upstreamErrorDetail(body)).toBe('JSON body too large');
  });

  it('returns undefined for an empty, non-JSON, or error-less body', () => {
    expect(upstreamErrorDetail('')).toBeUndefined();
    expect(upstreamErrorDetail('forbidden topic')).toBeUndefined();
    expect(upstreamErrorDetail('{"code":40004,"http":400}')).toBeUndefined();
    expect(upstreamErrorDetail('{"error":""}')).toBeUndefined();
    expect(upstreamErrorDetail('{"error":42}')).toBeUndefined();
  });

  it('returns undefined for a body truncated mid-JSON by the capture limit', () => {
    expect(upstreamErrorDetail('{"code":40004,"error":"invalid del…')).toBeUndefined();
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

describe('isUpstreamMalformed', () => {
  it('matches the retry-exhausted malformed-body failure the fetch path raises', () => {
    const err = new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      "The poll response is not ntfy's JSON message stream: line 2 is not valid JSON. (failed after 4 attempts)",
      { reason: 'upstream_malformed', retryable: true },
    );
    expect(isUpstreamMalformed(err)).toBe(true);
    // The unreachable heuristic claims the same error, so callers must check this first.
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('does not match other reasons, a reason-less 5xx, or non-errors', () => {
    expect(
      isUpstreamMalformed(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ntfy returned HTTP 502 Bad Gateway.'),
      ),
    ).toBe(false);
    expect(
      isUpstreamMalformed(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'x', { reason: 'upstream_unreachable' }),
      ),
    ).toBe(false);
    expect(isUpstreamMalformed(undefined)).toBe(false);
    expect(isUpstreamMalformed(new Error('upstream_malformed'))).toBe(false);
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

  it('matches a retry-exhausted ServiceUnavailable — the shape an ntfy 5xx takes', () => {
    const err = new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'ntfy returned HTTP 502 Bad Gateway. (failed after 4 attempts)',
    );
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('matches a retry-exhausted ServiceUnavailable from a 500', () => {
    // 500 and 501 map to ServiceUnavailable as well, so a hard upstream fault
    // exhausts under the same code as a gateway error.
    const err = new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'ntfy returned HTTP 500 Internal Server Error. (failed after 4 attempts)',
    );
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('matches a retry-exhausted Timeout', () => {
    const err = new McpError(
      JsonRpcErrorCode.Timeout,
      'ntfy returned HTTP 504 Gateway Timeout. (failed after 4 attempts)',
    );
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('matches the call-deadline expiry, which carries no attempt suffix', () => {
    const err = new McpError(
      JsonRpcErrorCode.Timeout,
      'ntfy poll exceeded its 50000ms retry deadline after 3 attempts.',
      { reason: 'retry_deadline_exceeded', deadlineMs: 50_000, elapsedMs: 50_000 },
    );
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('rejects the deadline reason on any code but Timeout', () => {
    const err = new McpError(JsonRpcErrorCode.RateLimited, 'throttled', {
      reason: 'retry_deadline_exceeded',
    });
    expect(isUpstreamUnreachable(err)).toBe(false);
  });

  it('rejects a retry-exhausted RateLimited — 429 has its own reason', () => {
    // RateLimited is transient and does exhaust with the suffix, but it is
    // deliberately excluded: every ntfy surface declares `rate_limited` for it
    // rather than calling the server unreachable.
    const err = new McpError(JsonRpcErrorCode.RateLimited, 'throttled (failed after 3 attempts)');
    expect(isUpstreamUnreachable(err)).toBe(false);
  });

  it('rejects a retry-exhausted error carrying a non-transient code', () => {
    for (const code of [
      JsonRpcErrorCode.Forbidden,
      JsonRpcErrorCode.NotFound,
      JsonRpcErrorCode.ValidationError,
      JsonRpcErrorCode.InvalidParams,
    ]) {
      expect(isUpstreamUnreachable(new McpError(code, 'nope (failed after 3 attempts)'))).toBe(
        false,
      );
    }
  });

  it('rejects a cancellation, retried or not — the caller is gone, not the server', () => {
    expect(
      isUpstreamUnreachable(new McpError(JsonRpcErrorCode.RequestCancelled, 'caller went away')),
    ).toBe(false);
    expect(
      isUpstreamUnreachable(
        new McpError(JsonRpcErrorCode.RequestCancelled, 'gone (failed after 3 attempts)'),
      ),
    ).toBe(false);
  });

  it('rejects errors that lack the retry-exhausted suffix', () => {
    expect(isUpstreamUnreachable(new Error('connection refused'))).toBe(false);
    expect(isUpstreamUnreachable(new Error(''))).toBe(false);
    // A transient code alone is not enough — a 503 that failed fast on an
    // over-cap `Retry-After` never went through the retry loop.
    expect(
      isUpstreamUnreachable(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ntfy is down')),
    ).toBe(false);
  });
});

describe('classifyInvalidParams', () => {
  it('returns `payload_too_large` when the message hints at attachment size', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'attachment too large for topic');
    expect(classifyInvalidParams(err)).toBe('payload_too_large');
  });

  it('returns `payload_too_large` when the captured body mentions a size rejection', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'request rejected', {
      body: 'HTTP 413 Payload Too Large',
    });
    expect(classifyInvalidParams(err)).toBe('payload_too_large');
  });

  it("returns `invalid_attachment` for ntfy's attachment-URL rejection", () => {
    const err = new McpError(
      JsonRpcErrorCode.InvalidParams,
      'ntfy returned HTTP 400 Bad Request: invalid request: attachment URL is invalid',
    );
    expect(classifyInvalidParams(err)).toBe('invalid_attachment');
  });

  it('returns `invalid_attachment` when the rejection is only in the captured body', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'ntfy returned HTTP 400 Bad Request', {
      body: '{"code":40013,"http":400,"error":"invalid request: attachment URL is invalid"}',
    });
    expect(classifyInvalidParams(err)).toBe('invalid_attachment');
  });

  it('does not treat a bare attachment mention as a size rejection', () => {
    // The old keyword match fired on the word "attachment" alone, telling the
    // agent to shorten its message when the real problem was the `attach` URL.
    const err = new McpError(
      JsonRpcErrorCode.InvalidParams,
      'ntfy returned HTTP 400 Bad Request: invalid request: attachment URL is invalid',
    );
    expect(classifyInvalidParams(err)).not.toBe('payload_too_large');
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
    // Order in the implementation: delay, attachment URL, then "too large", then
    // email/phone/verified. Lock that in so a refactor doesn't silently flip it.
    const err = new McpError(
      JsonRpcErrorCode.InvalidParams,
      'attachment too large; email recipient also unverified',
    );
    expect(classifyInvalidParams(err)).toBe('payload_too_large');
  });

  /** An ntfy 400 as `httpErrorFromResponse` raises it: status-line message plus the JSON body. */
  const ntfy400 = (code: number, error: string, link?: string) =>
    new McpError(
      JsonRpcErrorCode.InvalidParams,
      `ntfy returned HTTP 400 Bad Request: ${error}${link ? ` (see ${link})` : ''}`,
      {
        status: 400,
        body: JSON.stringify({ code, http: 400, error, ...(link ? { link } : {}) }),
      },
    );
  const DELAY_DOCS = 'https://ntfy.sh/docs/publish/#scheduled-delivery';

  it.each([
    [40004, 'invalid delay parameter: unable to parse delay'],
    [40005, 'invalid delay parameter: too small, please refer to the docs'],
    [40006, 'invalid delay parameter: too large, please refer to the docs'],
  ])("returns `invalid_delay` for ntfy's %i delay rejection", (code, error) => {
    expect(classifyInvalidParams(ntfy400(code, error, DELAY_DOCS))).toBe('invalid_delay');
  });

  it('returns `invalid_delay` when the delay rejection is only in the captured body', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'ntfy returned HTTP 400 Bad Request', {
      body: '{"code":40006,"http":400,"error":"invalid delay parameter: too large, please refer to the docs"}',
    });
    expect(classifyInvalidParams(err)).toBe('invalid_delay');
  });

  it.each([
    [40002, 'cannot disable cache for delayed message', undefined],
    [40003, 'delayed e-mail notifications are not supported', undefined],
    [40015, 'invalid request: attachment expiry before delayed delivery date', DELAY_DOCS],
    [40037, 'invalid request: delayed call notifications are not supported', undefined],
    [40059, 'invalid request: invalid timezone', DELAY_DOCS],
  ])(
    'never returns `invalid_delay` for %i, which names a delay or links the delay docs',
    (code, error, link) => {
      // Its text already names the conflict, so no sub-reason claims it at all.
      expect(classifyInvalidParams(ntfy400(code, error, link))).toBeUndefined();
    },
  );

  it.each([
    [40057, 'invalid request: title is too large'],
    [40058, 'invalid request: tags are too large'],
  ])('keeps %i, a field overflow, on `payload_too_large`', (code, error) => {
    const link = 'https://ntfy.sh/docs/publish/#limitations';
    expect(classifyInvalidParams(ntfy400(code, error, link))).toBe('payload_too_large');
  });
});

describe('oversizedPublishField', () => {
  const ntfy400 = (code: number, error: string) =>
    new McpError(JsonRpcErrorCode.InvalidParams, `ntfy returned HTTP 400 Bad Request: ${error}`, {
      status: 400,
      body: JSON.stringify({ code, http: 400, error }),
    });

  it("names the title for ntfy's 40057", () => {
    expect(oversizedPublishField(ntfy400(40057, 'invalid request: title is too large'))).toBe(
      'title',
    );
  });

  it("names the tags for ntfy's 40058", () => {
    expect(oversizedPublishField(ntfy400(40058, 'invalid request: tags are too large'))).toBe(
      'tags',
    );
  });

  it('reads the field from the captured body alone', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'ntfy returned HTTP 400 Bad Request', {
      body: '{"code":40058,"http":400,"error":"invalid request: tags are too large"}',
    });
    expect(oversizedPublishField(err)).toBe('tags');
  });

  it('names no field for a body overflow, a templated overflow, or another rejection', () => {
    const bodyOverflow = new McpError(
      JsonRpcErrorCode.InvalidRequest,
      'ntfy returned HTTP 413 Request Entity Too Large: JSON body too large',
      { status: 413, body: '{"code":41303,"http":413,"error":"JSON body too large"}' },
    );
    expect(oversizedPublishField(bodyOverflow)).toBeUndefined();
    // 40041 says "title is too large" mid-sentence but is about a rendered template.
    expect(
      oversizedPublishField(
        ntfy400(40041, 'invalid request: message or title is too large after replacing template'),
      ),
    ).toBeUndefined();
    expect(
      oversizedPublishField(
        ntfy400(40006, 'invalid delay parameter: too large, please refer to the docs'),
      ),
    ).toBeUndefined();
  });
});
