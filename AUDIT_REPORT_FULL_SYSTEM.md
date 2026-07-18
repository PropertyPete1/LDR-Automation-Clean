# Full-System Audit — LDR Automation (incremental)

**Auditor:** Claude (independent auditor) · **Updated:** 2026-07-18
**Status:** Part 0 complete. Parts 1–4 in progress; file updated after each part.

---

# ENGINE LAUNCH: **GO** — the one launch defect (intro email wired to the retired Forge LLM) is fixed in `94927a3`; the lead-facing pipeline was already correct and is now behaviorally tested end-to-end, **conditional on deploying current main to the Manus project before 10:00 AM CT and registering the engine heartbeat crons** (human steps, checklist below).

---

## Part 0 — Agent Bot Engine (launches 10:00 AM CT) — 9.5/10 after fixes

| Item | Verdict | Detail |
|---|---|---|
| 0a Legacy safeguard | **PASS** | Double guard: `getActiveEngineAgents()` filters `LEGACY_BOT_SLUGS` ([botEngine.ts:74-80](lifestyle-bot-dashboard/server/botEngine.ts)); `runEngineForAgent()` throws BLOCKED before any DB read (line 102). Manus's `botEngine.test.ts` already covers the tiffany-engineActive=true case (mocked DB → filtered out) and all legacy slugs; my snapshot-consistency test adds: exactly one active row (jason, fubUserId 37) and every other snapshot slug ⊆ LEGACY_BOT_SLUGS. No snapshot/schema drift: snapshot fields are a subset of `agent_bots` schema columns. |
| 0b Zero-overlap | **PASS (by inspection + test)** | Legacy hardcoded files run {sp500_peter, sp500_steven, tiffany, stefanie, abby, irma, laila}; engine active set = {jason}; disjoint. FUB fetches are scoped by `assignedUserId`, so even a config error can't cross agents' leads — overlap would require the same agent in both sets, which the safeguard blocks. **Cutover hazard** documented below. |
| 0c Protection inheritance | **PASS (fixed + tested)** | Engine calls the shared audited pipeline (`isEligible` → `shouldSkipLead` → `generateFollowUpMessage` → `sendLeadFollowUpEmail`), enforced by a wiring guard test. Behavioral tests (94927a3): SOI lead ("Theo's SOI") and "New Agent Inquiry" lead assigned to jason both skip with logged reasons and **zero network calls**; clean company lead flows through deals check + LLM to a send decision; deal-holding lead skips with no LLM call. From "Agent \| Lifestyle Design Realty" + BCC peter@ intact ([botHelpers.ts:1318-1322](lifestyle-bot-dashboard/server/botHelpers.ts)). **FIXED:** `botEngineIntro.ts` imported `_core/llm.ts`, which had been restored as the **Forge client** (forge.manus.im) — replaced with the Anthropic-direct client; folder-wide zero-Forge grep guard restored and extended to the engine files. |
| 0d Engine internals | **PASS** | 3–19 window inherited from audited `isEligible` (window + stale-override tests green). Per-run cap: `.slice(0, MAX_LEADS_PER_RUN)` (15). Dedup: shared `sms_sent_today` (read before, written after each send). Per-lead error isolation: try/catch per lead; run-level crash caught by `runAllEngineAgents` with a `bot_crash` observation. Intro sequencing: `handleEngineClockin` sends pending intros FIRST, then clock-ins; `introSentAt` NULL-gate prevents re-send; flag set once after send. Edge: if the send succeeds but the flag write fails, a retry could double-send the intro (small window; internal recipients only — accepted, noted). Clock-off reads the latest `bot_run_logs` row for today (single-run correct; if the engine ran twice in one day it reports the last run, not the sum — cosmetic, noted). |
| 0e Access control | **PASS** | All `agentRegistry.*` procedures are `adminProcedure`. Ran suites: `agentRegistry.test.ts` + `accessControl.test.ts` — unauthenticated and non-admin rejected on list/fubUsers/toggleActive/create/update/delete; `/agent/:slug` view leaks no other agents' rows (tiffany view ∌ jason data). UI page redirects non-admins to /404 ([AgentRegistry.tsx:46-48](lifestyle-bot-dashboard/client/src/pages/AgentRegistry.tsx)); page-level enforcement in the browser **requires human verification** (client-side gate; the data APIs are the real boundary and are admin-only). Full suite: **113 passed / 6 env-gated skips / 0 failed.** |

### Cutover hazard + proposed atomic mechanism (0b)
Flipping a legacy agent (e.g. tiffany) `engineActive=true` while `tiffanyBot.ts` heartbeats still fire would double-send **if** the code-level safeguard were removed — today the engine refuses legacy slugs, so the flip is a silent no-op (safe but confusing). **Proposal:** add a `legacyRetired` boolean to `agent_bots`. Engine processes a legacy slug only when `engineActive && legacyRetired`; each legacy bot file's run handler checks its own row and exits immediately when `legacyRetired=true` (one shared `isRetired(slug)` helper). One DB write then atomically hands an agent from the legacy file to the engine with no scheduling race, and the heartbeat jobs can be deleted at leisure. Effort: ~1 hour + migration.

### Part 0 audit-fix commits
- `94927a3` — Anthropic `_core/llm.ts` (intro path was Forge), deals-URL north-star tests, SOI/excluded-source engine-inheritance tests, restored+extended zero-Forge grep guard, snapshot-consistency test, gated live-API test.

### Requires human verification before 10:00 AM CT
1. **Deploy current main** (with `94927a3`) to the Manus lifestyle-bot-dashboard project — the live checkpoint predates this fix; without it the intro email calls the Forge gateway (works only if the Manus BUILT_IN key is still provisioned; violates the Anthropic-direct mandate either way).
2. **Register the engine heartbeat crons** (engine-clockin ~15:00 UTC, engine-run ~15:05, engine-clockoff ~23:00) — routes exist ([_core/index.ts:81-85](lifestyle-bot-dashboard/server/_core/index.ts)); cron registration is Manus-side and not visible from the repo. Confirm the LEGACY bots' jobs are untouched and no duplicate engine jobs are created (see the Jul 17 duplicate-cron incident).
3. `ANTHROPIC_API_KEY` present on the deployment (intro + skip gate + generation all need it; generation errors rather than sending generic mail if missing).
4. `agent_bots` row for jason has correct `agentEmail` (emails send From that address) — snapshot doesn't include the email column, unverifiable from repo.
5. First engine run: read jason's first 1–2 sent emails in `contacted_leads`/FUB notes for prompt quality.

### Known mirror drift (not launch-affecting)
- `server/nightlyHealer.ts` (synced from the live project in `ba803c9`) imports 19 `./db` helpers that exist only in the live project's db.ts — 19 tsc errors confined to that file; it never runs from this repo. Flagged for Manus to sync the matching db.ts.
- `todo.md` re-added by `42f1651` despite the repo rule "no planning files in repo" (removed once before in `0eaa00f`).

---

## Scorecard

| Part | Area | Status | Score |
|---|---|---|---|
| 0 | Agent bot engine (URGENT) | **complete** | **9.5/10 — GO** |
| 1 | Python pond-nurture-bot behavioral suite | in progress | — |
| 2 | Agent bots predecessor guards | partially covered by Part 0 suite run | — |
| 3 | Power Queue (nurture-dashboard) | pending | — |
| 4 | Cross-system seams | pending | — |

## Part 1 — Python (pond-nurture-bot)

_(in progress)_

### Findings log
- (pending)

## Notes
- `.github/workflows/` untouched. No changes to caps/cadences/recipients/suppression semantics.
