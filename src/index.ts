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
  name: 'ntfy-mcp-server',
  title: 'ntfy-mcp-server',
  tools: [ntfyPublishMessage, ntfyManageMessage, ntfyFetchMessages, ntfySearchEmojiTags],
  resources: [ntfyTopicResource],
  // The consent gate in `confirmAction` is a multi-round-trip `ctx.requestInput`
  // flow, which a 2025-era HTTP client can only answer over a live session — so a
  // stateless HTTP start is refused at boot rather than breaking the gate.
  sessionMode: { default: 'stateful', require: 'stateful' },
  instructions:
    'The ntfy_* tools publish and manage push notifications on ntfy, a pub/sub service where messages live on topics (arbitrary string channels) and a topic name works as an access token, so treat it as a secret. Send with `ntfy_publish_message` (look up `tags` short codes with `ntfy_search_emoji_tags`), poll cached history with `ntfy_fetch_messages`, and clear or delete a notification with `ntfy_manage_message`. Each published message gets a server-assigned `id`; pass it back as `sequence_id` to update, replace, clear, or delete that message later.',
  setup() {
    initEmojiTagService();
    initNtfyService(getServerConfig());
  },
});
