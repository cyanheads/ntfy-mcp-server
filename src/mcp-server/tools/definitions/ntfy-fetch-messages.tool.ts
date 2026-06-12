/**
 * @fileoverview `ntfy_fetch_messages` — polls cached messages from one or more
 * ntfy topics with optional filters. Single round-trip via the upstream
 * `<topic>/json?poll=1` endpoint; the response is parsed line-by-line and
 * filtered to drop transport frames (`open`, `keepalive`). The resolved
 * topic/since, returned count, truncation flag, active filters, and
 * empty/truncated guidance ride the `enrichment` block so they reach both
 * `structuredContent` and `content[]` without a `format()` entry.
 * @module mcp-server/tools/definitions/ntfy-fetch-messages.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';

import { getServerConfig } from '@/config/server-config.js';
import { MESSAGE_TRUNCATE_AT, shapeNtfyMessage } from '@/mcp-server/shared/ntfy-message.js';
import {
  getCode,
  getMessage,
  isAuthCode,
  isInvalidParamsCode,
  isUpstreamUnreachable,
} from '@/services/ntfy/error-classifier.js';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';
import type { NtfyMessage, Priority } from '@/services/ntfy/types.js';

const TOPIC_LIST_REGEX = /^[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+)*$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const PrioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const ActionReadbackSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('view').describe('Discriminator — `view`.'),
        label: z.string().describe('Button label.'),
        url: z.string().describe('URL opened on tap.'),
        clear: z.boolean().optional().describe('Whether the notification dismisses on tap.'),
      })
      .describe('Open a URL or app on tap.'),
    z
      .object({
        action: z.literal('broadcast').describe('Discriminator — `broadcast`.'),
        label: z.string().describe('Button label.'),
        intent: z.string().optional().describe('Android intent name.'),
        extras: z
          .record(z.string(), z.string())
          .optional()
          .describe('String extras passed alongside the broadcast.'),
        clear: z.boolean().optional().describe('Whether the notification dismisses on tap.'),
      })
      .describe('Send an Android broadcast intent on tap.'),
    z
      .object({
        action: z.literal('http').describe('Discriminator — `http`.'),
        label: z.string().describe('Button label.'),
        url: z.string().describe('URL the request goes to.'),
        method: z.string().optional().describe('HTTP method (defaults POST upstream).'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Headers attached to the request.'),
        body: z.string().optional().describe('Request body.'),
        clear: z
          .boolean()
          .optional()
          .describe('Whether the notification dismisses when the request succeeds.'),
      })
      .describe('Fire an HTTP request on tap.'),
    z
      .object({
        action: z.literal('copy').describe('Discriminator — `copy`.'),
        label: z.string().describe('Button label.'),
        value: z.string().describe('Value copied to the device clipboard on tap.'),
        clear: z.boolean().optional().describe('Whether the notification dismisses on tap.'),
      })
      .describe('Copy a value to the clipboard on tap.'),
  ])
  .describe(
    'Action button echoed by ntfy. Discriminated by `action` (`view`, `broadcast`, `http`, `copy`).',
  );

const AttachmentSchema = z
  .object({
    name: z.string().describe('Attachment display filename.'),
    url: z.string().describe('Attachment URL.'),
    type: z.string().optional().describe('Mime type — present only when ntfy hosted the upload.'),
    size: z.number().optional().describe('Attachment size in bytes.'),
    expires: z.number().optional().describe('Unix seconds when the hosted attachment ages out.'),
  })
  .describe('Attachment metadata; absent when the message had no attachment.');

const InputSchema = z.object({
  topic: z
    .string()
    .min(1)
    .regex(TOPIC_LIST_REGEX)
    .optional()
    .describe(
      'Single topic or comma-separated list (e.g., `alerts` or `alerts,backups,phil_alerts`). Required unless `NTFY_DEFAULT_TOPIC` is set.',
    ),
  since: z
    .string()
    .default('10m')
    .describe(
      "Default `10m`. Tighter than ntfy's default to keep the common 'did my recent notification land?' lookup cheap. Accepts a duration (`30s`, `10m`, `2h`, `1d`), a Unix timestamp, a message ID, or the keywords `all` (every cached message — up to ~12h on ntfy.sh) or `latest` (most recent only).",
    ),
  scheduled: z.boolean().default(false).describe('Include delayed/not-yet-delivered messages.'),
  priority: z
    .array(PrioritySchema.describe('Single priority value (1=min, 5=max).'))
    .optional()
    .describe('Match any priority in the list (logical OR). Empty/omitted matches all priorities.'),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Match all tags in the list (logical AND). Empty/omitted matches all messages regardless of tags.',
    ),
  id: z.string().optional().describe('Exact-match a single message ID.'),
  title: z.string().optional().describe('Exact-match against the title string.'),
  message: z.string().optional().describe('Exact-match against the message body.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(
      'Client-side cap on returned messages. Default 20, max 100. Sets the `truncated` enrichment flag when more remain.',
    ),
  base_url: z
    .string()
    .optional()
    .describe(
      'Override `NTFY_BASE_URL` for this call (absolute URL). When the override differs from the configured base URL, server-configured auth credentials are NOT forwarded.',
    ),
});

const MessageSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Message ID — pass back as `since` to paginate from this point or as `sequence_id` to manage.',
      ),
    time: z.string().describe('ISO 8601 timestamp when ntfy accepted the message.'),
    event: z
      .enum(['message', 'message_clear', 'message_delete', 'poll_request'])
      .describe('Event type.'),
    topic: z.string().describe('Topic the message was published to.'),
    expires: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp when the message ages out of cache.'),
    sequence_id: z
      .string()
      .optional()
      .describe(
        'Present on update/clear/delete events pointing back to the original message; absent on initial publishes.',
      ),
    title: z.string().optional().describe('Notification title; absent when no title was set.'),
    message: z
      .string()
      .optional()
      .describe(
        `Notification body. Truncated client-side to ~${MESSAGE_TRUNCATE_AT} chars; see \`messageTruncated\` for the count of dropped chars. Absent on clear/delete events.`,
      ),
    messageTruncated: z
      .number()
      .optional()
      .describe(
        'Count of additional characters dropped from `message`. Absent when the full body fit within the truncation cap.',
      ),
    priority: PrioritySchema.optional().describe('Notification priority; absent when default (3).'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Tags applied to the notification; absent when none.'),
    click: z.string().optional().describe('Click URL; absent when no click action was set.'),
    actions: z
      .array(ActionReadbackSchema)
      .optional()
      .describe(
        'Action buttons echoed by ntfy. Discriminated by `action`. Absent when no actions were set.',
      ),
    attachment: AttachmentSchema.optional(),
  })
  .describe('A single cached ntfy message envelope.');

const FilterEchoSchema = z
  .object({
    priority: z
      .array(PrioritySchema.describe('Single priority value (1=min, 5=max).'))
      .optional()
      .describe('Echo of the input priority filter; absent when not set.'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Echo of the input tag filter; absent when not set.'),
    id: z.string().optional().describe('Echo of the input id filter; absent when not set.'),
    title: z.string().optional().describe('Echo of the input title filter; absent when not set.'),
    message: z
      .string()
      .optional()
      .describe('Echo of the input message filter; absent when not set.'),
  })
  .describe('Echo of the active filter inputs the server applied.');

const OutputSchema = z.object({
  messages: z
    .array(MessageSchema)
    .describe(
      'Cached messages matching the filters, oldest-first (chronological order from ntfy).',
    ),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;
type FilterEcho = z.infer<typeof FilterEchoSchema>;

function priorityLabel(p?: Priority): string {
  switch (p) {
    case 1:
      return 'min';
    case 2:
      return 'low';
    case 4:
      return 'high';
    case 5:
      return 'max';
    default:
      return 'default';
  }
}

function filterSummary(f: FilterEcho | undefined): string {
  if (!f) return 'none';
  const parts: string[] = [];
  if (f.id) parts.push(`id=\`${f.id}\``);
  if (f.title) parts.push(`title=\`${f.title}\``);
  if (f.message) parts.push(`message=\`${f.message}\``);
  if (f.priority?.length) parts.push(`priority=[${f.priority.join(',')}]`);
  if (f.tags?.length) parts.push(`tags=[${f.tags.map((t) => `\`${t}\``).join(',')}]`);
  return parts.length ? parts.join(', ') : 'none';
}

export const ntfyFetchMessages = tool('ntfy_fetch_messages', {
  description:
    'Poll cached messages from one or more ntfy topics with optional filters. Returns a snapshot, not a live stream — use it to confirm delivery, replay missed alerts, or audit topic activity. Multiple topics are passed as a comma-separated list. Long bodies are truncated client-side to keep responses bounded; pass the message `id` back as `since` to fetch from that point.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  // Agent-facing success-path context — the resolved topic/since, the returned
  // count, the truncation flag, the active filters, and empty/truncated guidance.
  // Merged into structuredContent and mirrored into a content[] trailer.
  enrichment: {
    topic: z
      .string()
      .describe(
        'Echo of the resolved topic (or comma-separated list) — useful when `NTFY_DEFAULT_TOPIC` filled in for an omitted `topic`.',
      ),
    since: z.string().describe('Echo of the resolved `since` value (input or default `10m`).'),
    count: z.number().describe('Number of messages returned in this response.'),
    truncated: z
      .boolean()
      .describe(
        'True when more messages matched than `limit` and the tail was dropped — refetch with a tighter `since` or target a specific message by `id`.',
      ),
    appliedFilters: FilterEchoSchema.optional().describe(
      'Active filter inputs the server applied; absent when no filters were set.',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the result is empty or truncated — echoes the criteria and suggests how to broaden or paginate.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: { render: (f) => `**Filters:** ${filterSummary(f)}` },
  },

  errors: [
    {
      reason: 'forbidden_topic',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Auth required for the target topic.',
      recovery:
        'Try an unprotected topic instead; if this topic must stay protected, ask the operator to configure ntfy auth (`NTFY_AUTH_TOKEN`, or `NTFY_AUTH_USERNAME` + `NTFY_AUTH_PASSWORD`, or per-host entries in `NTFY_SERVERS`) before retrying.',
    },
    {
      reason: 'invalid_since',
      code: JsonRpcErrorCode.ValidationError,
      when: '`since` value could not be parsed by ntfy (bad duration, malformed timestamp, or unknown message ID).',
      recovery:
        'Use one of: `all`, `latest`, a duration like `10m` / `2h` / `1d`, a Unix timestamp (seconds), or a known message ID.',
    },
    {
      reason: 'upstream_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DNS, connection, or network failure reaching the ntfy server after retries were exhausted.',
      retryable: true,
      recovery:
        'Verify the configured `NTFY_BASE_URL` (or per-call `base_url`) resolves and is reachable; check network connectivity, then retry.',
    },
  ],

  async handler(input: Input, ctx): Promise<Output> {
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

    let raw: NtfyMessage[];
    try {
      raw = await getNtfyService().fetch(
        {
          topic,
          since: input.since,
          scheduled: input.scheduled,
          priority: input.priority,
          tags: input.tags,
          id: input.id,
          title: input.title,
          message: input.message,
        },
        { baseUrl: overrideBase, signal: ctx.signal },
      );
    } catch (err) {
      const code = getCode(err);
      const msg = getMessage(err);
      if (isAuthCode(code)) {
        throw ctx.fail('forbidden_topic', msg || `Forbidden for topic ${topic}`, {
          ...ctx.recoveryFor('forbidden_topic'),
        });
      }
      if (isInvalidParamsCode(code)) {
        throw ctx.fail('invalid_since', msg || `Could not parse since=${input.since}`, {
          ...ctx.recoveryFor('invalid_since'),
        });
      }
      if (isUpstreamUnreachable(err)) {
        throw ctx.fail('upstream_unreachable', msg || 'ntfy server is unreachable.', {
          ...ctx.recoveryFor('upstream_unreachable'),
        });
      }
      throw err;
    }

    // Filter out connection-level frames; keep only notification events.
    const notifications = raw.filter((m) => m.event !== 'open' && m.event !== 'keepalive');
    const truncated = notifications.length > input.limit;
    const slice = truncated ? notifications.slice(0, input.limit) : notifications;

    ctx.log.info('Fetched ntfy messages', {
      requested: input.limit,
      returned: slice.length,
      truncated,
    });

    ctx.enrich({ topic, since: input.since, count: slice.length, truncated });

    const activeFilters: FilterEcho = {
      priority: input.priority,
      tags: input.tags,
      id: input.id,
      title: input.title,
      message: input.message,
    };
    const hasFilters =
      Boolean(input.id || input.title || input.message) ||
      Boolean(input.priority?.length) ||
      Boolean(input.tags?.length);
    if (hasFilters) ctx.enrich({ appliedFilters: activeFilters });

    if (slice.length === 0) {
      ctx.enrich.notice(
        `No messages on topic \`${topic}\` (since \`${input.since}\`)${
          hasFilters ? ` with filters ${filterSummary(activeFilters)}` : ''
        }. Try a wider \`since\` window${hasFilters ? ', drop filters,' : ''} or verify the topic name.`,
      );
    } else if (truncated) {
      ctx.enrich.notice(
        'More messages matched than the limit allowed; refetch with a tighter `since` window or pass a message `id` to target a specific one.',
      );
    }

    return { messages: slice.map(shapeNtfyMessage) };
  },

  format(result) {
    if (result.messages.length === 0) {
      return [{ type: 'text', text: 'No messages matched the query.' }];
    }

    const blocks = result.messages.map((m) => {
      const lines: string[] = [
        `### \`${m.id}\` — \`${m.event}\` on \`${m.topic}\``,
        `Time: ${m.time}`,
      ];
      if (m.expires) lines.push(`Cache expires: ${m.expires}`);
      if (m.sequence_id) lines.push(`References sequence: \`${m.sequence_id}\``);
      if (m.title) lines.push(`Title: ${m.title}`);
      if (m.priority !== undefined) {
        lines.push(`Priority: ${m.priority} (${priorityLabel(m.priority)})`);
      }
      if (m.tags?.length) {
        lines.push(`Tags: ${m.tags.map((t) => `\`${t}\``).join(' · ')}`);
      }
      if (m.click) {
        lines.push(`Click action: [${m.click}](${m.click})`);
      }
      if (m.attachment) {
        const a = m.attachment;
        const meta: string[] = [];
        if (a.type) meta.push(`type: ${a.type}`);
        if (a.size !== undefined) meta.push(`size: ${a.size} bytes`);
        if (a.expires !== undefined) meta.push(`expires: ${a.expires}`);
        const suffix = meta.length ? ` (${meta.join(', ')})` : '';
        lines.push(`Attachment: [${a.name}](${a.url})${suffix}`);
      }
      if (m.actions?.length) {
        lines.push('Actions:');
        for (const a of m.actions) {
          lines.push(`- \`\`\`json\n${JSON.stringify(a)}\n\`\`\``);
        }
      }
      if (m.message !== undefined) {
        lines.push('', m.message);
        if (m.messageTruncated !== undefined) {
          lines.push(`_(${m.messageTruncated} chars more)_`);
        }
      }
      return lines.join('\n');
    });

    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
