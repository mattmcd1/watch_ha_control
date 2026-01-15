# Repository Guidelines

## Overview
This repository is an implementation plan (and eventual code) for controlling Home Assistant from Apple Watch voice input via Siri Shortcuts, a small middleware API, and Claude tool use over the Home Assistant MCP Server. The main references today are:

- `apple-watch-home-assistant-mcp-plan.md`: end-to-end plan, architecture, and reference snippets
- `CLAUDE.md`: quick commands, env vars, and agent notes

## Project Structure & Module Organization
Current repo contents are documentation-only. When adding implementation code, keep it organized and easy to run locally:

- `middleware/node/`: Express-based service (planned `src/index.js`, `src/claude.js`, `src/homeassistant.js`, `src/tools.js`)
- `middleware/python/`: FastAPI-based service (planned `main.py` plus supporting modules)
- `shortcuts/`: exported Siri Shortcut files and setup notes (if added)
- `docs/`: additional diagrams/how-tos beyond the plan (if added)

## Build, Test, and Development Commands
Planned local commands (adjust to actual folder names once implemented):

- Node: `npm install` then `npm start` (or `node src/index.js`)
- Python: `python -m venv .venv && source .venv/bin/activate` then `pip install -r requirements.txt` and `uvicorn main:app --reload`
- Manual API check: `curl -X POST http://localhost:3000/voice -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"text":"What lights are on?"}'`

## Coding Style & Naming Conventions
- JavaScript/TypeScript: 2-space indentation, ESM modules, clear file boundaries (`claude`, `homeassistant`, `tools`)
- Python: 4-space indentation, type hints where practical, keep I/O at the edges
- Configuration: read secrets from environment variables; never hardcode tokens/URLs

## Testing Guidelines
No test suite is committed yet. If you add tests, prefer fast unit tests around:
- request auth (`API_KEY`) and input validation
- Home Assistant client behavior (mock HTTP/MCP calls; no real HA/Anthropic calls in CI)
Suggested naming: `*.test.js` (Node) or `tests/test_*.py` (Python).

## Commit & Pull Request Guidelines
Git history may not be present in all environments; use Conventional Commits:
- Example: `feat(middleware): add /voice endpoint` or `docs: clarify HA MCP setup`
PRs should include a short description, local test steps, and any Shortcut/UI screenshots when relevant.

## Security & Configuration Tips
- Do not commit `.env` files or access tokens; add `.env.example` when introducing new variables.
- Keep exposed Home Assistant entities minimal (Settings → Voice Assistants → Expose Entities).
