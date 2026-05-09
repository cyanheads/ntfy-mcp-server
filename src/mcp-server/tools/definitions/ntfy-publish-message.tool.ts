/**
 * @fileoverview `ntfy_publish_message` — sends or updates a push notification
 * on an ntfy topic. Single tool covering all 18 publish parameters; updates
 * ride this tool by setting `sequence_id`.
 * @module mcp-server/tools/definitions/ntfy-publish-message.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';

import { getServerConfig } from '@/config/server-config.js';
import {
  classifyInvalidParams,
  getCode,
  getMessage,
  isAuthCode,
  isInvalidParamsCode,
  isRateLimitedCode,
} from '@/services/ntfy/error-classifier.js';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';
import type {
  NtfyAction,
  NtfyPublishRequest,
  NtfyPublishResponse,
  Priority,
} from '@/services/ntfy/types.js';

const TOPIC_REGEX = /^[a-zA-Z0-9_-]+$/;
const SEQUENCE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

const TopicSchema = z.string().min(1).max(64).regex(TOPIC_REGEX);

const ViewActionSchema = z
  .object({
    action: z.literal('view').describe('Discriminator — must be `view`.'),
    label: z.string().min(1).max(64).describe('Button label shown in the notification.'),
    url: z
      .string()
      .min(1)
      .describe(
        'URL opened on tap — http(s) opens the browser; mailto:, geo:, ntfy://, twitter:// open registered apps.',
      ),
    clear: z.boolean().optional().describe('Dismiss the notification after the button is tapped.'),
  })
  .describe('Open a URL or app when the button is tapped.');

const BroadcastActionSchema = z
  .object({
    action: z.literal('broadcast').describe('Discriminator — must be `broadcast`.'),
    label: z.string().min(1).max(64).describe('Button label shown in the notification.'),
    intent: z
      .string()
      .optional()
      .describe('Android intent name (defaults server-side to `io.heckel.ntfy.USER_ACTION`).'),
    extras: z
      .record(z.string(), z.string())
      .optional()
      .describe('String extras passed alongside the broadcast.'),
    clear: z.boolean().optional().describe('Dismiss the notification after the button is tapped.'),
  })
  .describe('Send an Android broadcast intent (Tasker/MacroDroid integrations).');

const HttpActionSchema = z
  .object({
    action: z.literal('http').describe('Discriminator — must be `http`.'),
    label: z.string().min(1).max(64).describe('Button label shown in the notification.'),
    url: z.url().describe('URL the HTTP request is sent to.'),
    method: z.string().optional().describe('HTTP method — defaults to POST when omitted.'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Headers attached to the HTTP request.'),
    body: z.string().optional().describe('Request body.'),
    clear: z
      .boolean()
      .optional()
      .describe('Dismiss the notification only when the request succeeds.'),
  })
  .describe('Fire an HTTP request (default POST) when the button is tapped.');

const CopyActionSchema = z
  .object({
    action: z.literal('copy').describe('Discriminator — must be `copy`.'),
    label: z.string().min(1).max(64).describe('Button label shown in the notification.'),
    value: z.string().min(1).describe('Text copied to the device clipboard on tap.'),
    clear: z.boolean().optional().describe('Dismiss the notification after the button is tapped.'),
  })
  .describe('Copy a value to the clipboard when the button is tapped.');

const ActionSchema = z
  .discriminatedUnion('action', [
    ViewActionSchema,
    BroadcastActionSchema,
    HttpActionSchema,
    CopyActionSchema,
  ])
  .describe(
    'A single action button. Discriminated by `action` — `view`, `broadcast`, `http`, or `copy`.',
  );

const PrioritySchema = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
  .describe(
    'Notification priority — 1=min, 2=low, 3=default, 4=high, 5=max/urgent. Server defaults to 3 when omitted.',
  );

const AttachmentSchema = z
  .object({
    name: z.string().describe('Attachment display filename.'),
    url: z.string().describe('Attachment URL.'),
    type: z.string().optional().describe('Mime type — present only when ntfy hosted the upload.'),
    size: z
      .number()
      .optional()
      .describe('Attachment size in bytes — present only when ntfy hosted the upload.'),
    expires: z
      .number()
      .optional()
      .describe(
        'Unix seconds when the hosted attachment ages out — absent for externally-hosted attachments.',
      ),
  })
  .describe('Attachment metadata echoed by the server when present on the publish.');

const InputSchema = z.object({
  topic: TopicSchema.optional().describe(
    'Target topic. Required unless `NTFY_DEFAULT_TOPIC` is configured. Treat the topic name as a secret — anyone who knows it can publish or subscribe.',
  ),
  message: z
    .string()
    .max(4096)
    .optional()
    .describe(
      'Notification body, ≤4096 bytes. Empty/missing is replaced server-side with the literal `triggered`; pass real content even for ping-style alerts.',
    ),
  title: z
    .string()
    .optional()
    .describe('Notification title. Defaults to the topic URL on the recipient device.'),
  priority: PrioritySchema.optional(),
  tags: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe(
      'Up to 10 tags. Strings matching ntfy emoji short codes render as emojis prepended to the title; others render as a tag list. Use `ntfy_search_emoji_tags` to discover short codes.',
    ),
  click: z
    .string()
    .min(1)
    .optional()
    .describe('URL opened when the notification is tapped — http(s), mailto:, geo:, ntfy://, etc.'),
  attach: z
    .url()
    .optional()
    .describe(
      'External URL to attach. ntfy fetches it on the recipient device — host the file somewhere reachable first; no local file uploads.',
    ),
  icon: z
    .url()
    .optional()
    .describe('JPEG/PNG icon URL shown next to the message body. Cached for 24h.'),
  filename: z
    .string()
    .optional()
    .describe("Overrides the attachment's display filename in the client."),
  markdown: z
    .boolean()
    .optional()
    .describe('Render the message body as Markdown (web app only; mobile renders plain text).'),
  actions: z
    .array(ActionSchema)
    .max(3)
    .optional()
    .describe(
      'Up to 3 action buttons. Discriminated by `action` (`view`, `broadcast`, `http`, `copy`).',
    ),
  delay: z
    .string()
    .optional()
    .describe(
      'Schedule delivery for later. Accepts a duration (`30m`, `2h`, `1d`), a Unix timestamp, or natural-language time (`tomorrow, 10am`, `Tuesday, 7am`). Server-enforced 10s minimum, 3-day maximum.',
    ),
  email: z
    .string()
    .optional()
    .describe(
      "Forward to email — an address (`phil@example.com`) or `'yes'` to use the authenticated user's first verified address.",
    ),
  call: z
    .string()
    .optional()
    .describe(
      "Trigger a voice call — `+CCNNNNNNNNNN` or `'yes'` for the authenticated user's first verified number. Requires an authenticated ntfy account; ntfy.sh limits this to Pro plans.",
    ),
  sequence_id: z
    .string()
    .regex(SEQUENCE_ID_REGEX)
    .optional()
    .describe(
      'Update or replace a previously-published message instead of creating a new one. Same identifier used by `ntfy_manage_message`. 1–64 chars, `[a-zA-Z0-9_-]`.',
    ),
  cache: z
    .boolean()
    .optional()
    .describe(
      'Set false to skip server-side caching. Live subscribers still receive the message but `ntfy_fetch_messages` will not see it. Sent as `X-Cache: no`.',
    ),
  firebase: z
    .boolean()
    .optional()
    .describe(
      'Set false to skip Firebase Cloud Messaging. Delays Android delivery up to 15 min unless the recipient enabled instant delivery. Sent as `X-Firebase: no`.',
    ),
  base_url: z
    .url()
    .optional()
    .describe(
      'Override the configured `NTFY_BASE_URL` for this call. When the override differs from the configured base URL, server-configured auth credentials are NOT forwarded — protect tokens by running a separate server instance for protected topics on alternate hosts.',
    ),
});

const OutputSchema = z.object({
  id: z
    .string()
    .describe('Server-assigned message ID — pass back as `sequence_id` to update later.'),
  time: z.number().describe('Unix seconds when ntfy accepted the message (not delivery time).'),
  topic: z.string().describe('Topic the message was published to.'),
  url: z
    .string()
    .describe(
      'Browser URL `<baseUrl>/<topic>`. Synthesized by the tool — ntfy does not return it.',
    ),
  expires: z
    .number()
    .optional()
    .describe(
      'Unix seconds when the message ages out of server cache. Absent when published with `cache: false`.',
    ),
  sequence_id: z
    .string()
    .optional()
    .describe(
      'Present only when this call updated an earlier message and the input `sequence_id` differed from the new id.',
    ),
  scheduled: z
    .boolean()
    .optional()
    .describe('True when `delay` was set and the message is queued for later delivery.'),
  title: z.string().optional().describe('Echo of the input title; absent when not set.'),
  message: z
    .string()
    .optional()
    .describe('Echo of the input message; `triggered` when the input body was empty.'),
  priority: PrioritySchema.optional().describe(
    'Echo of the input priority; absent when default (3).',
  ),
  tags: z
    .array(z.string())
    .optional()
    .describe('Echo of the input tags; absent when none were set.'),
  click: z.string().optional().describe('Echo of the input click URL; absent when not set.'),
  attachment: AttachmentSchema.optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

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

export const ntfyPublishMessage = tool('ntfy_publish_message', {
  description:
    'Send or update a push notification on an ntfy topic. Topics are created on first publish — agents should treat the topic name as a secret because anyone who knows it can publish or subscribe. Set `sequence_id` to update a previously-published message; otherwise the call creates a new one. Use `ntfy_search_emoji_tags` to look up emoji short codes for `tags`.',
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  errors: [
    {
      reason: 'forbidden_topic',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Auth required for the target topic.',
      recovery:
        'Try a public topic instead; if this topic must stay protected, ask the operator to provision ntfy auth credentials for the server before retrying.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream returned 429 after retries were exhausted.',
      retryable: true,
      recovery:
        "Wait the rate-limit window (typically minutes on ntfy.sh's free tier) before retrying, or reduce publish frequency.",
    },
    {
      reason: 'payload_too_large',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Message body or attachment exceeds server limits.',
      recovery:
        'Shorten the message (≤4096 bytes plain) or host the long content as an external URL via `attach`.',
    },
    {
      reason: 'unverified_contact',
      code: JsonRpcErrorCode.InvalidParams,
      when: '`email`/`call` set but the authenticated user has no verified address/number, or auth is missing.',
      recovery:
        'Drop the `email`/`call` field and resend; if forwarding is essential, ask the operator to verify the address or number in the ntfy account settings.',
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

    const requestBody: NtfyPublishRequest = {
      topic,
      message: input.message,
      title: input.title,
      priority: input.priority,
      tags: input.tags?.length ? input.tags : undefined,
      click: input.click,
      attach: input.attach,
      icon: input.icon,
      filename: input.filename,
      markdown: input.markdown,
      actions: input.actions?.length ? (input.actions as NtfyAction[]) : undefined,
      delay: input.delay,
      email: input.email,
      call: input.call,
      sequence_id: input.sequence_id,
      cache: input.cache,
      firebase: input.firebase,
    };

    let response: NtfyPublishResponse;
    try {
      response = await getNtfyService().publish(requestBody, {
        baseUrl: input.base_url,
        signal: ctx.signal,
      });
    } catch (err) {
      throw classifyPublishError(err, ctx, topic);
    }

    ctx.log.info('Published ntfy message', {
      messageId: response.id,
      scheduled: response.scheduled === true,
    });

    const baseUrl = (input.base_url ?? cfg.baseUrl).replace(/\/+$/, '');
    return {
      id: response.id,
      time: response.time,
      topic: response.topic,
      url: `${baseUrl}/${response.topic}`,
      expires: response.expires,
      sequence_id: response.sequence_id,
      scheduled: response.scheduled,
      title: response.title,
      message: response.message,
      priority: response.priority,
      tags: response.tags,
      click: response.click,
      attachment: response.attachment,
    };
  },

  format(result) {
    const lines: string[] = [];
    const banner = result.scheduled
      ? `**Scheduled** — ntfy queued message \`${result.id}\` on \`${result.topic}\``
      : `**Sent** — ntfy accepted message \`${result.id}\` on \`${result.topic}\``;
    lines.push(banner);
    lines.push(`URL: ${result.url}`);
    lines.push(`Time: ${result.time} (Unix seconds)`);
    if (result.expires !== undefined) {
      lines.push(`Cache expires: ${result.expires} (Unix seconds)`);
    }
    if (result.sequence_id) {
      lines.push(`Sequence ID: \`${result.sequence_id}\` (this call replaced an earlier message)`);
    }
    if (result.title) lines.push(`Title: ${result.title}`);
    if (result.priority !== undefined) {
      lines.push(`Priority: ${result.priority} (${priorityLabel(result.priority)})`);
    }
    if (result.tags?.length) {
      lines.push(`Tags: ${result.tags.map((t) => `\`${t}\``).join(' · ')}`);
    }
    if (result.message) lines.push('', result.message);
    if (result.click) lines.push('', `Click action: [${result.click}](${result.click})`);
    if (result.attachment) {
      const a = result.attachment;
      const meta: string[] = [];
      if (a.type) meta.push(`type: ${a.type}`);
      if (a.size !== undefined) meta.push(`size: ${a.size} bytes`);
      if (a.expires !== undefined) meta.push(`expires: ${a.expires}`);
      const suffix = meta.length ? ` (${meta.join(', ')})` : '';
      lines.push('', `Attachment: [${a.name}](${a.url})${suffix}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Translate a thrown error from `NtfyService.publish` into a typed contract
 * failure when the message/code matches a documented mode. Anything else
 * bubbles unchanged so the framework auto-classifier picks the right code.
 */
function classifyPublishError(
  err: unknown,
  ctx: Parameters<typeof ntfyPublishMessage.handler>[1],
  topic: string,
): unknown {
  const code = getCode(err);
  const message = getMessage(err);

  if (isAuthCode(code)) {
    return ctx.fail('forbidden_topic', message || `Forbidden for topic ${topic}`, {
      ...ctx.recoveryFor('forbidden_topic'),
    });
  }
  if (isRateLimitedCode(code)) {
    return ctx.fail('rate_limited', message || 'ntfy returned 429 after retries.', {
      ...ctx.recoveryFor('rate_limited'),
    });
  }
  if (isInvalidParamsCode(code)) {
    const sub = classifyInvalidParams(message);
    if (sub === 'payload_too_large') {
      return ctx.fail('payload_too_large', message, {
        ...ctx.recoveryFor('payload_too_large'),
      });
    }
    if (sub === 'unverified_contact') {
      return ctx.fail('unverified_contact', message, {
        ...ctx.recoveryFor('unverified_contact'),
      });
    }
  }
  return err;
}
