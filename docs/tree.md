# ntfy-mcp-server - Directory Structure

Generated on: 2026-05-31 03:45:35

```text
ntfy-mcp-server/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   └── FUNDING.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 1.0.x/
│   ├── 2.0.x/
│   ├── 2.1.x/
│   └── template.md
├── docs/
│   ├── ntfy/
│   │   ├── subscribe/
│   │   │   └── api.md
│   │   ├── emojis.md
│   │   ├── examples.md
│   │   ├── index.md
│   │   ├── publish.md
│   │   └── SOURCES.md
│   └── design.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build-emoji-tags.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── ntfy-topic.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── ntfy-fetch-messages.tool.ts
│   │           ├── ntfy-manage-message.tool.ts
│   │           ├── ntfy-publish-message.tool.ts
│   │           └── ntfy-search-emoji-tags.tool.ts
│   ├── services/
│   │   ├── emoji-tags/
│   │   │   ├── data.generated.ts
│   │   │   └── emoji-tag-service.ts
│   │   └── ntfy/
│   │       ├── error-classifier.ts
│   │       ├── ntfy-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── resources/
│   │   └── ntfy-topic.resource.test.ts
│   ├── services/
│   │   ├── ntfy/
│   │   │   ├── error-classifier.test.ts
│   │   │   └── ntfy-service.test.ts
│   │   └── emoji-tag-service.test.ts
│   └── tools/
│       ├── ntfy-fetch-messages.tool.test.ts
│       ├── ntfy-manage-message.tool.test.ts
│       ├── ntfy-publish-message.tool.test.ts
│       └── ntfy-search-emoji-tags.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
