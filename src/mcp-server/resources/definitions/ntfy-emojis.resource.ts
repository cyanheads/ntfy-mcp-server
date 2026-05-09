/**
 * @fileoverview `ntfy://emojis` — full ntfy emoji-tag reference rendered as
 * Markdown. Mirrors the data exposed via `ntfy_search_emoji_tags` for
 * tool-only clients that don't read resources.
 * @module mcp-server/resources/definitions/ntfy-emojis.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';

import { getEmojiTagService } from '@/services/emoji-tags/emoji-tag-service.js';

const ParamsSchema = z.object({});

export const ntfyEmojisResource = resource('ntfy://emojis', {
  name: 'ntfy-emoji-reference',
  description:
    'Full emoji tag → emoji reference, mirrored from upstream `docs/ntfy/emojis.md`. Use `ntfy_search_emoji_tags` from tool-only clients to query the same data with substring filters.',
  mimeType: 'text/markdown',
  params: ParamsSchema,

  handler() {
    const svc = getEmojiTagService();
    const all = svc.search(undefined, svc.size);
    const lines: string[] = [
      '# ntfy emoji tag reference',
      '',
      `Total tags: ${all.total}.`,
      '',
      '| Tag | Emoji |',
      '|:----|:------|',
      ...all.matches.map(({ tag, emoji }) => `| \`${tag}\` | ${emoji} |`),
      '',
    ];
    return lines.join('\n');
  },
});
