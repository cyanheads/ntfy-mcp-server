/**
 * @fileoverview Shared types for the ntfy upstream — action discriminated
 * union, message envelope, attachment, and request/response shapes used by
 * `NtfyService`. Mirrors the upstream JSON formats documented in
 * `docs/ntfy/publish.md` and `docs/ntfy/subscribe/api.md`.
 * @module services/ntfy/types
 */

export type Priority = 1 | 2 | 3 | 4 | 5;

export type MessageEvent = 'message' | 'message_clear' | 'message_delete' | 'poll_request';

export interface NtfyAttachment {
  expires?: number;
  name: string;
  size?: number;
  type?: string;
  url: string;
}

export interface ViewAction {
  action: 'view';
  clear?: boolean;
  label: string;
  url: string;
}

export interface BroadcastAction {
  action: 'broadcast';
  clear?: boolean;
  extras?: Record<string, string>;
  intent?: string;
  label: string;
}

export interface HttpAction {
  action: 'http';
  body?: string;
  clear?: boolean;
  headers?: Record<string, string>;
  label: string;
  method?: string;
  url: string;
}

export interface CopyAction {
  action: 'copy';
  clear?: boolean;
  label: string;
  value: string;
}

export type NtfyAction = ViewAction | BroadcastAction | HttpAction | CopyAction;

/** Shape returned by the upstream `POST /` publish call. */
export interface NtfyPublishResponse {
  actions?: NtfyAction[];
  attachment?: NtfyAttachment;
  click?: string;
  /** `text/markdown` when the body was published as Markdown; absent for plain text. */
  content_type?: string;
  expires?: number;
  id: string;
  message?: string;
  priority?: Priority;
  scheduled?: boolean;
  sequence_id?: string;
  tags?: string[];
  time: number;
  title?: string;
  topic: string;
}

/**
 * Single line from a `<topic>/json?poll=1` response. The `event` set is wider
 * than `NtfyPublishResponse` because polls can include clear / delete / poll
 * markers in addition to plain messages.
 */
export interface NtfyMessage {
  actions?: NtfyAction[];
  attachment?: NtfyAttachment;
  click?: string;
  /** `text/markdown` when the body was published as Markdown; absent for plain text. */
  content_type?: string;
  event: MessageEvent | 'open' | 'keepalive';
  expires?: number;
  id: string;
  message?: string;
  priority?: Priority;
  sequence_id?: string;
  tags?: string[];
  time: number;
  title?: string;
  topic: string;
}

export interface NtfyPublishRequest {
  actions?: NtfyAction[] | undefined;
  attach?: string | undefined;
  /** When `false`, `X-Cache: no` is sent as a header (not a body field). */
  cache?: boolean | undefined;
  call?: string | undefined;
  click?: string | undefined;
  delay?: string | undefined;
  email?: string | undefined;
  filename?: string | undefined;
  /** When `false`, `X-Firebase: no` is sent as a header (not a body field). */
  firebase?: boolean | undefined;
  icon?: string | undefined;
  markdown?: boolean | undefined;
  message?: string | undefined;
  priority?: Priority | undefined;
  sequence_id?: string | undefined;
  tags?: string[] | undefined;
  title?: string | undefined;
  topic: string;
}

export interface NtfyFetchParams {
  id?: string | undefined;
  message?: string | undefined;
  priority?: Priority[] | undefined;
  scheduled?: boolean | undefined;
  since?: string | undefined;
  tags?: string[] | undefined;
  title?: string | undefined;
  /** One topic or comma-separated list. */
  topic: string;
}

/** What one `<topic>/json?poll=1` round trip yields. */
export interface NtfyFetchResult {
  /** Every envelope in the poll body, oldest-first, `open` / `keepalive` frames included. */
  messages: NtfyMessage[];
  /**
   * ntfy answered with `X-Messages-Truncated: 1`: the replay exceeded its
   * per-topic poll size cap, so it kept only the newest messages and dropped
   * the older ones before responding.
   */
  upstreamTruncated: boolean;
}

export type ManageOperation = 'clear' | 'delete';

export interface NtfyManageResponse {
  event: 'message_clear' | 'message_delete';
  id: string;
  sequence_id: string;
  time: number;
  topic: string;
}

export interface NtfyCallOptions {
  /**
   * Per-call override of the configured base URL. When it matches no
   * registered server (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry), configured
   * auth credentials are not forwarded — see the design doc for rationale.
   */
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
}
