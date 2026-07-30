/**
 * @fileoverview Normalizes a raw `NtfyMessage` poll envelope into the shape the
 * MCP surfaces hand back: Unix-second timestamps converted to ISO 8601 strings
 * and long bodies truncated to a bounded length. Lives in the service layer so
 * `ntfy_fetch_messages` and the `ntfy://{topic}` resource — peers, not
 * dependents — normalize identically instead of one importing the other's
 * internals.
 * @module services/ntfy/message-shape
 */

import type { MessageEvent, NtfyAction, NtfyAttachment, NtfyMessage, Priority } from './types.js';

/** Character budget for a returned message body; the rest is reported as a count. */
export const MESSAGE_TRUNCATE_AT = 500;

/** A `NtfyMessage` with ISO 8601 timestamps and a length-bounded body. */
export interface ShapedNtfyMessage {
  actions?: NtfyAction[] | undefined;
  attachment?: NtfyAttachment | undefined;
  click?: string | undefined;
  event: MessageEvent;
  expires?: string | undefined;
  id: string;
  message?: string | undefined;
  /** Count of characters dropped from `message`; absent when nothing was cut. */
  messageTruncated?: number | undefined;
  priority?: Priority | undefined;
  sequence_id?: string | undefined;
  tags?: string[] | undefined;
  time: string;
  title?: string | undefined;
  topic: string;
}

/** Cap a message body at `MESSAGE_TRUNCATE_AT`, reporting the dropped count. */
function truncateMessage(body: string | undefined): {
  message?: string;
  messageTruncated?: number;
} {
  if (body === undefined) return {};
  if (body.length <= MESSAGE_TRUNCATE_AT) return { message: body };
  return {
    message: body.slice(0, MESSAGE_TRUNCATE_AT),
    messageTruncated: body.length - MESSAGE_TRUNCATE_AT,
  };
}

/**
 * Normalize one polled message. Callers filter the connection-level `open` /
 * `keepalive` frames out before shaping, so the narrower `MessageEvent` holds.
 */
export function shapeMessage(raw: NtfyMessage): ShapedNtfyMessage {
  const truncation = truncateMessage(raw.message);
  return {
    id: raw.id,
    time: new Date(raw.time * 1000).toISOString(),
    event: raw.event as MessageEvent,
    topic: raw.topic,
    expires: raw.expires !== undefined ? new Date(raw.expires * 1000).toISOString() : undefined,
    sequence_id: raw.sequence_id,
    title: raw.title,
    message: truncation.message,
    messageTruncated: truncation.messageTruncated,
    priority: raw.priority,
    tags: raw.tags,
    click: raw.click,
    actions: raw.actions,
    attachment: raw.attachment,
  };
}
