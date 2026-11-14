/**
 * @fileoverview Tests for the pure-data error classifiers — code/message/status
 * extraction, upstream JSON error-body parsing, the envelope check, the auth
 * rejection read from ntfy's own error envelope, the `not_ntfy_endpoint` split
 * (no envelope on a final status, or ntfy's 40401), the rate/invalid/not-found
 * predicates, the malformed-poll-body marker, the "retry-exhausted" heuristic
 * (call-deadline expiry included), the phrase-based 4xx sub-reason split (`invalid_delay` vs
 * `invalid_attachment` vs `payload_too_large` vs `unverified_contact`) and the
 * `invalid_timezone` read from ntfy's envelope code, the anonymous-sender
 * refusal, and which publish field an oversize rejection names.
 * @module tests/services/ntfy/error-classifier
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { httpStatusToErrorCode } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';

import {
  classifyInvalidParams,
  getCode,
  getDataBody,
  getDataStatus,
  getMessage,
  hasNtfyEnvelope,
  isAnonymousSenderRejection,
  isAuthRejection,
  isFileStoreFailure,
  isInvalidParamsCode,
  isNotFoundCode,
  isNotNtfyEndpoint,
  isNtfyInternalError,
  isRateLimitedCode,
  isUpstreamMalformed,
  isUpstreamUnreachable,
  oversizedPublishField,
  upstreamErrorDetail,
} from '@/services/ntfy/error-classifier.js';

const RPC_CODE_BY_STATUS: Record<number, JsonRpcErrorCode> = {
  400: JsonRpcErrorCode.InvalidParams,
  401: JsonRpcErrorCode.Unauthorized,
  403: JsonRpcErrorCode.Forbidden,
  413: JsonRpcErrorCode.InvalidRequest,
  500: JsonRpcErrorCode.ServiceUnavailable,
  502: JsonRpcErrorCode.ServiceUnavailable,
};

/**
 * An ntfy rejection as `ntfyHttpError` raises it: the status line with ntfy's
 * `error (see link)` folded in, and the `{ code, http, error, link }` envelope
 * (texts from ntfy's `server/errors.go`) captured as `data.body`.
 */
function ntfyRejection(status: number, code: number, error: string, link?: string) {
  return new McpError(
    RPC_CODE_BY_STATUS[status] ?? JsonRpcErrorCode.InternalError,
    `ntfy returned HTTP ${status}: ${error}${link ? ` (see ${link})` : ''}`,
    {
      status,
      body: JSON.stringify({ code, http: status, error, ...(link ? { link } : {}) }),
    },
  );
}

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

describe('isAuthRejection', () => {
  const AUTH_DOCS = 'https://ntfy.sh/docs/publish/#authentication';

  it.each([
    [401, 40101, 'unauthorized'],
    [403, 40301, 'forbidden'],
  ])("matches ntfy's own %i envelope (%i)", (status, code, error) => {
    expect(isAuthRejection(ntfyRejection(status, code, error, AUTH_DOCS))).toBe(true);
  });

  it("rejects a 403 with no ntfy envelope — a proxy's HTML page", () => {
    const err = new McpError(JsonRpcErrorCode.Forbidden, 'ntfy returned HTTP 403 Forbidden.', {
      status: 403,
      body: '<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n',
    });
    expect(isAuthRejection(err)).toBe(false);
  });

  it('rejects a 401 or 403 that carries no body, a plain-text body, or a cut-off envelope', () => {
    expect(isAuthRejection(new McpError(JsonRpcErrorCode.Forbidden, 'Topic forbidden'))).toBe(
      false,
    );
    expect(
      isAuthRejection(
        new McpError(JsonRpcErrorCode.Unauthorized, 'x', { status: 401, body: 'unauthorized' }),
      ),
    ).toBe(false);
    expect(
      isAuthRejection(
        new McpError(JsonRpcErrorCode.Forbidden, 'x', { status: 403, body: '{"code":40301,"ht' }),
      ),
    ).toBe(false);
  });

  it('rejects an envelope whose code is not an ntfy 401xx/403xx', () => {
    expect(isAuthRejection(ntfyRejection(400, 40001, 'e-mail notifications are not enabled'))).toBe(
      false,
    );
    expect(isAuthRejection(ntfyRejection(429, 42901, 'limit reached: too many requests'))).toBe(
      false,
    );
    expect(isAuthRejection(ntfyRejection(404, 40401, 'page not found'))).toBe(false);
    // A string code, or a JSON value that is not an envelope object, is no ntfy code.
    for (const body of ['{"code":"40301","http":403}', '40301', 'null', '[40301]']) {
      expect(
        isAuthRejection(new McpError(JsonRpcErrorCode.Forbidden, 'x', { status: 403, body })),
      ).toBe(false);
    }
  });

  it('rejects an auth code carried on a status ntfy never pairs it with', () => {
    for (const status of [400, 404, 429, 503]) {
      expect(isAuthRejection(ntfyRejection(status, 40301, 'forbidden'))).toBe(false);
    }
    expect(isAuthRejection(ntfyRejection(403, 40101, 'unauthorized'))).toBe(false);
  });

  it('is null-safe', () => {
    expect(isAuthRejection(undefined)).toBe(false);
    expect(isAuthRejection(new Error('forbidden'))).toBe(false);
  });
});

