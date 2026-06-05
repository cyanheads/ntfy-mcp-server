/**
 * @fileoverview Shared ntfy message normalizer for tools/resources that expose
 * cached upstream messages to MCP clients.
 * @module mcp-server/utils/ntfy-message-shape
 */

import type {
  MessageEvent,
  NtfyAction,
  NtfyAttachment,
  NtfyMessage,
  Priority,
} from '@/services/ntfy/types.js';

export const MESSAGE_TRUNCATE_AT = 500;

export interface ShapedNtfyMessage {
  actions?: NtfyAction[] | undefined;
  attachment?: NtfyAttachment | undefined;
  click?: string | undefined;
  event: MessageEvent;
  expires?: string | undefined;
  id: string;
  message?: string | undefined;
  messageTruncated?: number | undefined;
  priority?: Priority | undefined;
  sequence_id?: string | undefined;
  tags?: string[] | undefined;
  time: string;
  title?: string | undefined;
  topic: string;
}

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

export function shapeNtfyMessage(raw: NtfyMessage): ShapedNtfyMessage {
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
