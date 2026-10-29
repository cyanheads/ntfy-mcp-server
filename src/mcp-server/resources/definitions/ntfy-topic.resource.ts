/**
 * @fileoverview `ntfy://{topic}` — snapshot resource for a single ntfy topic.
 * Wraps `NtfyService.fetch()` with fixed defaults (since=1h, latest 20) so
 * clients can answer "what's happening on topic X" without parameterizing a
 * tool, normalizing messages through the shared `shapeMessage` so the payload
 * matches `ntfy_fetch_messages` field for field. ntfy's own auth refusals (a
 * 401/403 carrying its error envelope), a 429 that outlasts the service's
 * retries, an ntfy server that never answers within the
 * retries or the call deadline (or answers 5xx with a `Retry-After` the read
 * cannot wait out), and a poll body that is not ntfy's message stream fail the
 * read with the declared `forbidden_topic` / `rate_limited` /
 * `upstream_unreachable` / `upstream_malformed` reasons. For filtering or
 * replay, callers should use `ntfy_fetch_messages`.
 * @module mcp-server/resources/definitions/ntfy-topic.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import {
  getCode,
  getMessage,
  isAuthRejection,
  isRateLimitedCode,
  isUpstreamMalformed,
  isUpstreamUnreachable,
  retryAfterData,
  unreachableWaitData,
} from '@/services/ntfy/error-classifier.js';
import { MESSAGE_TRUNCATE_AT, shapeMessage } from '@/services/ntfy/message-shape.js';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';
import type { NtfyFetchResult } from '@/services/ntfy/types.js';

const TOPIC_REGEX = /^[a-zA-Z0-9_-]+$/;
const SNAPSHOT_SINCE = '1h';
const SNAPSHOT_LIMIT = 20;

const ParamsSchema = z.object({
  topic: z
    .string()
    .min(1)
    .max(64)
    .regex(TOPIC_REGEX)
    .describe('Topic name (1–64 chars, `[a-zA-Z0-9_-]`).'),
});

export const ntfyTopicResource = resource('ntfy://{topic}', {
  name: 'ntfy-topic-snapshot',
  description: `Snapshot of a topic's recently-cached messages — latest 20 from the last 1 hour, plus the topic's browser URL. Messages are oldest-first with ISO 8601 timestamps, and bodies longer than ~${MESSAGE_TRUNCATE_AT} characters are truncated with the dropped count reported as \`messageTruncated\`. \`upstreamTruncated\` is true when ntfy itself capped the replay and dropped older messages before responding. Discoverable 'what's happening on topic X' lookup; for filters, custom windows, or replay use \`ntfy_fetch_messages\`.`,
  mimeType: 'application/json',
  params: ParamsSchema,

  errors: [
    {
      reason: 'forbidden_topic',
      code: JsonRpcErrorCode.Forbidden,
      when: 'ntfy refused access to the topic with its own 401 or 403 error: the topic needs credentials this server did not send, or the ones it sent lack access.',
      recovery:
        'Try an unprotected topic; if this topic must stay protected, ask the operator to configure ntfy auth (`NTFY_AUTH_TOKEN`, or `NTFY_AUTH_USERNAME` + `NTFY_AUTH_PASSWORD`, or per-host entries in `NTFY_SERVERS`).',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ntfy answered 429 — on the status line, or as an error line written into the replay — and was still answering it when retries ran out.',
      retryable: true,
      recovery:
        "Wait for ntfy's rate-limit window to pass before reading the topic again — `retryAfter` seconds when the error carries it. A request-rate limit (`too many requests`) clears within minutes; a daily quota (`daily … reached`) resets within 24 hours.",
    },
    {
      reason: 'upstream_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A DNS, connection, or network failure or a 5xx answer that outlasted the retries, no complete answer within the call deadline, or a 5xx whose `Retry-After` is longer than the call can wait.',
      retryable: true,
      recovery:
        'When the error carries `retryAfter`, the ntfy server is answering and asked for that wait: read the topic again once it has passed. Otherwise read the topic again shortly; if it keeps failing, ask the operator to check that the configured `NTFY_BASE_URL` resolves and is reachable from this server.',
    },
    {
      reason: 'upstream_malformed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The poll response was not ntfy's JSON message stream (an HTML page, a cut-off or corrupted body) on every attempt.",
      retryable: true,
      thrownBy: 'service',
      recovery:
        "The server at the configured `NTFY_BASE_URL` answered with something other than ntfy's JSON message stream. Read the topic again; if it persists, ask the operator to point `NTFY_BASE_URL` at an ntfy server.",
    },
  ],

  async handler(params, ctx) {
    const service = getNtfyService();

    let polled: NtfyFetchResult;
    try {
      polled = await service.fetch(
        { topic: params.topic, since: SNAPSHOT_SINCE },
        { signal: ctx.signal },
      );
    } catch (err) {
      // Already carries its declared reason; the unreachable branch below would
      // otherwise claim it, since it too is a retry-exhausted ServiceUnavailable.
      if (isUpstreamMalformed(err)) throw err;
      const code = getCode(err);
      if (isRateLimitedCode(code)) {
        throw ctx.fail(
          'rate_limited',
          getMessage(err) || 'ntfy returned 429 after retries.',
          retryAfterData(err),
        );
      }
      if (isAuthRejection(err)) {
        throw ctx.fail(
          'forbidden_topic',
          getMessage(err) || `Forbidden for topic "${params.topic}"`,
          undefined,
          { cause: err },
        );
      }
      if (isUpstreamUnreachable(err)) {
        throw ctx.fail(
          'upstream_unreachable',
          getMessage(err) || 'ntfy server is unreachable.',
          unreachableWaitData(err, 'read the topic again'),
          { cause: err },
        );
      }
      throw err;
    }

    const notifications = polled.messages.filter(
      (m) => m.event !== 'open' && m.event !== 'keepalive',
    );
    const truncated = notifications.length > SNAPSHOT_LIMIT;
    // ntfy returns the cache oldest-first, so the *latest* 20 this resource
    // advertises are the tail — the kept slice stays oldest-first internally.
    const slice = truncated ? notifications.slice(-SNAPSHOT_LIMIT) : notifications;

    return {
      topic: params.topic,
      url: `${service.baseUrl}/${params.topic}`,
      baseUrl: service.baseUrl,
      since: SNAPSHOT_SINCE,
      messages: slice.map((m) => shapeMessage(m)),
      count: slice.length,
      truncated,
      upstreamTruncated: polled.upstreamTruncated,
    };
  },
});
