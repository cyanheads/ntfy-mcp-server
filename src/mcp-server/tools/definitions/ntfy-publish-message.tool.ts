/**
 * @fileoverview `ntfy_publish_message` — sends or updates a push notification
 * on an ntfy topic. Single tool covering all 19 publish parameters; updates
 * ride this tool by setting `sequence_id`. Publishes whose side effects leave
 * the notification drawer (`email`, `call`, `broadcast` / `http` buttons) pass
 * through a user-confirmation gate: the first such call returns an input
 * request, and the publish only fires on the retried call whose approval
 * redeems the consent record that request stored for this exact publish.
 * A publish reports the rate limits ntfy's reply carried as the `quota`
 * enrichment. `format()` renders every value ntfy echoes as a code span or fence, so it
 * reads as literal text; a body ntfy accepted as `text/markdown` is flagged
 * `markdown: true` and fenced as `markdown`. Failure messages quote a value in
 * double quotes as plain text, since the framework escapes Markdown in them,
 * and never name the topic, since the framework logs every thrown message.
 * @module mcp-server/tools/definitions/ntfy-publish-message.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';

import { getServerConfig, isEmojiTagsEnabled } from '@/config/server-config.js';
import { confirmAction } from '@/mcp-server/tools/utils/confirm-action.js';
import {
  literal,
  literalBlock,
  promptLiteral,
  promptTarget,
} from '@/mcp-server/tools/utils/markdown-literal.js';
import { quotaEnrichment, renderQuota } from '@/mcp-server/tools/utils/quota-enrichment.js';
import {
  BASE_URL_HINT,
  BASE_URL_PATTERN,
  normalizeBaseOverride,
} from '@/services/ntfy/base-url-guard.js';
import {
  classifyInvalidParams,
  getCode,
  getDataStatus,
  getMessage,
  isAnonymousSenderRejection,
  isAuthRejection,
  isFileStoreFailure,
  isInvalidParamsCode,
  isRateLimitedCode,
  isUpstreamMalformed,
  isUpstreamUnreachable,
  oversizedPublishField,
  rateLimitedData,
  unreachableWaitData,
} from '@/services/ntfy/error-classifier.js';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';
import type {
  NtfyAction,
  NtfyPublishRequest,
  NtfyPublishResponse,
  NtfyReply,
  Priority,
} from '@/services/ntfy/types.js';

const TOPIC_REGEX = /^[a-zA-Z0-9_-]+$/;
const SEQUENCE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
/** ntfy's message-body ceiling. Counted in bytes upstream, not characters. */
const MESSAGE_MAX_BYTES = 4096;
/** The pointers at `ntfy_search_emoji_tags` are dropped when that tool is disabled. */
const EMOJI_TAGS_ENABLED = isEmojiTagsEnabled();

const TopicSchema = z.string().min(1).max(64).regex(TOPIC_REGEX);

