/**
 * @fileoverview The `quota` enrichment field `ntfy_publish_message` and
 * `ntfy_manage_message` report: the rate-limit policies ntfy's reply carried
 * (`NtfyReply.quota`), declared once for both tools' `enrichment` blocks, with
 * the `content[]` trailer line that carries the same numbers.
 * @module mcp-server/tools/utils/quota-enrichment
 */

import { z } from '@cyanheads/mcp-ts-core';

import type { NtfyQuota } from '@/services/ntfy/types.js';

const count = () => z.number().int().min(0);

/** The `quota` enrichment field; a tool enriches it only when ntfy reported a policy. */
export const quotaEnrichment = z
  .object({
    messages: z
      .object({
        limit: count().describe('Messages allowed per 24-hour period.'),
        remaining: count().describe('Messages left in the current period after this call.'),
        resetsInSeconds: count().describe(
          'Seconds until the current 24-hour period ends and `remaining` is back to `limit`.',
        ),
      })
      .optional()
      .describe(
        "ntfy's daily message allowance, which every publish, update, clear, and delete counts against. Absent when ntfy did not report it.",
      ),
    requests: z
      .object({
        limit: count().describe('Requests the burst holds when full.'),
        remaining: count().describe('Requests left in the burst after this call.'),
        nextRequestInSeconds: count().describe('Seconds until the burst gains one more request.'),
      })
      .optional()
      .describe(
        "ntfy's request burst, which refills one request at a time. Absent when ntfy did not report it.",
      ),
  })
  .optional()
  .describe(
    "The rate limits ntfy reported on this call's response (ntfy v2.37.0 and later), to plan further calls against what is left. Absent when ntfy reported none, as an older ntfy or a sender exempt from its limits does.",
  );

/** The trailer line: each reported policy with all three of its numbers. */
export function renderQuota(quota: NtfyQuota): string {
  const { messages, requests } = quota;
  const parts: string[] = [];
  if (messages) {
    parts.push(
      `messages ${messages.remaining} of ${messages.limit} left, resets in ${messages.resetsInSeconds} s`,
    );
  }
  if (requests) {
    parts.push(
      `requests ${requests.remaining} of ${requests.limit} left, one more in ${requests.nextRequestInSeconds} s`,
    );
  }
  return `**Quota:** ${parts.join(' · ')}`;
}
