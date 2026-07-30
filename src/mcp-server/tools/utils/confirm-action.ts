/**
 * @fileoverview Consent gate for tool calls whose side effects reach past the
 * conversation — a deleted notification, an outbound email, a phone call, an
 * HTTP request fired from someone's phone. Puts the decision in front of the
 * user via MCP elicitation instead of trusting a model that may be working
 * from injected instructions.
 * @module mcp-server/tools/utils/confirm-action
 */

import { type ElicitFn, z } from '@cyanheads/mcp-ts-core';

/**
 * - `confirmed` — the user accepted and the payload said so.
 * - `declined` — the user declined or cancelled, **or** accepted with a
 *   response that did not parse. The elicitation payload is model-mediated, so
 *   an unreadable `confirm` is not consent.
 * - `unsupported` — the client never advertised the elicitation capability, so
 *   there is nobody to ask. Every Streamable HTTP request lands here: the
 *   framework builds a fresh `McpServer` per request, so the capabilities from
 *   `initialize` are not visible at tool-call time
 *   (`cyanheads/mcp-ts-core#312`). Consent is a STDIO guarantee until that is
 *   fixed upstream.
 */
export type ConfirmationOutcome = 'confirmed' | 'declined' | 'unsupported';

/** Deliberately one boolean — a consent prompt should not double as a form. */
const ConfirmationSchema = z.object({
  confirm: z.boolean().describe('True to carry out the action as described, false to cancel it.'),
});

/** The elicitation surface `confirmAction` needs — a handler `ctx` satisfies it. */
interface ConfirmationContext {
  readonly elicit?: ElicitFn | undefined;
}

/**
 * Ask the user to confirm `message`. Callers decide what each outcome means for
 * their tool: `declined` must abort, while `unsupported` leaves the tool's
 * `destructiveHint` annotation as the only signal the client has — proceeding
 * there keeps clients without elicitation working exactly as before.
 *
 * A client that advertises elicitation and then errors fails the call: with the
 * gate armed, an unanswered prompt is not consent either.
 */
export async function confirmAction(
  ctx: ConfirmationContext,
  message: string,
): Promise<ConfirmationOutcome> {
  if (!ctx.elicit) return 'unsupported';

  const result = await ctx.elicit(message, ConfirmationSchema);
  if (result.action !== 'accept') return 'declined';

  const parsed = ConfirmationSchema.safeParse(result.content);
  return parsed.success && parsed.data.confirm ? 'confirmed' : 'declined';
}