const ViewActionSchema = z
  .object({
    action: z.literal('view').describe('Discriminator — must be `view`.'),
    label: z.string().min(1).describe('Button label shown in the notification.'),
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
    label: z.string().min(1).describe('Button label shown in the notification.'),
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
    label: z.string().min(1).describe('Button label shown in the notification.'),
    url: z.string().describe('Absolute URL the HTTP request is sent to.'),
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
    label: z.string().min(1).describe('Button label shown in the notification.'),
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

const PRIORITY_ERROR = 'Priority must be a whole number from 1 (min) to 5 (max/urgent).';
/**
 * One constrained JSON-Schema node (`{ type: 'integer', minimum: 1, maximum: 5 }`)
 * rather than a five-branch `anyOf` of consts, so a bad value fails with the
 * single message above instead of an `invalid_union` dump naming every branch.
 * The 1–5 domain is enforced here; `Priority` narrows it back at the service
 * boundary.
 */
const PrioritySchema = z
  .int({ error: PRIORITY_ERROR })
  .min(1, PRIORITY_ERROR)
  .max(5, PRIORITY_ERROR)
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
    .max(MESSAGE_MAX_BYTES)
    .refine((v) => Buffer.byteLength(v, 'utf8') <= MESSAGE_MAX_BYTES, {
      message: `Message exceeds ntfy's ${MESSAGE_MAX_BYTES}-byte limit; non-ASCII characters cost 2–4 bytes each, so the byte count can exceed the character count.`,
    })
    .optional()
    .describe(
      `Notification body, ≤${MESSAGE_MAX_BYTES} bytes (not characters — accented letters, CJK, and emoji cost 2–4 bytes each). Empty/missing is replaced server-side with the literal \`triggered\`; pass real content even for ping-style alerts.`,
    ),
  title: z
    .string()
    .optional()
    .describe('Notification title. Defaults to the topic URL on the recipient device.'),
  priority: PrioritySchema.optional(),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      `Strings matching ntfy emoji short codes render as emojis prepended to the title; others render as a tag list. ntfy accepts 512 bytes of tags in total, counted after it splits each tag at commas and trims the spaces around it, so a comma inside a tag splits it in two.${EMOJI_TAGS_ENABLED ? ' Use `ntfy_search_emoji_tags` to discover short codes.' : ''}`,
    ),
  click: z
    .string()
    .optional()
    .describe('URL opened when the notification is tapped — http(s), mailto:, geo:, ntfy://, etc.'),
  attach: z
    .string()
    .optional()
    .describe(
      'External attachment URL (absolute). ntfy fetches it on the recipient device — host the file somewhere reachable first; no local file uploads.',
    ),
  icon: z
    .string()
    .optional()
    .describe('Absolute JPEG/PNG icon URL shown next to the message body. Cached for 24h.'),
  filename: z
    .string()
    .optional()
    .describe(
      'Display filename of the attachment in the client; with `attach`, it replaces the name ntfy takes from the URL. Without `attach`, ntfy stores the message body itself as a file with this name — a form ntfy v2.20.0 and later fail (`invalid_attachment`).',
    ),
  markdown: z
    .boolean()
    .optional()
    .describe(
      'Render the message body as Markdown (supported by the web app and the Android app).',
    ),
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
      "Schedule delivery for later. Accepts a duration (`30m`, `2h`, `1d`), a Unix timestamp, an RFC 3339 time with its `Z` or `±hh:mm` offset (`2026-11-15T10:00:00Z`), or natural-language time (`tomorrow, 10am`, `Tuesday, 7am`), which ntfy reads in `timezone` when set and otherwise in the ntfy server's own timezone (UTC on ntfy.sh). A date-time without the offset is not read as RFC 3339. 10s minimum; maximum 3 days by default (configurable per ntfy server).",
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      'IANA zone name (`America/New_York`, `Asia/Tokyo`, `UTC`) that ntfy reads a natural-language `delay` in, spelled as the tz database spells it — ntfy matches case-sensitively and rejects an unknown name (`invalid_timezone`). Durations, Unix timestamps, and RFC 3339 times keep their instant, and without `delay` ntfy ignores it. Sent as given; blank is treated as unset.',
    ),
  email: z
    .string()
    .optional()
    .describe(
      "Forward to email — an address (`phil@example.com`) or `'yes'` to use the authenticated user's primary verified address (the first verified one when none is marked primary).",
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
    .string()
    .regex(BASE_URL_PATTERN, BASE_URL_HINT)
    .optional()
    .describe(
      'Override the configured `NTFY_BASE_URL` for this call — an absolute `http(s)://` URL. Server-configured auth credentials are forwarded only when the override matches a registered server (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry); otherwise the request goes out unauthenticated.',
    ),
});

