/**
 * @fileoverview `ntfy_search_emoji_tags` — substring search across the bundled
 * ntfy emoji short-code reference. Returns tag → emoji rows the agent can plug
 * into `ntfy_publish_message`'s `tags` field.
 * @module mcp-server/tools/definitions/ntfy-search-emoji-tags.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { getEmojiTagService } from '@/services/emoji-tags/emoji-tag-service.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const InputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Substring to match against emoji tag names (case-insensitive). Omit to browse the curated default set.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe('Maximum number of matches to return. Default 25, max 200.'),
});

const OutputSchema = z.object({
  matches: z
    .array(
      z
        .object({
          tag: z
            .string()
            .describe(
              "Emoji short code — pass this verbatim in `ntfy_publish_message`'s `tags` field.",
            ),
          emoji: z.string().describe('Rendered Unicode emoji.'),
        })
        .describe('A single tag → emoji pairing.'),
    )
    .describe('Tag → emoji rows in the order they appear in the upstream reference.'),
  total: z.number().describe('Total matches before truncation.'),
  truncated: z.boolean().describe('True when more matches existed than `limit` allowed.'),
});

export const ntfySearchEmojiTags = tool('ntfy_search_emoji_tags', {
  description:
    "Look up ntfy emoji tag short codes. Use the returned `tag` strings in `ntfy_publish_message`'s `tags` field to render emojis on the recipient's device. Without a query, returns the first slice of the full reference; pass a substring (e.g., `warning`, `tada`, `cd`) to filter.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: InputSchema,
  output: OutputSchema,

  handler(input) {
    return getEmojiTagService().search(input.query, input.limit);
  },

  format(result) {
    if (result.matches.length === 0) {
      return [
        {
          type: 'text',
          text: `No emoji tags matched (total: ${result.total}, truncated: ${result.truncated}).`,
        },
      ];
    }
    const header = '| Tag | Emoji |\n|:----|:------|';
    const rows = result.matches.map((m) => `| \`${m.tag}\` | ${m.emoji} |`);
    const footer = `\n_${result.total} total match${result.total === 1 ? '' : 'es'} (truncated: ${result.truncated})._`;
    return [{ type: 'text', text: `${header}\n${rows.join('\n')}${footer}` }];
  },
});
