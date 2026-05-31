/**
 * @fileoverview `ntfy_search_emoji_tags` — substring search across the bundled
 * ntfy emoji short-code reference. Returns tag → emoji rows the agent can plug
 * into `ntfy_publish_message`'s `tags` field. The parsed query, true match
 * total, truncation flag, and empty-result guidance ride the `enrichment` block
 * so they reach both `structuredContent` and `content[]` without a `format()`
 * entry.
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
});

export const ntfySearchEmojiTags = tool('ntfy_search_emoji_tags', {
  description:
    "Look up ntfy emoji tag short codes. Use the returned `tag` strings in `ntfy_publish_message`'s `tags` field to render emojis on the recipient's device. Without a query, returns the first slice of the full reference; pass a substring (e.g., `warning`, `tada`, `cd`) to filter.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: InputSchema,
  output: OutputSchema,

  // Agent-facing success-path context — the parsed query, the true match total,
  // the truncation flag, and empty-result guidance. Merged into structuredContent
  // and mirrored into a content[] trailer; never authored into format().
  enrichment: {
    effectiveQuery: z
      .string()
      .optional()
      .describe('The query as the server parsed it; absent when browsing the default set.'),
    totalCount: z.number().describe('Total matches before truncation to `limit`.'),
    truncated: z.boolean().describe('True when more matches existed than `limit` allowed.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no tags matched — echoes the query and suggests a shorter substring or the default set.',
      ),
  },

  handler(input, ctx) {
    const { matches, total, truncated } = getEmojiTagService().search(input.query, input.limit);

    if (input.query) ctx.enrich.echo(input.query);
    ctx.enrich.total(total);
    ctx.enrich({ truncated });
    if (matches.length === 0) {
      ctx.enrich.notice(
        input.query
          ? `No emoji tags matched query \`${input.query}\`. Try a shorter substring or omit the query to browse the curated default set.`
          : 'The default reference is empty — this should not happen; report it.',
      );
    }

    return { matches };
  },

  format(result) {
    if (result.matches.length === 0) {
      return [{ type: 'text', text: 'No emoji tags matched.' }];
    }
    const header = '| Tag | Emoji |\n|:----|:------|';
    const rows = result.matches.map((m) => `| \`${m.tag}\` | ${m.emoji} |`);
    return [{ type: 'text', text: `${header}\n${rows.join('\n')}` }];
  },
});
