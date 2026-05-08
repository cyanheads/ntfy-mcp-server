#!/usr/bin/env node
/**
 * @fileoverview ntfy-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { echoResource } from './mcp-server/resources/definitions/echo.resource.js';
import { echoTool } from './mcp-server/tools/definitions/echo.tool.js';

await createApp({
  tools: [echoTool],
  resources: [echoResource],
});