/**
 * An answer as `httpErrorFromResponse` captures it: the status-derived code,
 * `data.status`, and the body under `data.body`. The bodies are real answers:
 * ntfy's own envelopes, ntfy.sh's `static` file server, example.com, nginx, and
 * Python's `http.server`.
 */
function answer(status: number, body: string) {
  return new McpError(httpStatusToErrorCode(status) ?? JsonRpcErrorCode.InternalError, 'x', {
    status,
    body,
  });
}

const ROUTE_MISS = '{"code":40401,"http":404,"error":"page not found"}';
const EXAMPLE_PAGE =
  '<!doctype html><html lang=en><head><title>Example Domain</title></head><body><p>This domain is for use in documentation examples.</p></body></html>';
const NGINX_403 =
  '<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n';
const PYTHON_501 =
  "<!DOCTYPE HTML>\n<html><head><title>Error response</title></head><body><h1>Error response</h1><p>Error code: 501</p><p>Message: Unsupported method ('POST').</p></body></html>\n";

describe('hasNtfyEnvelope', () => {
  it.each([
    [403, '{"code":40301,"http":403,"error":"forbidden"}'],
    [404, ROUTE_MISS],
    [429, '{"code":42901,"http":429,"error":"limit reached: too many requests"}'],
    [500, '{"code":50001,"http":500,"error":"internal server error"}'],
  ])("recognizes ntfy's own %i envelope", (status, body) => {
    expect(hasNtfyEnvelope(answer(status, body))).toBe(true);
  });

  it.each([
    ['an HTML page', 403, NGINX_403],
    ['plain text', 404, '404 page not found\n'],
    ['an empty body', 405, ''],
    ['JSON with no code', 404, '{"error":"not found"}'],
    ['a string code', 403, '{"code":"40301","http":403}'],
    ['an envelope cut off by the capture limit', 403, '{"code":40301,"ht'],
    ['a code whose status family differs from the response', 404, '{"code":40301,"http":403}'],
  ])('finds none in %s', (_label, status, body) => {
    expect(hasNtfyEnvelope(answer(status, body))).toBe(false);
  });

  it('is null-safe', () => {
    expect(hasNtfyEnvelope(undefined)).toBe(false);
    expect(hasNtfyEnvelope(new Error('page not found'))).toBe(false);
  });
});

/**
 * #55: an answer that did not come from an ntfy topic route. ntfy answers every
 * failure on its own routes with its envelope, so one without it came from
 * something else; ntfy's own 40401 is a route miss. Statuses another reason
 * claims (429, the retried 408/425/5xx) and every other ntfy envelope stay out.
 */
