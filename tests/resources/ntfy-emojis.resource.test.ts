/**
 * @fileoverview Tests for the `ntfy://emojis` resource — verifies the full
 * emoji table renders as Markdown.
 * @module tests/resources/ntfy-emojis.resource
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ntfyEmojisResource } from '@/mcp-server/resources/definitions/ntfy-emojis.resource.js';
import {
  initEmojiTagService,
  resetEmojiTagService,
} from '@/services/emoji-tags/emoji-tag-service.js';

describe('ntfyEmojisResource handler', () => {
  beforeEach(() => {
    resetEmojiTagService();
    initEmojiTagService();
  });
  afterEach(() => {
    resetEmojiTagService();
  });

  it('renders the full reference as Markdown', async () => {
    const ctx = createMockContext({ uri: new URL('ntfy://emojis') });
    const md = (await ntfyEmojisResource.handler({}, ctx)) as string;
    expect(md).toContain('# ntfy emoji tag reference');
    expect(md).toContain('| Tag | Emoji |');
    expect(md).toContain('| `warning` |');
    // Sanity-check the table actually has a substantial number of rows.
    const rows = md.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows.length).toBeGreaterThan(1000);
  });
});
