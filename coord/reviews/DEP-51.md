# DEP-51 review: @google/genai 3.3.0 -> 3.6.1 (agent-runner)

Verdict: APPROVE
Head SHA: 77830ecead87ccfe2714dee0c05df72dc73109ae
CI: 4/4 pass (agent-runner, bt-service, deploy, trade-mcp)

## Changes
- Only @google/genai moves, 3.3.0 -> 3.6.1 (minor). Files: agent-runner/package.json and package-lock.json.
- package.json: the dependency is pinned exactly ("3.3.0" -> "3.6.1"), as it already was. Nothing loosened (no ^ or ~).
- Lockfile diff: only the @google/genai version, resolved URL (registry.npmjs.org) and integrity hash. No new or removed dependencies, no new registries.

## Upstream release notes (3.4.0, 3.5.0, 3.6.0, 3.6.1)
- 3.4.0: Interactions SDK additions (tool search, file processing options), embedding batch inputs, release-import fix.
- 3.5.0: experimental Live Interactions, environments (BYOS), fix returning GenerateContentResponse instances for batch inlined responses.
- 3.6.0: tool retrieval and function result schemas.
- 3.6.1: enum update.
- No breaking changes, deprecations or security fixes listed.

## Repo usage
agent-runner/src/gemini.ts uses GoogleGenAI, mcpToTool, CallableTool, and client.models.generateContent with automatic function calling. None of these appear in the changelog entries above.

## Local verification (scratch clone at PR head)
- npm ci: ok
- npx vitest run: 851/851 passed
- npx tsc --noEmit: exit 0
