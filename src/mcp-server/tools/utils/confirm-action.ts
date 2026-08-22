/**
 * @fileoverview Consent gate for tool calls whose side effects reach past the
 * conversation — a deleted notification, an outbound email, a phone call, an
 * HTTP request fired from someone's phone. Puts the decision in front of the
 * user via an MCP multi-round-trip input request instead of trusting a model
 * that may be working from injected instructions.
 * @module mcp-server/tools/utils/confirm-action
 */

import {
  type ContextInputs,
  type InputRequiredSpec,
  inputRequired,
  z,
} from '@cyanheads/mcp-ts-core';

/** Key the confirmation rides under in `inputRequests` / `ctx.inputs`. */
const CONSENT_KEY = 'confirm';

/**
 * - `confirmed` — the user accepted and the payload said so.
 * - `declined` — the user declined or cancelled, **or** accepted with a
 *   response that did not parse, **or** answered with a response of another
 *   kind. The payload is model-mediated, so an unreadable `confirm` is not
 *   consent.
 *
 * There is no "client cannot be asked" outcome. `ctx.requestInput` is present
 * on every transport and both protocol eras, so the gate always asks: a
 * 2026-07-28 client fulfils the request itself, and on a 2025-era session the
 * SDK's legacy shim issues a real `elicitation/create` round trip. A 2025-era
 * client that never declared the elicitation capability fails the call with an
 * error naming the missing capability — before the upstream request goes out.
 * The gate is fail-closed on every transport, Streamable HTTP included.
 */
export type ConfirmationOutcome = 'confirmed' | 'declined';

/** Deliberately one boolean — a consent prompt should not double as a form. */
const ConfirmationSchema = z.object({
  confirm: z.boolean().describe('True to carry out the action as described, false to cancel it.'),
});

/** The multi-round-trip surface `confirmAction` needs — a handler `ctx` satisfies it. */
interface ConfirmationContext {
  readonly inputs: ContextInputs;
  readonly requestInput: (spec: InputRequiredSpec) => never;
}

/**
 * Ask the user to confirm `message`, and report what they said.
 *
 * The first call unwinds the handler: `ctx.requestInput` throws the signal the
 * handler factory turns into an `input_required` result, and the client
 * re-invokes the tool with the same arguments once the user has answered. So
 * every caller must run this *before* the side effect, and everything above it
 * in the handler runs again on re-entry — keep that stretch free of side
 * effects of its own.
 *
 * No `requestState` rides the round. The gate's guarantee rests on the client
 * putting the prompt in front of a person and relaying the answer honestly —
 * a client willing to break that can fabricate an approval outright, so an
 * unsigned server-state echo would add ceremony and no protection.
 */
export function confirmAction(ctx: ConfirmationContext, message: string): ConfirmationOutcome {
  const view = ctx.inputs.view(CONSENT_KEY);

  if (view.kind === 'missing') {
    return ctx.requestInput({
      inputRequests: {
        [CONSENT_KEY]: inputRequired.elicit({ message, requestedSchema: ConfirmationSchema }),
      },
    });
  }

  // Declined, cancelled, or a sampling/roots response: a dead end, not a round
  // to retry — re-issuing a request the user already refused just burns the
  // round budget.
  if (view.kind !== 'elicit' || view.action !== 'accept') return 'declined';

  const answer = ctx.inputs.accepted(CONSENT_KEY, ConfirmationSchema);
  return answer?.confirm === true ? 'confirmed' : 'declined';
}
