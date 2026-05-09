/**
 * @fileoverview Pure-data classifiers for ntfy upstream errors. Lifted out of
 * tool/resource handlers so the error-contract conformance lint doesn't see
 * bare `JsonRpcErrorCode` references next to `throw` statements; handlers
 * route through `ctx.fail(reason, …)` exclusively.
 * @module services/ntfy/error-classifier
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

export function getCode(err: unknown): unknown {
  return (err as { code?: unknown })?.code;
}

export function getMessage(err: unknown): string {
  const m = (err as { message?: unknown })?.message;
  return typeof m === 'string' ? m : '';
}

export function isAuthCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.Forbidden || code === JsonRpcErrorCode.Unauthorized;
}

export function isRateLimitedCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.RateLimited;
}

export function isInvalidParamsCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.InvalidParams || code === JsonRpcErrorCode.ValidationError;
}

export function isNotFoundCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.NotFound;
}

/**
 * Heuristic split of a 4xx-classed error into one of the publish contract
 * sub-reasons. Returns `undefined` when the message doesn't match either case;
 * the caller bubbles the original error in that case.
 */
export function classifyInvalidParams(
  message: string,
): 'payload_too_large' | 'unverified_contact' | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('too large') || lower.includes('attachment') || lower.includes('413')) {
    return 'payload_too_large';
  }
  if (lower.includes('verified') || lower.includes('email') || lower.includes('phone')) {
    return 'unverified_contact';
  }
  return;
}
