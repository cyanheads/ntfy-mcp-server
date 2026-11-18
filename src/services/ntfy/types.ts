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
  /** Icon URL the publisher set; absent when none was set. */
  icon?: string;
  id: string;
  message?: string;
  priority?: Priority;
  sequence_id?: string;
  tags?: string[];
  time: number;
  title?: string;
  topic: string;
}

/** An action button as a poll returns it: the published action plus the ID ntfy assigned it. */
export type NtfyActionReadback = NtfyAction & { id?: string };

/**
 * Single line from a `<topic>/json?poll=1` response. The `event` set is wider
 * than `NtfyPublishResponse` because polls can include clear / delete / poll
 * markers in addition to plain messages.
 */
export interface NtfyMessage {
  actions?: NtfyActionReadback[];
  attachment?: NtfyAttachment;
  click?: string;
  /** `text/markdown` when the body was published as Markdown; absent for plain text. */
  content_type?: string;
  /**
   * `base64` when the stored body was not UTF-8 text (a UnifiedPush publish of
   * binary data), so `message` holds the base64 of those bytes; absent for text.
   */
  encoding?: string;
  event: MessageEvent | 'open' | 'keepalive';
  expires?: number;
  /** Icon URL the publisher set; absent when none was set. */
  icon?: string;
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
  /** IANA zone a natural-language `delay` is read in; ntfy ignores it without `delay`. */
  timezone?: string | undefined;
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
   * ntfy's clock when it answered, in Unix seconds, read from the response's
   * `Date` header; absent when the header is missing or unparseable.
   */
  ntfyClockSeconds?: number | undefined;
  /**
   * ntfy answered with `X-Messages-Truncated: 1`: the replay exceeded its
   * per-topic poll size cap, so it kept only the newest messages and dropped
   * the older ones before responding.
   */
  upstreamTruncated: boolean;
}

/**
 * Where a poll's window opens when ntfy reads its `since` as a message ID —
 * after that message — or as Unix seconds — at that second.
 */
export type WindowStart = { kind: 'id'; id: string } | { kind: 'time'; seconds: number };

/** How long `NtfyService.waitForMessage` holds ntfy's stream open, beside the per-call options. */
export interface NtfyWaitOptions extends NtfyCallOptions {
  /** Milliseconds from the call to `waitForMessage` until the wait ends with nothing. */
  holdMs: number;
  /**
   * Where the poll's window opened, when its `since` named a message or a time.
   * ntfy re-sends a message it wrote in the last second to every stream that
   * subscribed after the message went out, applying the stream's filters but
   * not its `since`, so the stream can deliver the marker message itself or a
   * row timed before the window; the wait skips such a row and goes on.
   * Omitted under a duration or a keyword: a message re-sent this way went out
   * within the last two seconds, inside any duration's window longer than that,
   * and `all` and `latest` take it in.
   */
  windowStart?: WindowStart | undefined;
}

/**
 * How one wait for the next message ended. `waitedMs` runs on this server's
 * clock from the start of the wait to its end.
 */
export type NtfyWaitResult =
  | {
      outcome: 'arrived';
      /** The first envelope the stream delivered other than `open`, `keepalive`, and a row before `windowStart`. */
      message: NtfyMessage;
      /**
       * The latest ntfy's clock can have read when the message arrived, in Unix
       * seconds: the stream's `open` line `time` (whole seconds) plus one, plus
       * the time since that line arrived; this server's clock when ntfy sent no
       * `open` line first.
       */
      ntfyClockSeconds: number;
      waitedMs: number;
    }
  | { outcome: 'timedOut'; waitedMs: number }
  | {
      outcome: 'failed';
      /** What refused or broke the stream, as plain text that names no topic. */
      cause: string;
      /** 0 when the stream never opened. */
      waitedMs: number;
    }
  /** This process already holds its most waits open, so no stream was requested. */
  | { outcome: 'busy' };

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

/**
 * The rate-limit policies one ntfy response reported in its `RateLimit-Policy`
 * and `RateLimit` headers (ntfy v2.37.0+). A policy is present only when the
 * response carried all three of its numbers; an absent key was not reported,
 * never zero.
 */
export interface NtfyQuota {
  /** Daily message allowance: `limit` = q, `remaining` = r, `resetsInSeconds` = t (until the visitor's 24-hour period ends). */
  messages?: { limit: number; remaining: number; resetsInSeconds: number };
  /** Request bucket: `limit` = q, `remaining` = r, `nextRequestInSeconds` = t (until one more request is available). */
  requests?: { limit: number; remaining: number; nextRequestInSeconds: number };
}

/**
 * What a publish or a clear/delete returns: ntfy's reply envelope, and the
 * rate-limit policies the same response reported.
 */
export interface NtfyReply<T> {
  envelope: T;
  /** Absent when the response carried no policy (ntfy before v2.37.0, an exempt visitor). */
  quota?: NtfyQuota | undefined;
}
