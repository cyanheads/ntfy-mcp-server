/**
 * @fileoverview Tests for the MCPB agent-doc selector shared by
 * `scripts/clean-mcpb.ts` (the strip step) and `scripts/lint-packaging.ts`
 * (the post-bundle check): runtime `skills/` modules nested inside a package
 * survive, package-root agent trees and `SKILL.md` files are selected, and the
 * two copies of `AGENT_DOC_ENTRY` select the same entries.
 * @module tests/scripts/clean-mcpb
 */

import { describe, expect, it } from 'vitest';

import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * `lint-packaging.ts` ends with a fallback import that resolves only inside the
 * framework's own repository (cyanheads/mcp-ts-core#797). Loading it by URL at
 * run time keeps it out of this project's typecheck program.
 */
const lintPackaging: {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
} = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@scope/parent/node_modules/child/lib/skills/loader.js',
  'node_modules/feature/dist/skills/worker.js',
  'node_modules/skills/index.js',
  'node_modules/@scope/skills/index.js',
  'skills/ntfy-guide/SKILL.md',
  'dist/index.js',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/example/skills/guide/SKILL.md',
  'node_modules/example/skills/guide/references/topics.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/parent/node_modules/@scope/child/skills/guide/references/query.md',
  'node_modules/@scope/parent/node_modules/child/.claude/settings.json',
  'node_modules/example/.agents/skills/guide/SKILL.md',
  'node_modules/example/docs/SKILL.md',
];

describe('MCPB agent-doc selector', () => {
  it('keeps runtime skills/ modules nested inside a package', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
    expect(lintPackaging.checkBundleEntries(RUNTIME_ENTRIES, 'fixture.mcpb')).toEqual([]);
  });

  it('selects package-root agent trees and SKILL.md files', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
    expect(lintPackaging.checkBundleEntries(AGENT_DOC_ENTRIES, 'fixture.mcpb')).toEqual([
      expect.stringContaining(
        `contains ${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`,
      ),
    ]);
  });

  it('is the same pattern in the cleaner and the packaging check', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });
});
