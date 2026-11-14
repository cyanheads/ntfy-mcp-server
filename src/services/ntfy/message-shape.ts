/**
 * @fileoverview Normalizes a raw `NtfyMessage` poll envelope into the shape the
 * MCP surfaces hand back: Unix-second timestamps converted to ISO 8601 strings,
 * ntfy's `content_type: "text/markdown"` reduced to a `markdown: true` flag,
 * long bodies truncated to a bounded length unless the caller opts out, and —
 * given ntfy's clock — a row still queued for later delivery marked
 * `scheduled: true`.
 * Lives in the service layer so `ntfy_fetch_messages` and the `ntfy://{topic}`
 * resource — peers, not dependents — normalize identically instead of one
 * importing the other's internals.
 * @module services/ntfy/message-shape
 */

import type {
  MessageEvent,
  NtfyActionReadback,
  NtfyAttachment,
  NtfyMessage,
  Priority,
} from './types.js';

/** Budget for a returned message body, in UTF-16 code units; the rest is reported as a count. */
export const MESSAGE_TRUNCATE_AT = 500;

/** A `NtfyMessage` with ISO 8601 timestamps and a length-bounded body. */
export interface ShapedNtfyMessage {
  actions?: NtfyActionReadback[] | undefined;
  attachment?: NtfyAttachment | undefined;
  click?: string | undefined;
  /** `base64` when `message` is the base64 of a body that was not UTF-8 text. */
  encoding?: string | undefined;
  event: MessageEvent;
  expires?: string | undefined;
  icon?: string | undefined;
  id: string;
  /** `true` when ntfy marked the body `text/markdown`; absent for plain text. */
  markdown?: true | undefined;
  message?: string | undefined;
  /** Count of UTF-16 code units dropped from `message`; absent when nothing was cut. */
  messageTruncated?: number | undefined;
  priority?: Priority | undefined;
  /** `true` when `time` is later than the clock the caller passed; absent otherwise. */
  scheduled?: true | undefined;
  sequence_id?: string | undefined;
  tags?: string[] | undefined;
  /**
   * When ntfy accepted an immediate publish, or a delayed one's delivery time,
   * which ntfy keeps after delivery.
   */
  time: string;
  title?: string | undefined;
  topic: string;
}

/**
 * Cap a message body at `MESSAGE_TRUNCATE_AT` UTF-16 code units, reporting the
 * dropped count in the same unit. A cut that would separate a surrogate pair
 * (most emoji) keeps one unit fewer: a lone high surrogate makes the body
 * ill-formed, and strict JSON parsers reject the whole result over it.
 */
function truncateMessage(
  body: string | undefined,
  truncate: boolean,
): {
  message?: string;
  messageTruncated?: number;
} {
  if (body === undefined) return {};
  if (!truncate || body.length <= MESSAGE_TRUNCATE_AT) return { message: body };
  const splitsPair =
    isHighSurrogate(body.charCodeAt(MESSAGE_TRUNCATE_AT - 1)) &&
    isLowSurrogate(body.charCodeAt(MESSAGE_TRUNCATE_AT));
  const cut = splitsPair ? MESSAGE_TRUNCATE_AT - 1 : MESSAGE_TRUNCATE_AT;
  return { message: body.slice(0, cut), messageTruncated: body.length - cut };
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Normalize one polled message. Callers filter the connection-level `open` /
 * `keepalive` frames out before shaping, so the narrower `MessageEvent` holds.
 *
 * @param raw - The upstream poll envelope.
 * @param opts.truncateBody - Cap the body at `MESSAGE_TRUNCATE_AT` (default
 *   `true`). Pass `false` to return the whole body with no `messageTruncated`
 *   count — only safe where the result set is pinned to a single message.
 * @param opts.scheduledAsOfSeconds - ntfy's clock at the poll, in Unix seconds.
 *   A row whose `time` is strictly later is still queued for delivery and gets
 *   `scheduled: true`. ntfy writes the same row before and after delivery and
 *   `time` stays the delivery time, so this comparison is the only signal.
 *   Omit it where the poll could not return queued rows.
 */
export function shapeMessage(
  raw: NtfyMessage,
  opts: { truncateBody?: boolean; scheduledAsOfSeconds?: number | undefined } = {},
): ShapedNtfyMessage {
  const truncation = truncateMessage(raw.message, opts.truncateBody !== false);
  const { scheduledAsOfSeconds } = opts;
  return {
    id: raw.id,
    time: new Date(raw.time * 1000).toISOString(),
    scheduled: (scheduledAsOfSeconds !== undefined && raw.time > scheduledAsOfSeconds) || undefined,
    event: raw.event as MessageEvent,
    topic: raw.topic,
    expires: raw.expires !== undefined ? new Date(raw.expires * 1000).toISOString() : undefined,
    sequence_id: raw.sequence_id,
    title: raw.title,
    message: truncation.message,
    messageTruncated: truncation.messageTruncated,
    markdown: raw.content_type === 'text/markdown' || undefined,
    encoding: raw.encoding,
    priority: raw.priority,
    tags: raw.tags,
    click: raw.click,
    icon: raw.icon,
    actions: raw.actions,
    attachment: raw.attachment,
  };
}