const OutputSchema = z.object({
  id: z
    .string()
    .describe(
      "Server-assigned ID of this message. When the call set no `sequence_id`, pass this `id` as `sequence_id` to update, clear, or delete the notification later. When it set one (an update, or a sequence id chosen on the first publish), that value comes back as `sequence_id` and stays the one to pass; this message's own `id` would start a separate notification.",
    ),
  time: z
    .string()
    .describe(
      'ISO 8601 timestamp. For an immediate publish this is when ntfy accepted the message; when `delay` was set (`scheduled: true`) ntfy reports the scheduled delivery time instead, which is in the future.',
    ),
  topic: z.string().describe('Topic the message was published to.'),
  url: z
    .string()
    .describe(
      'Browser URL `<baseUrl>/<topic>`. Synthesized by the tool — ntfy does not return it.',
    ),
  expires: z
    .string()
    .optional()
    .describe(
      'ISO 8601 timestamp when the message ages out of server cache. Absent when published with `cache: false`.',
    ),
  sequence_id: z
    .string()
    .optional()
    .describe('Echo of the input `sequence_id`; absent when no `sequence_id` was supplied.'),
  scheduled: z
    .boolean()
    .optional()
    .describe('True when `delay` was set and the message is queued for later delivery.'),
  title: z.string().optional().describe('Echo of the input title; absent when not set.'),
  message: z
    .string()
    .optional()
    .describe('Echo of the input message; `triggered` when the input body was empty.'),
  markdown: z
    .boolean()
    .optional()
    .describe('True when ntfy accepted the body as Markdown; absent for plain text.'),
  priority: PrioritySchema.optional().describe(
    'Echo of the input priority; absent when none was set, which ntfy delivers at the default (3). An explicit 3 is echoed as 3.',
  ),
  tags: z
    .array(z.string())
    .optional()
    .describe('Echo of the input tags; absent when none were set.'),
  click: z.string().optional().describe('Echo of the input click URL; absent when not set.'),
  icon: z
    .string()
    .optional()
    .describe('Echo of the input icon URL, exactly as ntfy returned it; absent when not set.'),
  attachment: AttachmentSchema.optional(),
  actions: z
    .array(ActionSchema)
    .optional()
    .describe(
      'Echo of the input action buttons. Discriminated by `action`. Absent when none were set.',
    ),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function priorityLabel(p?: number): string {
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

/**
 * `value`, or `undefined` when it is blank (empty or whitespace-only) — what a
 * form client sends for a field it left untouched. `NtfyService.publish` reads
 * `filename` and `attach` by presence to tell a publish ntfy stores as a file,
 * so neither goes out blank; a blank `timezone` or `delay` stays unsent the
 * same way, and ntfy delivers a publish without `delay` at once. ntfy reads a
 * blank `click` or tag as unset, except a whitespace-only tag between others,
 * which it stores as an empty tag; neither goes out, so what is sent is what
 * ntfy stores.
 */
function present(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/** How many header names or broadcast extras a prompt line lists before counting the rest. */
const PROMPT_LIST_MAX = 10;

/** The first `PROMPT_LIST_MAX` of `items`, each through `render`, then a count of the rest. */
function promptList<T>(items: readonly T[], render: (item: T) => string): string {
  const shown = items.slice(0, PROMPT_LIST_MAX).map(render).join(', ');
  const rest = items.length - PROMPT_LIST_MAX;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

/**
 * Describe the parts of a publish that escape the notification drawer, one
 * phrase per prompt line: an email forward, a voice call, or a button that
 * sends an Android broadcast or fires an HTTP request from the recipient's
 * device. Each names what it will do, so the confirmation prompt is specific
 * rather than a generic "proceed?": a button's label, and for `http` its
 * method, URL, body, and header names — never header values, which can hold
 * credentials — and for `broadcast` its intent and extras. Every
 * caller-supplied value renders as one code span with its invisible characters
 * escaped, so `[safe](https://evil)` reads as the string it is, never as a
 * link, and no value can add a line or reorder the text around it. A
 * destination — the email address, the call's number, a broadcast's intent, an
 * `http` button's URL — is shown whole through `promptTarget()`, so the host a
 * request reaches is always in the prompt; every other value is an excerpt
 * through `promptLiteral()`. A plain notification — or a `view` / `copy`
 * button, which does nothing until the recipient taps it — returns an empty
 * list and never prompts.
 */
function outOfBandSideEffects(input: Input): string[] {
  const effects: string[] = [];
  if (input.email) effects.push(`an email forward to ${promptTarget(input.email)}`);
  if (input.call) effects.push(`a voice call to ${promptTarget(input.call)}`);
  for (const action of input.actions ?? []) {
    if (action.action === 'broadcast') {
      const intent = action.intent ? `intent ${promptTarget(action.intent)}` : 'the default intent';
      const parts = [`an Android broadcast button ${promptLiteral(action.label)} with ${intent}`];
      const extras = Object.entries(action.extras ?? {});
      if (extras.length > 0) {
        parts.push(
          `extras ${promptList(extras, ([key, value]) => `${promptLiteral(key)} = ${promptLiteral(value)}`)}`,
        );
      }
      effects.push(parts.join(', '));
    }
    if (action.action === 'http') {
      // ntfy stores a blank method as none, which the app sends as POST.
      const method = promptLiteral(action.method || 'POST');
      const parts = [
        `an HTTP ${method} button ${promptLiteral(action.label)} targeting ${promptTarget(action.url)}`,
      ];
      if (action.body) parts.push(`body ${promptLiteral(action.body)}`);
      const headers = Object.keys(action.headers ?? {});
      if (headers.length > 0) parts.push(`headers ${promptList(headers, promptLiteral)}`);
      effects.push(parts.join(', '));
    }
  }
  return effects;
}

export const ntfyPublishMessage = tool('ntfy_publish_message', {
  description: `Send or update a push notification on an ntfy topic. Topics are created on first publish — treat the topic name as a secret because anyone who knows it can publish or subscribe. Set \`sequence_id\` to update a previously-published message; otherwise the call creates a new one.${EMOJI_TAGS_ENABLED ? ' Use `ntfy_search_emoji_tags` to look up emoji short codes for `tags`.' : ''} A publish carrying \`email\`, \`call\`, or a \`broadcast\`/\`http\` action button reaches beyond the notification drawer, so that call always asks the user to confirm the specific target first and comes back requesting that input rather than a result; reissue the same call with the answer attached to send it. Declining fails the call with \`consent_declined\`. A plain notification publishes on the first call.`,
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,
  enrichment: { quota: quotaEnrichment },
  enrichmentTrailer: { quota: { render: renderQuota } },

  /**
   * Every reason after `consent_declined` is raised by `classifyPublishError`,
   * or by `NtfyService` and passed through it (`upstream_malformed`,
   * `not_ntfy_endpoint`), outside the handler body the contract lint scans —
   * hence `thrownBy: 'service'`.
   */
  errors: [
    {
      reason: 'consent_declined',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The publish carried an out-of-band side effect (`email`, `call`, or a `broadcast`/`http` action button), the user was asked to confirm it, and declined, cancelled, or answered with a payload that did not parse.',
      severity: 'notice',
      recovery:
        'Confirm with the user which recipient or action they intended, or drop `email` / `call` / the action button and publish as a plain notification.',
    },
    {
      reason: 'forbidden_topic',
      code: JsonRpcErrorCode.Forbidden,
      when: 'ntfy refused access to the topic with its own 401 or 403 error: the topic needs credentials this server did not send, or the ones it sent lack access.',
      recovery:
        'Try a public topic instead; if this topic must stay protected, ask the operator to configure ntfy auth (`NTFY_AUTH_TOKEN`, or `NTFY_AUTH_USERNAME` + `NTFY_AUTH_PASSWORD`, or per-host entries in `NTFY_SERVERS`) before retrying.',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream returned 429 after retries were exhausted.',
      retryable: true,
      recovery:
        'Wait the rate-limit window before retrying, or reduce publish frequency — `retryAfter` seconds when the error carries it. A request-rate limit (`too many requests`) clears within minutes; a daily quota (`daily … reached`) resets within 24 hours.',
      thrownBy: 'service',
    },
    {
      reason: 'payload_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: "Upstream returned 413, or rejected a field as too large — the message body or attachment exceeds server limits (an attachment also fails once the client's attachment storage or daily bandwidth quota is used up), or the `title`, the combined `tags`, or the request as a whole is larger than ntfy accepts.",
      recovery:
        'Shorten the field ntfy rejected: the message (≤4096 bytes plain, or host the long content as an external URL via `attach`), the `title`, or the `tags` (ntfy limits their combined length); when ntfy refused the request as a whole, shorten the longest field in it. When ntfy refused an attachment, drop `filename` or host the file and pass its URL as `attach`; a used-up bandwidth quota resets within 24 hours.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_delay',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ntfy rejected `delay`: it could not parse the value, or the time it names is less than 10 seconds out or past the server maximum.',
      recovery:
        'Resend with `delay` as a duration (`30m`, `2h`, `1d`), a Unix timestamp, an RFC 3339 time with its `Z` or `±hh:mm` offset (`2026-11-15T10:00:00Z`), or a natural-language time (`tomorrow, 10am`), at least 10 seconds out and within the server maximum (3 days on ntfy.sh).',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_timezone',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ntfy rejected `timezone` as a zone name it does not know, which it checks only on a publish that also sets a delay',
      recovery:
        "Pass `timezone` as an IANA zone name spelled as the tz database spells it (`America/New_York`, `Asia/Tokyo`, `UTC`; ntfy matches case-sensitively), or drop it to read `delay` in the ntfy server's own timezone.",
      thrownBy: 'service',
    },
    {
      reason: 'invalid_attachment',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ntfy rejected the `attach` URL as malformed, or answered HTTP 500 to a publish carrying `filename` without `attach`, whose body ntfy v2.20.0 and later fail to store as a file',
      recovery:
        "Pass `attach` an absolute URL (`https://host/path/file.jpg`) to an already-hosted file — the recipient device fetches it, so a local path will not work, and shortening the message will not help. When `filename` was set without `attach`, pass the hosted file's URL as `attach` alongside it, or drop `filename` to send the text as a plain message.",
      thrownBy: 'service',
    },
    {
      reason: 'unverified_contact',
      code: JsonRpcErrorCode.ValidationError,
      when: '`email`/`call` set but the authenticated user has no verified address/number, or auth is missing.',
      recovery:
        'Drop the `email`/`call` field and resend; if forwarding is essential, ask the operator to verify the address or number in the ntfy account settings.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A DNS, connection, or network failure or a 5xx answer that outlasted the retries, no complete answer within the call deadline, or a 5xx whose `Retry-After` is longer than the call can wait.',
      retryable: true,
      recovery:
        'When the error carries `retryAfter`, the ntfy server is answering and asked for that wait: resend the publish once it has passed. Otherwise verify the configured `NTFY_BASE_URL` (or per-call `base_url`) resolves and is reachable; check network connectivity, then retry.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_malformed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The server answered the publish with a 2xx success but a reply that is not an ntfy message (an empty body, an HTML page, JSON without ntfy's message fields) or that could not be read in full (the connection reset, or a timeout or the call deadline cut it off). Not retried, since the notification may already be out.",
      retryable: false,
      recovery:
        'The notification may already have been delivered — call `ntfy_fetch_messages` on the topic before resending, so a resend does not deliver it twice. Fetch with the same `base_url` this publish used, and with `scheduled: true` if it set `delay`; without them the fetch cannot see this message. If `base_url` (or the configured `NTFY_BASE_URL`) does not point at an ntfy server, correct it first.',
      thrownBy: 'service',
    },
    {
      reason: 'not_ntfy_endpoint',
      code: JsonRpcErrorCode.NotFound,
      when: "The publish did not reach an ntfy topic route: a non-2xx answer without ntfy's JSON error envelope on a status no other reason covers (such as a 404, 405, or 501, or a 401 or 403 without the envelope), or ntfy's own 40401 `page not found`. The code stays the one the HTTP status maps to",
      retryable: false,
      recovery:
        'Check that `base_url` (or the configured `NTFY_BASE_URL`) is the root URL of an ntfy server, not a page under it, and that no proxy in front of it refused the request, then resend the publish.',
      thrownBy: 'service',
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

    const tags = input.tags?.filter((tag) => present(tag) !== undefined);
    const requestBody: NtfyPublishRequest = {
      topic,
      message: input.message,
      title: input.title,
      // Schema-validated to the 1–5 domain above.
      priority: input.priority as Priority | undefined,
      tags: tags?.length ? tags : undefined,
      click: present(input.click),
      attach: present(input.attach),
      icon: input.icon,
      filename: present(input.filename),
      markdown: input.markdown,
      actions: input.actions?.length ? (input.actions as NtfyAction[]) : undefined,
      delay: present(input.delay),
      timezone: present(input.timezone),
      email: input.email,
      call: input.call,
      sequence_id: input.sequence_id,
      cache: input.cache,
      firebase: input.firebase,
    };

    const overrideBase = normalizeBaseOverride(input.base_url);
    const baseUrl = overrideBase ?? getNtfyService().baseUrl;

    const sideEffects = outOfBandSideEffects(input);
    if (sideEffects.length > 0) {
      const consent = await confirmAction(ctx, {
        operation: 'ntfy_publish_message',
        target: `${baseUrl}/${topic}`,
        request: { url: `${baseUrl}/`, body: requestBody },
        message: `Publish to ntfy topic ${promptLiteral(topic)} with:\n${sideEffects.map((effect) => `- ${effect}`).join('\n')}`,
      });
      if (consent === 'declined') {
        throw ctx.fail(
          'consent_declined',
          'The publish was not confirmed, so nothing was sent to ntfy.',
        );
      }
    }

    let reply: NtfyReply<NtfyPublishResponse>;
    try {
      reply = await getNtfyService().publish(requestBody, {
        baseUrl: overrideBase,
        signal: ctx.signal,
      });
    } catch (err) {
      throw classifyPublishError(err, ctx);
    }
    const { envelope: response, quota } = reply;
    // An unreported quota stays absent: `ctx.enrich({ quota: undefined })` would render.
    if (quota) ctx.enrich({ quota });

    // ntfy's reply carries no scheduled flag, so it comes from the request: a
    // successful publish that sent `delay` was queued for later delivery.
    const scheduled = requestBody.delay !== undefined;

    ctx.log.info('Published ntfy message', {
      messageId: response.id,
      scheduled,
    });

    return {
      id: response.id,
      time: new Date(response.time * 1000).toISOString(),
      topic: response.topic,
      url: `${baseUrl}/${response.topic}`,
      expires:
        response.expires !== undefined
          ? new Date(response.expires * 1000).toISOString()
          : undefined,
      sequence_id: response.sequence_id,
      scheduled: scheduled || undefined,
      title: response.title,
      message: response.message,
      markdown: response.content_type === 'text/markdown' || undefined,
      priority: response.priority,
      tags: response.tags,
      click: response.click,
      icon: response.icon,
      attachment: response.attachment,
      actions: response.actions as Output['actions'],
    };
  },

  format(result) {
    const lines: string[] = [];
    const subject = `message ${literal(result.id)} on ${literal(result.topic)}`;
    lines.push(
      result.scheduled
        ? `**Scheduled** — ntfy queued ${subject}`
        : `**Sent** — ntfy accepted ${subject}`,
    );
    lines.push(`URL: ${literal(result.url)}`);
    // A scheduled publish reports the delivery time in `time`, not the accept
    // time — label it so the agent doesn't relay a future timestamp as "sent at".
    lines.push(result.scheduled ? `Delivers: ${result.time}` : `Time: ${result.time}`);
    if (result.expires) {
      lines.push(`Cache expires: ${result.expires}`);
    }
    if (result.sequence_id) {
      lines.push(`Sequence ID: ${literal(result.sequence_id)}`);
    }
    if (result.title) lines.push(`Title: ${literal(result.title)}`);
    if (result.priority !== undefined) {
      lines.push(`Priority: ${result.priority} (${priorityLabel(result.priority)})`);
    }
    if (result.tags?.length) lines.push(`Tags: ${result.tags.map(literal).join(' · ')}`);
    if (result.message) {
      lines.push('', literalBlock(result.message, result.markdown ? 'markdown' : 'text'));
    }
    const links: string[] = [];
    if (result.click) links.push(`Click action: ${literal(result.click)}`);
    // A code span, never an image: the publisher picks the URL, and an image
    // would have a rendering client fetch it.
    if (result.icon) links.push(`Icon: ${literal(result.icon)}`);
    if (links.length) lines.push('', ...links);
    if (result.attachment) {
      const a = result.attachment;
      const meta: string[] = [];
      if (a.type) meta.push(`type: ${literal(a.type)}`);
      if (a.size !== undefined) meta.push(`size: ${a.size} bytes`);
      if (a.expires !== undefined) meta.push(`expires: ${a.expires}`);
      const suffix = meta.length ? ` (${meta.join(', ')})` : '';
      lines.push('', `Attachment: ${literal(a.name)} — ${literal(a.url)}${suffix}`);
    }
    if (result.actions?.length) {
      lines.push('', 'Actions:');
      for (const a of result.actions) lines.push(`- ${literal(JSON.stringify(a))}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * The hint each `payload_too_large` failure carries: the fix for the one thing
 * ntfy rejected, where the declared `recovery` names them all. A 413 and an
 * oversize 400 that name nothing else get the message-body hint.
 */
const OVERSIZE_HINTS = {
  body: `Shorten the message (≤${MESSAGE_MAX_BYTES} bytes plain) or host the long content as an external URL via \`attach\`.`,
  title:
    'Shorten `title` and resend — ntfy rejected the title as too long, so shortening the message body will not help.',
  tags: 'Send fewer or shorter `tags` — ntfy accepts 512 bytes of tags in total, counted after it splits each tag at commas and trims the spaces around it, so shortening the message body will not help.',
  attachment:
    "ntfy stored the message as a file attachment (it does when `filename` is set without `attach`, or when the message is over the server's message limit) and refused the file: it exceeds the server's attachment size limit, or this client's attachment storage or daily bandwidth quota is used up. Drop `filename` to send the text as a plain message, or host the file elsewhere and pass its URL as `attach`; a used-up bandwidth quota resets within 24 hours.",
  request:
    'ntfy refused the publish as a whole: the JSON request holding every field together — message, title, tags, URLs, and action buttons with everything in them — must stay under 8,192 bytes on a default ntfy server (twice its message size limit). Shorten the longest of those fields; trimming a short message will not help.',
} as const;

/**
 * The hint each `invalid_attachment` failure carries: the fix for the one form
 * ntfy refused, where the declared `recovery` names both.
 */
const ATTACHMENT_HINTS = {
  url: 'Pass `attach` an absolute URL (`https://host/path/file.jpg`) to an already-hosted file — the recipient device fetches it, so a local path will not work, and shortening the message will not help.',
  file: "With `filename` set and no `attach`, ntfy stores the message body as a file named `filename`, and ntfy v2.20.0 and later fail that write (HTTP 500). Pass the hosted file's URL as `attach` alongside `filename`, or drop `filename` to send the text as a plain message.",
} as const;

/**
 * The hint an `unverified_contact` failure carries when ntfy refused the
 * `email` or `call` because the request had no credentials (40035, 40053),
 * where the declared `recovery` covers an address or number that is not
 * verified (40034, 40052).
 */
const ANONYMOUS_SENDER_HINT =
  'ntfy forwards e-mail and places calls only for an authenticated sender: drop the `email`/`call` field and resend, or ask the operator to configure ntfy credentials for this server (`NTFY_AUTH_TOKEN`, or `NTFY_AUTH_USERNAME` + `NTFY_AUTH_PASSWORD`, or an `NTFY_SERVERS` entry for a per-call `base_url`).';

/**
 * Translate a thrown error from `NtfyService.publish` into a typed contract
 * failure. A sub-reason, and the limit or field a failure names, is read from
 * ntfy's error envelope alone (its code, or the phrase in its `error` text);
 * the rest from a label the service set, the HTTP status or the JSON-RPC code
 * it maps to, or the retry boundary having given up. Anything else bubbles
 * unchanged so the framework auto-classifier picks the right code.
 */
function classifyPublishError(
  err: unknown,
  ctx: Parameters<typeof ntfyPublishMessage.handler>[1],
): unknown {
  // Already carries its declared reason; the unreachable branch below would
  // claim it once the call deadline has marked it `(failed after N attempts)`.
  if (isUpstreamMalformed(err)) return err;

  const code = getCode(err);
  const message = getMessage(err);

  // The service read ntfy's 500 as the failed write of a file publish and sent it once.
  if (isFileStoreFailure(err)) {
    return ctx.fail('invalid_attachment', message, { recovery: { hint: ATTACHMENT_HINTS.file } });
  }
  if (isAuthRejection(err)) {
    return ctx.fail('forbidden_topic', message || 'ntfy refused access to the topic.');
  }
  if (isRateLimitedCode(code)) {
    return ctx.fail(
      'rate_limited',
      message || 'ntfy returned 429 after retries.',
      rateLimitedData(err),
    );
  }
  // 413 maps to `InvalidRequest`, which `isInvalidParamsCode` deliberately
  // excludes — read the upstream status directly so an oversize body or a
  // refused attachment reaches `payload_too_large` instead of bubbling
  // unclassified.
  if (getDataStatus(err) === 413) {
    const hint = OVERSIZE_HINTS[oversizedPublishField(err) ?? 'body'];
    return ctx.fail('payload_too_large', message, { recovery: { hint } });
  }
  if (isInvalidParamsCode(code)) {
    const sub = classifyInvalidParams(err);
    if (sub === 'payload_too_large') {
      const hint = OVERSIZE_HINTS[oversizedPublishField(err) ?? 'body'];
      return ctx.fail(sub, message, { recovery: { hint } });
    }
    if (sub === 'unverified_contact' && isAnonymousSenderRejection(err)) {
      return ctx.fail(sub, message, { recovery: { hint: ANONYMOUS_SENDER_HINT } });
    }
    if (sub === 'invalid_attachment') {
      return ctx.fail(sub, message, { recovery: { hint: ATTACHMENT_HINTS.url } });
    }
    if (sub) return ctx.fail(sub, message);
  }
  if (isUpstreamUnreachable(err)) {
    return ctx.fail(
      'upstream_unreachable',
      message || 'ntfy server is unreachable.',
      unreachableWaitData(err, 'resend the publish'),
      { cause: err },
    );
  }
  return err;
}
