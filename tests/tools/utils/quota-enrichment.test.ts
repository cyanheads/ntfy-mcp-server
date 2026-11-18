/**
 * @fileoverview Tests for the `quota` enrichment at its own seam — the
 * `content[]` trailer line `renderQuota` builds from whichever policies ntfy
 * reported, carrying every number `structuredContent` carries. The publish and
 * manage suites prove only their wiring.
 * @module tests/tools/utils/quota-enrichment
 */

import { describe, expect, it } from 'vitest';

import { renderQuota } from '@/mcp-server/tools/utils/quota-enrichment.js';

const MESSAGES = { limit: 250, remaining: 246, resetsInSeconds: 50750 };
const REQUESTS = { limit: 60, remaining: 58, nextRequestInSeconds: 1 };

describe('renderQuota', () => {
  it.each([
    [
      'both policies',
      { messages: MESSAGES, requests: REQUESTS },
      '**Quota:** messages 246 of 250 left, resets in 50750 s · requests 58 of 60 left, one more in 1 s',
    ],
    [
      'only the messages policy',
      { messages: MESSAGES },
      '**Quota:** messages 246 of 250 left, resets in 50750 s',
    ],
    [
      'only the requests policy',
      { requests: REQUESTS },
      '**Quota:** requests 58 of 60 left, one more in 1 s',
    ],
    [
      'a used-up allowance',
      { messages: { limit: 250, remaining: 0, resetsInSeconds: 0 } },
      '**Quota:** messages 0 of 250 left, resets in 0 s',
    ],
  ])('renders %s as one line naming each reported number', (_label, quota, line) => {
    expect(renderQuota(quota)).toBe(line);
  });
});
