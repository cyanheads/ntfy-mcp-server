/**
 * @fileoverview `ntfy_fetch_messages` — polls cached messages from one or more
 * ntfy topics with optional filters. Single round-trip via the upstream
 * `<topic>/json?poll=1` endpoint; the response is parsed line-by-line and
 * filtered to drop transport frames (`open`, `keepalive`). Blank and
 * whitespace-only `since` and filter values are resolved as unset before the
 * query is built. Over-limit windows keep the newest `limit` messages, and a
 * message-ID `cursor`, resolved inside the fetched window, pages through the
 * rest oldest-first; under a duration `since` the cursor also carries the
 * walk's window start, so its pages poll from a bound that does not move. A
 * repeated message ID is kept once. A call pinned to one message by `id`
 * returns that body untruncated. The resolved topic/since, returned and window counts, the
 * continuation cursor, truncation flags, active filters, and empty/truncated
 * guidance ride the `enrichment` block so they reach both `structuredContent`
 * and `content[]` without a `format()` entry. A poll body that is not ntfy's
 * JSON message stream fails as `upstream_malformed`. Every ntfy- or
 * caller-supplied string reaches `content[]` as a code span or fence, so it
 * renders as literal text; a body ntfy marks `text/markdown` is flagged
 * `markdown: true` and fenced as `markdown`.
 * @module mcp-server/tools/definitions/ntfy-fetch-messages.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';

import { getServerConfig } from '@/config/server-config.js';
import { literal, literalBlock } from '@/mcp-server/tools/utils/markdown-literal.js';
import {
  BASE_URL_HINT,
  BASE_URL_PATTERN,
  normalizeBaseOverride,
} from '@/services/ntfy/base-url-guard.js';
import {
  getCode,
  getMessage,
  isAuthCode,
  isBaseUrlRejection,
  isInvalidParamsCode,
  isRateLimitedCode,
  isUpstreamMalformed,
  isUpstreamUnreachable,
  retryAfterData,
} from '@/services/ntfy/error-classifier.js';
import { MESSAGE_TRUNCATE_AT, shapeMessage } from '@/services/ntfy/message-shape.js';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';
import type { NtfyFetchResult, Priority } from '@/services/ntfy/types.js';

const TOPIC_LIST_REGEX = /^[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+)*$/;
const DEFAULT_SINCE = '10m';
const DEFAULT_LIMIT = 20;
/** Messages one call returns; a larger `limit` is served up to this and says so. */
const MAX_LIMIT = 100;
/** Hard ceiling on `limit` itself — rejects absurd input, not an over-cap request. */
const LIMIT_CEILING = 1000;

/**
 * ntfy reads `since` in this order: keyword, 12-character message ID, Unix
 * timestamp, then a Go `time.ParseDuration` string. Only the duration is
 * measured from ntfy's "now", so only its lower bound moves between calls.
 * Each number has one parse (`\d+(?:\.\d*)?`, never `\d+\.?\d*`), so a
 * caller's `since` that nearly matches cannot backtrack exponentially.
 */
const MESSAGE_ID = /^[A-Za-z0-9]{12}$/;
const GO_DURATION = /^[-+]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/;

function isDuration(since: string): boolean {
  return !MESSAGE_ID.test(since) && GO_DURATION.test(since);
}

/**
 * A cursor names the message a page starts at. Under a duration `since` it also
 * carries the walk's window start — `<id>@<unix seconds>`, the oldest `time` in
 * the window the walk began from — so a cursor call can poll from that fixed
 * point instead of a duration that has since moved past the cursor's message.
 * The time comes off ntfy's own messages, so no clock but ntfy's is involved.
 */
interface Cursor {
  id: string;
  start?: number;
}

function parseCursor(cursor: string): Cursor {
  const at = cursor.lastIndexOf('@');
  const start = cursor.slice(at + 1);
  return at > 0 && /^\d+$/.test(start)
    ? { id: cursor.slice(0, at), start: Number(start) }
    : { id: cursor };
}

