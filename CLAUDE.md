# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project implements a natural language voice interface between Apple Watch and Home Assistant using Claude and the Model Context Protocol (MCP).

**Architecture:**
```
Apple Watch → Siri Shortcut → Middleware API → Claude + MCP → Home Assistant
                    ↑                                              ↓
                    └──────────── Response spoken ←────────────────┘
```

## Current State

The project is in the planning phase. See `apple-watch-home-assistant-mcp-plan.md` for the complete implementation plan.

## Implementation Options

Two middleware implementations are planned:

### Node.js (Recommended)
- Express server with `@anthropic-ai/sdk`
- Run: `npm start` or `node src/index.js`
- Dependencies: express, @anthropic-ai/sdk, dotenv

### Python (Alternative)
- FastAPI with `anthropic` SDK
- Run: `python main.py` or `uvicorn main:app`
- Dependencies: fastapi, uvicorn, anthropic, httpx, python-dotenv

## Required Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
HA_URL=http://homeassistant.local:8123
HA_TOKEN=your_long_lived_access_token
PORT=3000
API_KEY=your_secret_middleware_key
```

## Key Components

- **Voice Input**: Apple Watch + Siri Shortcuts
- **Middleware**: HTTP API that bridges Siri and Claude
- **Intelligence**: Claude API with tool use for HA control
- **Home Control**: Home Assistant REST API (requires MCP Server integration enabled in HA 2025.2+)

## Testing the API

```bash
# Test middleware
curl -X POST "http://localhost:3000/voice" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "What lights are on?"}'
```