describe('isNotNtfyEndpoint', () => {
  it.each([
    ['a plain-text 404 (ntfy.sh `static`)', 404, '404 page not found\n'],
    ['an HTML 404 (a host that is not ntfy)', 404, EXAMPLE_PAGE],
    ['an HTML 405', 405, EXAMPLE_PAGE],
    ['an HTML 501', 501, PYTHON_501],
    ['a plain-text 401', 401, 'Unauthorized'],
    ["a proxy's HTML 403", 403, NGINX_403],
    ["a proxy's HTML 400", 400, '<html><head><title>400 Bad Request</title></head></html>'],
    ['an empty 410', 410, ''],
    ['a redirect that was not followed', 304, ''],
    ['JSON with no envelope code', 404, '{"error":"not found"}'],
    [
      'an auth envelope on a 404, a status ntfy never pairs it with',
      404,
      '{"code":40301,"http":403,"error":"forbidden"}',
    ],
    ["ntfy's own 40401 route miss", 404, ROUTE_MISS],
  ])('claims %s', (_label, status, body) => {
    expect(isNotNtfyEndpoint(answer(status, body))).toBe(true);
  });

  it.each([
    ["ntfy's 403 auth envelope", 403, '{"code":40301,"http":403,"error":"forbidden"}'],
    ["ntfy's 401 auth envelope", 401, '{"code":40101,"http":401,"error":"unauthorized"}'],
    ["ntfy's 40008", 400, '{"code":40008,"http":400,"error":"invalid since parameter"}'],
    [
      "ntfy's 40010",
      400,
      '{"code":40010,"http":400,"error":"invalid request: topic name is not allowed"}',
    ],
    ["ntfy's 40061", 400, '{"code":40061,"http":400,"error":"invalid request: too many topics"}'],
    ["ntfy's 413", 413, '{"code":41303,"http":413,"error":"JSON body too large"}'],
    ["ntfy's 429", 429, '{"code":42901,"http":429,"error":"limit reached: too many requests"}'],
    ['a 429 without an envelope', 429, 'slow down'],
    ['a 408 without an envelope', 408, ''],
    ['a 425 without an envelope', 425, ''],
    ["ntfy's 500", 500, '{"code":50001,"http":500,"error":"internal server error"}'],
    ['a 500 without an envelope', 500, 'boom'],
    ["a proxy's 502", 502, '<html><body><h1>502 Bad Gateway</h1></body></html>'],
    ['an empty 503', 503, ''],
    ['an empty 504', 504, ''],
    ['40401 on a 503, a status ntfy never pairs it with', 503, ROUTE_MISS],
  ])('leaves %s to its own outcome', (_label, status, body) => {
    expect(isNotNtfyEndpoint(answer(status, body))).toBe(false);
  });

  it('leaves an error that carries no upstream status alone', () => {
    expect(isNotNtfyEndpoint(new McpError(JsonRpcErrorCode.NotFound, 'page not found'))).toBe(
      false,
    );
    expect(isNotNtfyEndpoint(new Error('fetch failed'))).toBe(false);
    expect(isNotNtfyEndpoint(undefined)).toBe(false);
  });
});

describe('error-classifier predicates', () => {
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

/**
 * ntfy's own 500 `50001` envelope, which `NtfyService.publish` reads as a failed
 * file write when the publish stores its body as a file (#46).
 */
describe('isNtfyInternalError', () => {
  it("matches ntfy's own 500 envelope (50001)", () => {
    expect(isNtfyInternalError(ntfyRejection(500, 50001, 'internal server error'))).toBe(true);
  });

  it('rejects a 500 with no ntfy envelope: an empty, plain-text, HTML, or cut-off body', () => {
    for (const body of [
      '',
      'boom',
      '<html><body><h1>500 Internal Server Error</h1></body></html>',
      '{"code":50001,"ht',
      '{"code":"50001","http":500}',
    ]) {
      const err = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'x', { status: 500, body });
      expect(isNtfyInternalError(err)).toBe(false);
    }
    expect(
      isNtfyInternalError(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'internal error')),
    ).toBe(false);
  });

  it('rejects another ntfy code, or 50001 on a status ntfy never pairs it with', () => {
    expect(isNtfyInternalError(ntfyRejection(500, 50002, 'internal server error'))).toBe(false);
    expect(isNtfyInternalError(ntfyRejection(502, 50001, 'internal server error'))).toBe(false);
    expect(isNtfyInternalError(ntfyRejection(400, 40013, 'invalid request'))).toBe(false);
  });

  it('is null-safe', () => {
    expect(isNtfyInternalError(undefined)).toBe(false);
    expect(isNtfyInternalError(new Error('internal server error'))).toBe(false);
  });
});

