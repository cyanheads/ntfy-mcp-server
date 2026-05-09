/**
 * @fileoverview `ntfy_manage_message` — clears or deletes a previously-sent
 * notification by `sequence_id`. Append-only: the original message stays in
 * cache; subscribers receive a `message_clear` or `message_delete` event and
 * update the notification accordingly.
 * @module mcp-server/tools/definitions/ntfy-manage-message.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';

import { getServerConfig } from '@/config/server-config.js';
import {
  getCode,
  getMessage,
  isAuthCode,
  isNotFoundCode,
} from '@/services/ntfy/error-classifier.js';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';
import type { NtfyManageResponse } from '@/services/ntfy/types.js';

const TOPIC_REGEX = /^[a-zA-Z0-9_-]+$/;
const SEQUENCE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

const InputSchema = z.object({
  topic: z
    .string()
    .min(1)
    .max(64)
    .regex(TOPIC_REGEX)
    .optional()
    .describe('Topic the message was published to. Required unless NTFY_DEFAULT_TOPIC is set.'),
  sequence_id: z
    .string()
    .regex(SEQUENCE_ID_REGEX)
    .describe(
      'Identifier of the previously-published message. Same value used as `sequence_id` on `ntfy_publish_message`. 1–64 chars, `[a-zA-Z0-9_-]`.',
    ),
  operation: z
    .enum(['clear', 'delete'])
    .describe(
      'What to do: `clear` marks the notification read & dismisses it (subscribers see `message_clear`); `delete` removes it from the drawer (subscribers see `message_delete`). Both are no-ops on already-cleared/deleted sequences.',
    ),
  base_url: z
    .url()
    .optional()
    .describe(
      'Override the configured `NTFY_BASE_URL` for this call. When the override differs from the configured base URL, server-configured auth credentials are NOT forwarded.',
    ),
});

const OutputSchema = z.object({
  event_id: z
    .string()
    .describe(
      'Server-assigned ID of the emitted `message_clear` / `message_delete` event — distinct from the original message `sequence_id` it references.',
    ),
  topic: z.string().describe('Topic the event was emitted on.'),
  sequence_id: z.string().describe('Sequence ID of the original message the event references.'),
  operation: z.enum(['clear', 'delete']).describe('Echo of the requested operation.'),
  time: z.string().describe('ISO 8601 timestamp when ntfy emitted the event.'),
});

export const ntfyManageMessage = tool('ntfy_manage_message', {
  description:
    'Clear (mark read & dismiss) or delete a previously-sent ntfy notification by `sequence_id`. Append-only: the original message stays in cache and a `message_clear`/`message_delete` event is emitted to subscribers. Idempotent — clearing a cleared message or deleting a deleted message is a no-op.',
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: InputSchema,
  output: OutputSchema,

  errors: [
    {
      reason: 'forbidden_topic',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Auth required for the target topic.',
      recovery:
        'Try an unprotected topic instead; if this topic must stay protected, ask the operator to provision ntfy auth credentials for the server before retrying.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The sequence_id was never published to this topic, or the cache window has elapsed.',
      recovery:
        'Confirm the topic and `sequence_id` were correct (call `ntfy_fetch_messages` to inspect what is still cached), or accept that the message has aged out (default cache window is 12h).',
    },
  ],

  async handler(input, ctx) {
    const cfg = getServerConfig();
    const topic = input.topic ?? cfg.defaultTopic;
    if (!topic) {
      throw validationError('Topic is required when NTFY_DEFAULT_TOPIC is unset.', {
        recovery: {
          hint: 'Pass a `topic` argument or configure NTFY_DEFAULT_TOPIC on the server.',
        },
      });
    }

    const overrideBase = input.base_url?.replace(/\/+$/, '');

    let response: NtfyManageResponse;
    try {
      response = await getNtfyService().manage(topic, input.sequence_id, input.operation, {
        baseUrl: overrideBase,
        signal: ctx.signal,
      });
    } catch (err) {
      const code = getCode(err);
      const msg = getMessage(err);
      if (isAuthCode(code)) {
        throw ctx.fail('forbidden_topic', msg || `Forbidden for topic ${topic}`, {
          ...ctx.recoveryFor('forbidden_topic'),
        });
      }
      if (isNotFoundCode(code)) {
        throw ctx.fail(
          'not_found',
          msg || `No cached message ${input.sequence_id} on topic ${topic}.`,
          { ...ctx.recoveryFor('not_found') },
        );
      }
      throw err;
    }

    ctx.log.info('Managed ntfy message', {
      eventId: response.id,
      operation: input.operation,
    });

    return {
      event_id: response.id,
      topic: response.topic,
      sequence_id: response.sequence_id,
      operation: input.operation,
      time: new Date(response.time * 1000).toISOString(),
    };
  },

  format(result) {
    const verb = result.operation === 'clear' ? 'cleared' : 'deleted';
    const lines = [
      `**${verb.toUpperCase()}** sequence \`${result.sequence_id}\` on topic \`${result.topic}\``,
      `Event ID: \`${result.event_id}\``,
      `Operation: ${result.operation}`,
      `Time: ${result.time}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
