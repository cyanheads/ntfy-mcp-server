/**
 * @fileoverview Consent gate for tool calls whose side effects reach past the
 * conversation — a deleted notification, an outbound email, a phone call, an
 * HTTP request fired from someone's phone. Puts the decision in front of the
 * user via an MCP multi-round-trip input request instead of trusting a model
 * that may be working from injected instructions, and acts only on an answer
 * to a prompt this server recorded asking.
 * @module mcp-server/tools/utils/confirm-action
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  type AuthContext,
  type ContextInputs,
  type ContextState,
  type InputRequiredSpec,
  inputRequired,
  z,
} from '@cyanheads/mcp-ts-core';

/** Key the confirmation rides under in `inputRequests` / `ctx.inputs`. */
const CONSENT_KEY = 'confirm';

/** How long a prompt stays answerable, in seconds. */
const CONSENT_TTL_SECONDS = 600;

/** Shape of the ids this gate mints with `randomUUID()`; anything else names no record. */
const CONSENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * - `confirmed` — the round redeemed the record this server stored when it
 *   asked, the record names exactly what this call would do, and the user
 *   accepted with `confirm: true`.
 * - `declined` — against that same record, the user declined or cancelled,
 *   **or** accepted with a response that did not parse, **or** answered with a
 *   response of another kind. The payload is model-mediated, so an unreadable
 *   `confirm` is not consent.
 *
 * Every other round asks again. There is no "client cannot be asked" outcome:
 * `ctx.requestInput` is present on every transport and both protocol eras, and
 * a 2025-era client that declared no `elicitation.form` capability (a bare
 * `elicitation: {}` counts as declaring it) is refused inside
 * `ctx.requestInput` with `InvalidRequest` (-32600) and
 * `data.reason: 'client_capability_missing'` — so the call fails before the
 * upstream request goes out, on every transport.
 */
export type ConfirmationOutcome = 'confirmed' | 'declined';

/** What the user is asked to confirm, and what binds their answer to it. */
export interface ConsentRequest {
  /** Prompt text — names the exact target so the user knows what they approve. */
  readonly message: string;
  /** Tool name, plus the action where one tool performs several (`ntfy_manage_message:delete`). */
  readonly operation: string;
  /** The exact outbound request the prompt describes; only its hash is stored. */
  readonly request: unknown;
  /** What is acted on — the resolved ntfy base URL plus topic, and the message id for manage. */
  readonly target: string;
}

/** The multi-round-trip surface `confirmAction` needs — a handler `ctx` satisfies it. */
interface ConfirmationContext {
  readonly auth?: AuthContext | undefined;
  readonly inputs: ContextInputs;
  readonly requestInput: (spec: InputRequiredSpec) => never;
  readonly state: ContextState;
}

/** Deliberately one boolean — a consent prompt should not double as a form. */
const ConfirmationSchema = z.object({
  confirm: z.boolean().describe('True to carry out the action as described, false to cancel it.'),
});

/** What a prompt confirmed, stored under the id sent as `requestState`. */
const ConsentRecordSchema = z.object({
  operation: z.string().describe('Tool, plus action, the record was minted for.'),
  clientId: z.string().describe('Authenticated client that was asked; empty without auth.'),
  subject: z.string().describe('Authenticated subject that was asked; empty without auth.'),
  target: z.string().describe('ntfy base URL, topic, and message id the prompt named.'),
  contentHash: z.string().describe('SHA-256 of the outbound request the prompt described.'),
});

/** JSON with object keys sorted at every depth, so equal requests hash equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Ask the user to confirm `consent.message`, and report what they said.
 *
 * Every call first **redeems** the record named by the round's `requestState`:
 * reads it and deletes it, whatever happens next. The answer on `ctx.inputs`
 * counts only when that record equals what this call would confirm — the same
 * operation, the same authenticated caller, the same target, the same outbound
 * request. Any other round — no `requestState`, an unknown, spent, expired, or
 * malformed id, or a record minted for another operation, tool, caller,
 * target, or content — asks again under a fresh record, so an answer the
 * client sent unprompted, or one replayed from an earlier round, never
 * confirms anything. A refusal against a matching record is final.
 *
 * Asking unwinds the handler: `ctx.requestInput` throws the signal the handler
 * factory turns into an `input_required` result, and the client re-invokes the
 * tool with the same arguments once the user has answered. So every caller
 * must run this *before* the side effect, and everything above it in the
 * handler runs again on re-entry — keep that stretch free of side effects of
 * its own.
 *
 * The record lives in `ctx.state` (tenant-scoped) for `CONSENT_TTL_SECONDS`.
 * The default `in-memory` provider serves one process; a deployment where a
 * retry can reach another instance needs `STORAGE_PROVIDER_TYPE` set to
 * shared storage (`filesystem`, `supabase`, or `cloudflare-d1` — never the
 * eventually consistent `cloudflare-kv`), or the retry finds no record and
 * asks again.
 *
 * Residual risk: `ctx.state` has no atomic read-and-delete
 * (cyanheads/mcp-ts-core#593), so retries carrying one id at the same moment
 * can each read the record before either delete lands, and each proceed. ntfy
 * offers no idempotency handle to pin the action to the record id: a repeated
 * clear/delete emits one more `message_clear` / `message_delete` event and
 * leaves message state unchanged, but a repeated publish delivers again —
 * email, call, and buttons included. Sequential replays are refused.
 */
export async function confirmAction(
  ctx: ConfirmationContext,
  consent: ConsentRequest,
): Promise<ConfirmationOutcome> {
  const id = ctx.inputs.state<unknown>();
  const key = typeof id === 'string' && CONSENT_ID_PATTERN.test(id) ? `consent/${id}` : undefined;
  const record = key ? await ctx.state.get(key, ConsentRecordSchema) : null;
  if (key && record) await ctx.state.delete(key);

  const expected: z.infer<typeof ConsentRecordSchema> = {
    operation: consent.operation,
    clientId: ctx.auth?.clientId ?? '',
    subject: ctx.auth?.sub ?? '',
    target: consent.target,
    contentHash: createHash('sha256').update(canonicalJson(consent.request)).digest('hex'),
  };
  const view = ctx.inputs.view(CONSENT_KEY);

  if (record && isDeepStrictEqual(record, expected) && view.kind !== 'missing') {
    // Declined, cancelled, or a sampling/roots response: a dead end, not a
    // round to retry — re-issuing a request the user already refused just
    // burns the round budget.
    if (view.kind !== 'elicit' || view.action !== 'accept') return 'declined';
    return ctx.inputs.accepted(CONSENT_KEY, ConfirmationSchema)?.confirm === true
      ? 'confirmed'
      : 'declined';
  }

  const fresh = randomUUID();
  await ctx.state.set(`consent/${fresh}`, expected, { ttl: CONSENT_TTL_SECONDS });
  return ctx.requestInput({
    inputRequests: {
      [CONSENT_KEY]: inputRequired.elicit({
        message: consent.message,
        requestedSchema: ConfirmationSchema,
      }),
    },
    requestState: fresh,
  });
}
