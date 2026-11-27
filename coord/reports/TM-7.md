# TM-7 report
Status: done
Branch: tm/TM-7   Commit: 345039c
Files: agent-runner/src/jobs.ts (+2/-2), agent-runner/README.md (+2/-1), agent-runner/test/tm7_jobs_openai.test.ts (new)
Verify: vitest 355 passed (12 files); tsc --noEmit clean; npm run build clean
Decisions:
- BACKENDS now includes "api-openai". The error text lists all five: claude|codex|gemini|api|api-openai.
- README: one line on the api-openai backend (OPENAI_API_KEY, optional OPENAI_MODEL, public https MCP URL). The jobs.json table's backend row also lists api-openai, so the two don't contradict each other.
- `--once` routing to runOpenAiTask is tested with vi.mock("../src/openai.js"), with no network.
- No existing test pinned the old 4-backend error text.
developers: 1 sonnet, fix rounds: 0
