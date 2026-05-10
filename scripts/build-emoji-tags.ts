/**
 * @fileoverview Build script — parses `docs/ntfy/emojis.md` and emits a
 * TypeScript module with the full `tag → emoji` table consumed by
 * `EmojiTagService`. Run via `bun run scripts/build-emoji-tags.ts`.
 *
 * Re-run when `docs/ntfy/emojis.md` is refreshed (see `docs/ntfy/SOURCES.md`).
 * @module scripts/build-emoji-tags
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../docs/ntfy/emojis.md');
const OUT = resolve(__dirname, '../src/services/emoji-tags/data.generated.ts');

const ROW_RE = /<tr><td[^>]*><code>([^<]+)<\/code><\/td><td[^>]*>([^<]+)<\/td><\/tr>/g;

const html = readFileSync(SRC, 'utf-8');
const seen = new Set<string>();
const rows: Array<[string, string]> = [];

for (const match of html.matchAll(ROW_RE)) {
  const tag = match[1]?.trim();
  const emoji = match[2]?.trim();
  if (!tag || !emoji || seen.has(tag)) continue;
  seen.add(tag);
  rows.push([tag, emoji]);
}

if (rows.length === 0) {
  console.error(`No emoji rows extracted from ${SRC}.`);
  process.exit(1);
}

const lines = [
  '/**',
  ' * @fileoverview Generated emoji tag table — DO NOT EDIT BY HAND.',
  ' * Regenerate with `bun run scripts/build-emoji-tags.ts` after refreshing',
  ' * `docs/ntfy/emojis.md`.',
  ' * @module services/emoji-tags/data.generated',
  ' */',
  '',
  `export const EMOJI_TAGS: ReadonlyArray<readonly [string, string]> = [`,
  ...rows.map(([tag, emoji]) => `  [${JSON.stringify(tag)}, ${JSON.stringify(emoji)}],`),
  '];',
  '',
];

writeFileSync(OUT, lines.join('\n'), 'utf-8');
console.log(`Wrote ${rows.length} emoji tags → ${OUT}`);
