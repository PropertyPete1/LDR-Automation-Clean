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
- [x] Checkpoint + GitHub push (ed35aac7 / commit 3cc76ee)
- [x] Re-enable heartbeat ONLY after user approval (resumed 2026-07-18)

## Bug Fixes (2026-07-19)
- [x] Bug 1: Lead-facing signature uses bot persona name instead of agent's real name — audit all paths, fix
- [x] Bug 2: Engine clock-in template shows hardcoded Steven/Peter dashboard buttons — make dynamic single-agent
- [x] Behavioral tests for both bugs (9/9 pass)
- [x] Deploy + sync to GitHub
- [x] Add true behavioral test: render sendLeadFollowUpEmail output and assert zero persona names
- [x] Add true behavioral test: render engine clock-in HTML for Jason and assert one /agent/jason link
- [ ] Save checkpoint + push to GitHub
