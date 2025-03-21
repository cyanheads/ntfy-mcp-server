# ntfy-mcp-server - Directory Structure

Generated on: 2025-03-21 09:04:38


```
ntfy-mcp-server
├── docs
    └── tree.md
├── logs
├── scripts
    ├── clean.ts
    └── tree.ts
├── src
    ├── config
    │   ├── envConfig.ts
    │   ├── index.ts
    │   ├── mcpConfig.ts
    │   └── README.md
    ├── mcp-server
    │   ├── resources
    │   │   └── echoResource
    │   │   │   ├── getEchoMessage.ts
    │   │   │   ├── index.ts
    │   │   │   ├── README.md
    │   │   │   └── types.ts
    │   ├── tools
    │   │   ├── echoTool
    │   │   │   ├── echoMessage.ts
    │   │   │   ├── index.ts
    │   │   │   ├── README.md
    │   │   │   └── types.ts
    │   │   └── ntfyTool
    │   │   │   ├── index.ts
    │   │   │   ├── ntfyMessage.ts
    │   │   │   └── types.ts
    │   ├── utils
    │   │   ├── README.md
    │   │   └── registrationHelper.ts
    │   ├── README.md
    │   └── server.ts
    ├── services
    │   └── ntfy
    │   │   ├── constants.ts
    │   │   ├── errors.ts
    │   │   ├── index.ts
    │   │   ├── publisher.ts
    │   │   ├── README.md
    │   │   ├── subscriber.ts
    │   │   ├── types.ts
    │   │   └── utils.ts
    ├── types-global
    │   ├── errors.ts
    │   ├── mcp.ts
    │   ├── README.md
    │   └── tool.ts
    ├── utils
    │   ├── errorHandler.ts
    │   ├── idGenerator.ts
    │   ├── index.ts
    │   ├── logger.ts
    │   ├── rateLimiter.ts
    │   ├── README.md
    │   ├── requestContext.ts
    │   ├── sanitization.ts
    │   └── security.ts
    └── index.ts
├── .clinerules
├── .clinerules-code
├── LICENSE
├── package-lock.json
├── package.json
├── README.md
├── tsconfig.json
└── tsconfig.scripts.json

```

_Note: This tree excludes files and directories matched by .gitignore and common patterns like node_modules._