describe('isFileStoreFailure', () => {
  it('matches the failure the publish path labels `invalid_attachment`', () => {
    const err = new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'ntfy returned HTTP 500 Internal Server Error: internal server error',
      { status: 500, reason: 'invalid_attachment', retryable: false },
    );
    expect(isFileStoreFailure(err)).toBe(true);
    // Not retried, so it never carries the suffix the unreachable heuristic reads.
    expect(isUpstreamUnreachable(err)).toBe(false);
  });

  it("does not match ntfy's unlabelled 500, another reason, or non-errors", () => {
    expect(isFileStoreFailure(ntfyRejection(500, 50001, 'internal server error'))).toBe(false);
    expect(
      isFileStoreFailure(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'x', { reason: 'upstream_malformed' }),
      ),
    ).toBe(false);
    expect(isFileStoreFailure(undefined)).toBe(false);
    expect(isFileStoreFailure(new Error('invalid_attachment'))).toBe(false);
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
    // A transient code alone is not enough: with no suffix and no `Retry-After`,
    // nothing says the retry boundary gave up on it.
    expect(
      isUpstreamUnreachable(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ntfy is down')),
    ).toBe(false);
  });

  it.each([
    ['a 503', JsonRpcErrorCode.ServiceUnavailable, '120'],
    [
      'a 503 with an HTTP-date',
      JsonRpcErrorCode.ServiceUnavailable,
      'Thu, 29 Oct 2026 16:06:04 GMT',
    ],
    ['a 504', JsonRpcErrorCode.Timeout, '45'],
    ['a numeric wait', JsonRpcErrorCode.ServiceUnavailable, 120],
  ])(
    'matches %s that failed fast on a Retry-After the call could not wait out',
    (_label, code, retryAfter) => {
      const err = new McpError(code, 'ntfy returned HTTP 503 Service Unavailable', {
        status: 503,
        retryAfter,
      });
      expect(isUpstreamUnreachable(err)).toBe(true);
    },
  );

  it('rejects a Retry-After on an answer that is not a transient 5xx', () => {
    for (const code of [
      JsonRpcErrorCode.RateLimited,
      JsonRpcErrorCode.RequestCancelled,
      JsonRpcErrorCode.Forbidden,
      JsonRpcErrorCode.InvalidRequest,
    ]) {
      expect(isUpstreamUnreachable(new McpError(code, 'nope', { retryAfter: '120' }))).toBe(false);
    }
    // A 501 is marked not retryable: withRetry never meant to retry it, Retry-After or not.
    expect(
      isUpstreamUnreachable(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ntfy returned HTTP 501', {
          retryAfter: '120',
          retryable: false,
        }),
      ),
    ).toBe(false);
    // Neither is a Retry-After on a plain Error, which carries no code at all.
    expect(
      isUpstreamUnreachable(Object.assign(new Error('x'), { data: { retryAfter: '1' } })),
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

  const PHONE_DOCS = 'https://ntfy.sh/docs/publish/#phone-calls';
  const EMAIL_DOCS = 'https://ntfy.sh/docs/publish/#e-mail-notifications';

  it.each([
    [
      40034,
      'invalid request: phone number not verified, or no matching verified numbers found',
      PHONE_DOCS,
    ],
    [40035, 'invalid request: anonymous phone calls are not allowed', PHONE_DOCS],
    [40052, 'invalid request: email address not verified', EMAIL_DOCS],
    [40053, 'invalid request: anonymous email sending is not allowed', EMAIL_DOCS],
  ])("returns `unverified_contact` for ntfy's %i", (code, error, link) => {
    expect(classifyInvalidParams(ntfyRejection(400, code, error, link))).toBe('unverified_contact');
  });

  it.each([
    [40032, 'invalid request: calling is disabled', 'https://ntfy.sh/docs/config/#phone-calls'],
    [40033, 'invalid request: phone number invalid', PHONE_DOCS],
    [
      40001,
      'e-mail notifications are not enabled',
      'https://ntfy.sh/docs/config/#e-mail-notifications',
    ],
    [40050, 'invalid request: invalid e-mail address', EMAIL_DOCS],
  ])(
    "returns no sub-reason for ntfy's %i, whose own text names the fix — not its docs link or a bare `phone`",
    (code, error, link) => {
      expect(classifyInvalidParams(ntfyRejection(400, code, error, link))).toBeUndefined();
    },
  );

  it('reads a contact refusal from the captured body alone', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'ntfy returned HTTP 400 Bad Request', {
      body: '{"code":40052,"http":400,"error":"invalid request: email address not verified"}',
    });
    expect(classifyInvalidParams(err)).toBe('unverified_contact');
  });

  it('matches case-insensitively', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'ATTACHMENT TOO LARGE');
    expect(classifyInvalidParams(err)).toBe('payload_too_large');
    expect(
      classifyInvalidParams(
        new McpError(JsonRpcErrorCode.InvalidParams, 'Invalid request: Email address not verified'),
      ),
    ).toBe('unverified_contact');
  });

  it('returns undefined when neither pattern matches', () => {
    const err = new McpError(JsonRpcErrorCode.InvalidParams, 'something else went wrong');
    expect(classifyInvalidParams(err)).toBeUndefined();
  });

  it('payload_too_large takes precedence when both phrases are present', () => {
    // Order in the implementation: delay, attachment URL, "too large", then the
    // contact refusals. Lock that in so a refactor doesn't silently flip it.
    const err = new McpError(
      JsonRpcErrorCode.InvalidParams,
      'title is too large; email address not verified',
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
  ])(
    'never returns `invalid_delay` for %i, which names a delay or links the delay docs',
    (code, error, link) => {
      // Its text already names the conflict, so no sub-reason claims it at all.
      expect(classifyInvalidParams(ntfy400(code, error, link))).toBeUndefined();
    },
  );

  it("returns `invalid_timezone` for ntfy's 40059, not `invalid_delay`", () => {
    expect(
      classifyInvalidParams(ntfy400(40059, 'invalid request: invalid timezone', DELAY_DOCS)),
    ).toBe('invalid_timezone');
  });

  it("reads `invalid_timezone` from ntfy's envelope code, never from the words alone", () => {
    // ntfy's wording with no envelope behind it: a proxy page, a truncated body.
    const wordsOnly = new McpError(
      JsonRpcErrorCode.InvalidParams,
      'ntfy returned HTTP 400 Bad Request: invalid request: invalid timezone',
      { status: 400, body: '<html><body>invalid request: invalid timezone</body></html>' },
    );
    expect(classifyInvalidParams(wordsOnly)).toBeUndefined();
    // 40059 on a status ntfy never pairs it with is no answer ntfy sent.
    const wrongStatus = new McpError(
      JsonRpcErrorCode.InvalidParams,
      'ntfy returned HTTP 422: invalid request: invalid timezone',
      {
        status: 422,
        body: JSON.stringify({
          code: 40059,
          http: 400,
          error: 'invalid request: invalid timezone',
        }),
      },
    );
    expect(classifyInvalidParams(wrongStatus)).toBeUndefined();
  });

  it.each([
    [40057, 'invalid request: title is too large'],
    [40058, 'invalid request: tags are too large'],
  ])('keeps %i, a field overflow, on `payload_too_large`', (code, error) => {
    const link = 'https://ntfy.sh/docs/publish/#limitations';
    expect(classifyInvalidParams(ntfy400(code, error, link))).toBe('payload_too_large');
  });
});