function formatCursor(id: string, start: number | undefined): string {
  return start === undefined ? id : `${id}@${start}`;
}

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
  .max(5, PRIORITY_ERROR);

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
    .default(DEFAULT_SINCE)
    .describe(
      "Lower bound of the window. Default `10m`, tighter than ntfy's default to keep the common 'did my recent notification land?' lookup cheap. Accepts a duration in seconds, minutes, or hours (`30s`, `10m`, `2h`, `24h`), a Unix timestamp, the keywords `all` (every cached message — up to ~12h on ntfy.sh) or `latest` (most recent only), or a message ID, which returns only the messages after that one — an ID ntfy no longer holds returns the whole cache rather than an error. To page through a window larger than one call returns, use `cursor`, not `since`; keep `since` the same on every page, even a duration — the cursor holds the window where the walk began.",
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
  id: z
    .string()
    .optional()
    .describe(
      'Exact-match a single message ID. Pinning one message this way also returns its body in full — the ~500-char cap that applies to list results is lifted. `since` still bounds which cached messages are searched, so widen it when the target is older than the default window.',
    ),
  title: z.string().optional().describe('Exact-match against the title string.'),
  message: z.string().optional().describe('Exact-match against the message body.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(LIMIT_CEILING)
    .default(DEFAULT_LIMIT)
    .describe(
      'Client-side cap on returned messages. Default 20; one call returns at most 100, so a larger value is served as 100. Without `cursor`, the newest `limit` of the window are returned (listed oldest-first); with `cursor`, up to `limit` starting at the cursor message. `truncated` and `nextCursor` say when more remain.',
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Continue a paged read: pass the previous response's `nextCursor` verbatim, with the same `topic`, `since`, and filters. Returns up to `limit` messages starting at that message (inclusive), oldest-first, and a new `nextCursor` while more remain. Under a duration `since` (`10m`, `2h`), the cursor also holds the window where the walk began, so later pages stay reachable after the duration's lower bound has moved past the first messages. Omit it to get the newest messages of the window.",
    ),
  base_url: z
    .string()
    .regex(BASE_URL_PATTERN, BASE_URL_HINT)
    .optional()
    .describe(
      'Override `NTFY_BASE_URL` for this call — an absolute `http(s)://` URL. Server-configured auth credentials are forwarded only when the override matches a registered server (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry); otherwise the request goes out unauthenticated.',
    ),
});

const MessageSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Message ID — pass back as `id` to fetch this message with its whole body, or as `sequence_id` to manage it. To page through a window, pass the `nextCursor` enrichment value as `cursor`.',
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
        `Notification body. Truncated client-side to ~${MESSAGE_TRUNCATE_AT} chars; see \`messageTruncated\` for the count of dropped chars. Returned whole when the call pinned a single message via \`id\`. Absent on clear/delete events.`,
      ),
    messageTruncated: z
      .number()
      .optional()
      .describe(
        "Count of additional characters dropped from `message`. To read the whole body, call this tool again with `id` set to this message's `id` and a `since` window that still covers it — a single-message fetch skips truncation. Absent when the full body fit within the cap or truncation was skipped.",
      ),
    markdown: z
      .boolean()
      .optional()
      .describe(
        'True when the message was published as Markdown, so `message` is Markdown source; absent for plain text.',
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

function filterSummary(f: FilterEcho | undefined): string {
  if (!f) return 'none';
  const parts: string[] = [];
  if (f.id) parts.push(`id=${literal(f.id)}`);
  if (f.title) parts.push(`title=${literal(f.title)}`);
  if (f.message) parts.push(`message=${literal(f.message)}`);
  if (f.priority?.length) parts.push(`priority=[${f.priority.join(',')}]`);
  if (f.tags?.length) parts.push(`tags=[${f.tags.map(literal).join(',')}]`);
  return parts.length ? parts.join(', ') : 'none';
}

export const ntfyFetchMessages = tool('ntfy_fetch_messages', {
  description:
    'Poll cached messages from one or more ntfy topics with optional filters. Returns a snapshot, not a live stream — use it to confirm delivery, replay missed alerts, or audit topic activity. Multiple topics are passed as a comma-separated list. One call returns the newest messages of the window; when more match, page through the whole window oldest-first by passing `nextCursor` back as `cursor`. Long bodies are truncated client-side to keep list responses bounded; refetch with that message `id` to read one in full.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  // Agent-facing success-path context — the resolved topic/since, the returned
  // count, the truncation flags, the active filters, and empty/truncated guidance.
  // Merged into structuredContent and mirrored into a content[] trailer.
  enrichment: {
    topic: z
      .string()
      .describe(
        'Echo of the resolved topic (or comma-separated list) — useful when `NTFY_DEFAULT_TOPIC` filled in for an omitted `topic`.',
      ),
    since: z
      .string()
      .describe(
        'Echo of the `since` value sent to ntfy — the input trimmed, or the default `10m` when it was omitted or blank. On a cursor page under a duration, the Unix time where the walk began, which the cursor carries.',
      ),
    count: z.number().describe('Number of messages returned in this response.'),
    totalCount: z
      .number()
      .describe(
        'Messages in the fetched window, before `limit` and `cursor` apply. On a cursor page under a duration `since`, the window runs from where the walk began, so it counts arrivals since then and drops expired messages. When `upstreamTruncated` is set it counts only what ntfy returned.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when this response holds fewer messages than `totalCount`. Without `cursor`, the newest `limit` are returned and the older head is left out; on a cursor page, the other pages hold the rest. `nextCursor` says whether more follow.',
      ),
    nextCursor: z
      .string()
      .optional()
      .describe(
        "Pass verbatim as `cursor`, with the same `topic`, `since`, and filters, to get the next page oldest-first. Without `cursor` it names the oldest message of the window, starting a walk through the whole window; on a cursor page, the message after this page. Under a duration `since` it is `<message id>@<unix seconds>`, the seconds marking where the walk began, which keeps the walk's window from shrinking as ntfy's clock advances. Absent on the last page, on an empty result, and when nothing was left out.",
      ),
    upstreamTruncated: z
      .boolean()
      .optional()
      .describe(
        'True when ntfy itself capped the replay at its per-topic size limit and dropped the oldest messages in the window before responding. Those messages are not reachable through this server, and every count reported covers only what ntfy returned. Absent when ntfy sent the whole window.',
      ),
    appliedFilters: FilterEchoSchema.optional().describe(
      'Active filter inputs the server applied; absent when no filters were set.',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the result is empty or truncated, here or by ntfy — echoes the criteria and suggests how to broaden or paginate.',
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
      when: '`since` value could not be parsed by ntfy (a malformed duration or timestamp, or a duration unit other than `s`, `m`, `h`).',
      recovery:
        'Use one of: `all`, `latest`, a duration like `10m` / `2h` / `24h` (units `s`, `m`, `h`), a Unix timestamp (seconds), or a message ID.',
    },
    {
      reason: 'cursor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: "`cursor` names no message in the fetched window: its message expired from ntfy's cache or fell outside ntfy's replay, or the cursor came from a call with a different `topic`, `since`, or filters.",
      recovery:
        'Call again without `cursor` to restart from the newest messages and page from the new `nextCursor`, or widen `since` (for example to `all`) if the message should still be cached.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'ntfy answered 429 — on the status line, or as an error line written into the replay — and was still answering it when retries ran out.',
      retryable: true,
      recovery:
        "Wait for ntfy's rate-limit window to pass before polling again — `retryAfter` seconds when the error carries it. A request-rate limit (`too many requests`) clears within minutes; a daily quota (`daily … reached`) resets within 24 hours.",
    },
    {
      reason: 'upstream_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DNS, connection, or network failure reaching the ntfy server after retries were exhausted, or no complete answer within the call deadline.',
      retryable: true,
      recovery:
        'Verify the configured `NTFY_BASE_URL` (or per-call `base_url`) resolves and is reachable; check network connectivity, then retry.',
    },
    {
      reason: 'upstream_malformed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The poll response was not ntfy's JSON message stream (an HTML page, a cut-off or corrupted body) on every attempt.",
      retryable: true,
      thrownBy: 'service',
      recovery:
        "The server at the base URL answered with something other than ntfy's JSON message stream. Check that `base_url` (or the configured `NTFY_BASE_URL`) points at an ntfy server, then retry.",
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

    const overrideBase = normalizeBaseOverride(input.base_url);

    /**
     * ntfy trims every query parameter, so a blank or whitespace-only value is
     * no value at all. Resolve that here, before it reaches the query, the echo,
     * or the body-cap decision: a blank `since` would otherwise widen the window
     * to ntfy's `all`, and a blank `id` would lift the cap on an unfiltered list.
     */
    const requestedSince = input.since.trim() || DEFAULT_SINCE;
    const tags = input.tags?.map((t) => t.trim()).filter((t) => t.length > 0);
    const filters: FilterEcho = {
      priority: input.priority?.length ? input.priority : undefined,
      tags: tags?.length ? tags : undefined,
      id: input.id?.trim() || undefined,
      title: input.title?.trim() || undefined,
      message: input.message?.trim() || undefined,
    };
    const rawCursor = input.cursor?.trim() || undefined;
    const cursor = rawCursor === undefined ? undefined : parseCursor(rawCursor);
    /**
     * ntfy measures a duration from its own "now" on every call, so the window's
     * oldest messages — the first a walk asks for — are the first to fall out of
     * it. A cursor page under a duration polls from the walk's window start the
     * cursor carries instead. Every other `since` form is a fixed bound and goes
     * out as given.
     */
    const moving = isDuration(requestedSince);
    const pinned = moving ? cursor?.start : undefined;
    const since = pinned === undefined ? requestedSince : String(pinned);

    let polled: NtfyFetchResult;
    try {
      polled = await getNtfyService().fetch(
        {
          topic,
          since,
          scheduled: input.scheduled,
          // Schema-validated to the 1–5 domain above.
          priority: filters.priority as Priority[] | undefined,
          tags: filters.tags,
          id: filters.id,
          title: filters.title,
          message: filters.message,
        },
        { baseUrl: overrideBase, signal: ctx.signal },
      );
    } catch (err) {
      // A locally-rejected `base_url` already carries its own message and hint;
      // the branches below speak for ntfy, not for this server.
      if (isBaseUrlRejection(err)) throw err;
      // Already carries its declared reason; the unreachable branch below would
      // otherwise claim it, since it too is a retry-exhausted ServiceUnavailable.
      if (isUpstreamMalformed(err)) throw err;
      const code = getCode(err);
      const msg = getMessage(err);
      if (isAuthCode(code)) {
        throw ctx.fail('forbidden_topic', msg || `Forbidden for topic ${literal(topic)}`);
      }
      if (isRateLimitedCode(code)) {
        throw ctx.fail(
          'rate_limited',
          msg || 'ntfy returned 429 after retries.',
          retryAfterData(err),
        );
      }
      if (isInvalidParamsCode(code)) {
        throw ctx.fail('invalid_since', msg || `Could not parse \`since\` ${literal(since)}.`);
      }
      if (isUpstreamUnreachable(err)) {
        throw ctx.fail('upstream_unreachable', msg || 'ntfy server is unreachable.');
      }
      throw err;
    }

    /**
     * Keep only notification events, dropping connection-level frames, and only
     * the first message of any repeated ID. ntfy never repeats one; a window that
     * did would give a cursor two positions, and a walk could be handed the same
     * cursor forever.
     */
    const seenIds = new Set<string>();
    let repeatedIds = 0;
    const notifications = polled.messages.filter((m) => {
      if (m.event === 'open' || m.event === 'keepalive') return false;
      if (seenIds.has(m.id)) {
        repeatedIds += 1;
        return false;
      }
      seenIds.add(m.id);
      return true;
    });
    if (repeatedIds > 0) {
      ctx.log.warning('Dropped poll messages that repeat an earlier message ID', { repeatedIds });
    }
    const { upstreamTruncated } = polled;
    const totalCount = notifications.length;
    const limit = Math.min(input.limit, MAX_LIMIT);

    /**
     * ntfy returns the window oldest-first. Without a cursor the page is the
     * newest `limit` (the tail); with one, it starts at the cursor's message.
     * Anchoring on a message ID rather than an offset keeps a walk stable while
     * new messages append and old ones expire between calls.
     */
    let start = Math.max(0, totalCount - limit);
    if (cursor !== undefined) {
      start = notifications.findIndex((m) => m.id === cursor.id);
      if (start === -1) {
        throw ctx.fail(
          'cursor_not_found',
          `Cursor ${literal(rawCursor as string)} names none of the ${totalCount} messages in the window for topic ${literal(topic)} (since ${literal(since)}${pinned === undefined ? '' : ', where the walk began'}).`,
        );
      }
    }
    const page = notifications.slice(start, start + limit);
    // The first message not yet given, walking the window oldest-first: the
    // window's head after an uncursored call, the message after a cursor page.
    const nextId =
      cursor === undefined
        ? start > 0
          ? notifications[0]?.id
          : undefined
        : notifications[start + limit]?.id;
    // Under a duration, every cursor of a walk carries the same window start:
    // the one it was handed, or else this window's oldest message time.
    const nextCursor =
      nextId === undefined
        ? undefined
        : formatCursor(
            nextId,
            moving
              ? (pinned ?? notifications.reduce((t, m) => Math.min(t, m.time), Infinity))
              : undefined,
          );
    const truncated = page.length < totalCount;

    ctx.log.info('Fetched ntfy messages', {
      requested: input.limit,
      returned: page.length,
      totalCount,
      paged: cursor !== undefined,
      truncated,
      upstreamTruncated,
    });

    ctx.enrich({ topic, since, count: page.length, totalCount, truncated });
    if (nextCursor !== undefined) ctx.enrich({ nextCursor });
    if (upstreamTruncated) ctx.enrich({ upstreamTruncated });

    const hasFilters = Object.values(filters).some((v) => v !== undefined);
    if (hasFilters) ctx.enrich({ appliedFilters: filters });

    // `notice` is last-wins, so every condition contributes a sentence here and
    // the joined text is set once.
    const notices: string[] = [];
    // Under ntfy's replay cap the count is of what ntfy sent, not of every match.
    const found = upstreamTruncated
      ? `ntfy returned ${totalCount} messages`
      : `${totalCount} messages matched`;
    if (page.length === 0) {
      notices.push(
        `No messages on topic ${literal(topic)} (since ${literal(since)})${
          hasFilters ? ` with filters ${filterSummary(filters)}` : ''
        }. Try a wider \`since\` window${hasFilters ? ', drop filters,' : ''} or verify the topic name.`,
      );
    } else if (nextCursor !== undefined) {
      const continuation = `call again with \`cursor\` set to ${literal(nextCursor)} and the same \`topic\`, \`since\`, and filters`;
      // A pinned page's window starts where the walk began, which a fresh call
      // under the same duration no longer reaches, so dropping `cursor` is no shortcut.
      const raise =
        input.limit < MAX_LIMIT && totalCount < MAX_LIMIT && pinned === undefined
          ? ` Or raise \`limit\` to ${totalCount}${cursor === undefined ? '' : ' and drop `cursor`'} to get the whole window in one call.`
          : '';
      if (cursor === undefined) {
        const cut =
          input.limit > MAX_LIMIT
            ? `one call returns at most ${MAX_LIMIT}`
            : `\`limit\` was ${input.limit}`;
        notices.push(
          `${found} (\`totalCount\`) but ${cut}, so this response holds the newest ${page.length} and leaves out the older ${start}. To read the whole window oldest-first, ${continuation}, then pass each response's \`nextCursor\` as the next \`cursor\`.${raise}`,
        );
      } else {
        const of = upstreamTruncated ? 'messages ntfy returned' : 'messages in the window';
        notices.push(
          `This page holds ${page.length} of the ${totalCount} ${of} (\`totalCount\`), oldest-first from \`cursor\`. For the next page, ${continuation}.${raise}`,
        );
      }
    } else if (truncated) {
      notices.push(
        `Last page: ${page.length === 1 ? 'this message ends' : `these ${page.length} messages end`} the window (\`totalCount\` ${totalCount}); the earlier pages hold the rest.`,
      );
    }
    if (upstreamTruncated) {
      notices.push(
        `ntfy capped this replay at its per-topic size limit and dropped the oldest messages in the window before responding; they are not reachable through this server${
          truncated
            ? ''
            : `, and ${page.length === 1 ? 'this message is' : `these ${page.length} messages are`} what ntfy returned`
        }.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    // A call pinned to one message by `id` returns its body whole — the only
    // path to a body the ~500-char list cap would otherwise cut. A blank `id`
    // was resolved to no filter above, so that response is still a capped list.
    const truncateBody = filters.id === undefined;
    return { messages: page.map((m) => shapeMessage(m, { truncateBody })) };
  },

  format(result) {
    if (result.messages.length === 0) {
      return [{ type: 'text', text: 'No messages matched the query.' }];
    }

    const blocks = result.messages.map((m) => {
      const lines: string[] = [
        `### ${literal(m.id)} — ${literal(m.event)} on ${literal(m.topic)}`,
        `Time: ${m.time}`,
      ];
      if (m.expires) lines.push(`Cache expires: ${m.expires}`);
      if (m.sequence_id) lines.push(`References sequence: ${literal(m.sequence_id)}`);
      if (m.title) lines.push(`Title: ${literal(m.title)}`);
      if (m.priority !== undefined) {
        lines.push(`Priority: ${m.priority} (${priorityLabel(m.priority)})`);
      }
      if (m.tags?.length) lines.push(`Tags: ${m.tags.map(literal).join(' · ')}`);
      if (m.click) lines.push(`Click action: ${literal(m.click)}`);
      if (m.attachment) {
        const a = m.attachment;
        const meta: string[] = [];
        if (a.type) meta.push(`type: ${literal(a.type)}`);
        if (a.size !== undefined) meta.push(`size: ${a.size} bytes`);
        if (a.expires !== undefined) meta.push(`expires: ${a.expires}`);
        const suffix = meta.length ? ` (${meta.join(', ')})` : '';
        lines.push(`Attachment: ${literal(a.name)} — ${literal(a.url)}${suffix}`);
      }
      if (m.actions?.length) {
        lines.push('Actions:');
        for (const a of m.actions) lines.push(`- ${literal(JSON.stringify(a))}`);
      }
      if (m.message !== undefined) {
        lines.push('', literalBlock(m.message, m.markdown ? 'markdown' : 'text'));
        if (m.messageTruncated !== undefined) {
          lines.push(`_(${m.messageTruncated} chars more)_`);
        }
      }
      return lines.join('\n');
    });

    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
