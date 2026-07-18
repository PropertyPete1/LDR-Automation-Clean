# Project TODO

## Engine Build (Data-Driven Agent Bot Engine)
- [x] Add agent_bots table to drizzle/schema.ts
- [x] Run migration SQL to create table in live DB
- [x] Seed agent_bots table with 8 rows (6 existing + Jason active)
- [x] Create server/botEngine.ts — generic engine
- [x] Add zero-overlap guard to all 6 existing bot files (N/A — structurally impossible: FUB API scopes by assignedUserId)
- [x] Wire engine endpoints in scheduledHandlers.ts and index.ts
- [x] Build intro email logic for data-driven agents
- [x] Add tRPC procedures for agent registry CRUD
- [x] Build Admin UI — Agent Registry page
- [x] TypeScript 0 errors
- [x] Write/update vitest tests (10/10 pass)
- [x] Push to GitHub (commit 42f1651)
- [x] Generate Jason intro email for user review

## Urgent Fixes (User-Required Before Heartbeat Re-enable)
- [x] Item 1: Confirm engineActive toggles (Jason=true, all others=false) + add legacy safeguard code + test
- [x] Item 2: Fix FUB user ID mappings (pull full FUB user list, correct Peter/Steven rows)
- [x] Item 3: Access control — route guard, tRPC rejection tests (11/11 pass), nav hide for non-admins, agent endpoint isolation
- [x] Item 4: Fix intro email year (dynamic via getFullYear()) + add origin story to LLM prompt + fallback copy
- [ ] Checkpoint + GitHub push
- [ ] Re-enable heartbeat ONLY after user approval