describe('isAnonymousSenderRejection', () => {
  it.each([
    [40035, 'invalid request: anonymous phone calls are not allowed'],
    [40053, 'invalid request: anonymous email sending is not allowed'],
  ])("matches ntfy's %i refusal of a sender with no credentials", (code, error) => {
    expect(isAnonymousSenderRejection(ntfyRejection(400, code, error))).toBe(true);
  });

  it.each([
    [40034, 'invalid request: phone number not verified, or no matching verified numbers found'],
    [40052, 'invalid request: email address not verified'],
    [40033, 'invalid request: phone number invalid'],
  ])('does not match %i', (code, error) => {
    expect(isAnonymousSenderRejection(ntfyRejection(400, code, error))).toBe(false);
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

  it("names the attachment for ntfy's 41301, which the body or the 400 phrasing never trips", () => {
    expect(
      oversizedPublishField(
        ntfyRejection(
          413,
          41301,
          'attachment too large, or bandwidth limit reached',
          'https://ntfy.sh/docs/publish/#limitations',
        ),
      ),
    ).toBe('attachment');
    // 41302 (Matrix) and 41303 (JSON body) are body overflows, not attachments.
    expect(
      oversizedPublishField(
        ntfyRejection(413, 41302, 'Matrix request is larger than the max allowed length'),
      ),
    ).toBeUndefined();
    expect(oversizedPublishField(ntfyRejection(413, 41303, 'JSON body too large'))).toBeUndefined();
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
