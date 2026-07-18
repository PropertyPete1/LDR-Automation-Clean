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
- [ ] Push to GitHub
- [ ] Generate Jason intro email for user review
