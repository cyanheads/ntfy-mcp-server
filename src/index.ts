#!/usr/bin/env node
/**
 * @fileoverview ntfy-mcp-server entry point. Registers the four ntfy tools
 * and the topic-snapshot resource, and initializes the `EmojiTagService` and
 * `NtfyService` inside `setup()` so the framework's startup banner reports
 * a clean state.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';

import { getServerConfig } from '@/config/server-config.js';
import { ntfyTopicResource } from '@/mcp-server/resources/definitions/ntfy-topic.resource.js';
import { ntfyFetchMessages } from '@/mcp-server/tools/definitions/ntfy-fetch-messages.tool.js';
import { ntfyManageMessage } from '@/mcp-server/tools/definitions/ntfy-manage-message.tool.js';
import { ntfyPublishMessage } from '@/mcp-server/tools/definitions/ntfy-publish-message.tool.js';
import { ntfySearchEmojiTags } from '@/mcp-server/tools/definitions/ntfy-search-emoji-tags.tool.js';
import { initEmojiTagService } from '@/services/emoji-tags/emoji-tag-service.js';
import { initNtfyService } from '@/services/ntfy/ntfy-service.js';

await createApp({
  tools: [ntfyPublishMessage, ntfyManageMessage, ntfyFetchMessages, ntfySearchEmojiTags],
  resources: [ntfyTopicResource],
  setup() {
    initEmojiTagService();
    initNtfyService(getServerConfig());
  },
});
