/**
 * @fileoverview `ntfy://{topic}` — snapshot resource for a single ntfy topic.
 * Wraps `NtfyService.fetch()` with fixed defaults (since=1h, limit=20) so
 * clients can answer "what's happening on topic X" without parameterizing a
 * tool. For filtering or replay, callers should use `ntfy_fetch_messages`.
 * @module mcp-server/resources/definitions/ntfy-topic.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { forbidden } from '@cyanheads/mcp-ts-core/errors';

import { getServerConfig } from '@/config/server-config.js';
import { isAuthCode } from '@/services/ntfy/error-classifier.js';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';
import type { NtfyMessage } from '@/services/ntfy/types.js';

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
  description:
    "Snapshot of a topic's recently-cached messages — latest 20 from the last 1 hour, plus the topic's browser URL. Discoverable 'what's happening on topic X' lookup; for filters, custom windows, or replay use `ntfy_fetch_messages`.",
  mimeType: 'application/json',
  params: ParamsSchema,

  async handler(params, ctx) {
    const cfg = getServerConfig();
    const service = getNtfyService();

    let raw: NtfyMessage[];
    try {
      raw = await service.fetch(
        { topic: params.topic, since: SNAPSHOT_SINCE },
        { signal: ctx.signal },
      );
    } catch (err) {
      if (isAuthCode((err as { code?: unknown })?.code)) {
        const msg =
          typeof (err as { message?: unknown }).message === 'string'
            ? (err as { message: string }).message
            : `Forbidden for topic ${params.topic}`;
        throw forbidden(
          msg,
          {
            recovery: {
              hint: 'Try an unprotected topic; if this topic must stay protected, ask the operator to provision ntfy auth credentials.',
            },
          },
          { cause: err },
        );
      }
      throw err;
    }

    const notifications = raw.filter((m) => m.event !== 'open' && m.event !== 'keepalive');
    const truncated = notifications.length > SNAPSHOT_LIMIT;
    const slice = truncated ? notifications.slice(0, SNAPSHOT_LIMIT) : notifications;

    return {
      topic: params.topic,
      url: `${cfg.baseUrl}/${params.topic}`,
      baseUrl: cfg.baseUrl,
      since: SNAPSHOT_SINCE,
      messages: slice,
      count: slice.length,
      truncated,
    };
  },
});
