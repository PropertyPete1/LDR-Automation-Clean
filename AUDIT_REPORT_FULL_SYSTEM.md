# Full-System Audit — LDR Automation

**Auditor:** Claude (independent auditor) · **Completed:** 2026-07-18
**Baseline:** main @ `83ae4dc` → audited head includes `94927a3`, `fefe685`, and this report.

---

# ENGINE LAUNCH: **GO** — the one launch defect (intro email wired to the retired Forge LLM) is fixed in `94927a3`; the lead-facing pipeline was already correct and is now behaviorally tested end-to-end, **conditional on deploying current main to the Manus project before 10:00 AM CT and registering the engine heartbeat crons** (human checklist below).

---

## Scorecard

| Part | Area | Score | Test state |
|---|---|---|---|
| 0 | Agent bot engine (URGENT) | **9.5/10 — GO** | TS suite 113 passed / 6 env-gated skips / 0 failed |
| 1 | Python pond-nurture-bot | **9/10** (was untested: 0 tests → 33) | pytest 33 passed, mocked HTTP only |
| 2 | Agent bots + shared helpers | **9.5/10** | covered by Part 0 suite + tsc |
| 3 | Power Queue (nurture-dashboard) | **9/10** | 67 passed / 17 env-gated skips |
| 4 | Cross-system seams | **9/10** | sync tests in Python suite (fail on divergence) |
| — | **Overall** | **9/10 — defensible; remaining gap is live-deployment verification, not code** | |

---

## Part 0 — Agent Bot Engine (launches 10:00 AM CT) — GO

| Item | Verdict | Detail |
|---|---|---|
| 0a Legacy safeguard | **PASS** | Double guard: `getActiveEngineAgents()` filters `LEGACY_BOT_SLUGS`; `runEngineForAgent()` throws BLOCKED before any DB read. Manus's `botEngine.test.ts` covers tiffany-engineActive=true → filtered; my snapshot test adds: exactly one active row (jason, fubUserId 37), every other snapshot slug ⊆ LEGACY_BOT_SLUGS. No snapshot/schema drift. |
| 0b Zero-overlap | **PASS** | Legacy files run {sp500_peter, sp500_steven, tiffany, stefanie, abby, irma, laila}; engine active set = {jason}; disjoint, and FUB fetches are scoped per `assignedUserId`. Cutover hazard + atomic mechanism proposal below. |
| 0c Protection inheritance | **FIXED → PASS** | Engine routes through the audited shared pipeline (wiring-guard test). Behavioral tests: SOI ("Theo's SOI") and "New Agent Inquiry" leads skip with logged reasons and **zero network calls**; clean lead flows deals-check → LLM → send decision; deal-holding lead skips with no LLM call; From "Agent \| Lifestyle Design Realty" + BCC peter@ intact. **Fixed:** `botEngineIntro.ts` called `invokeLLM` from `_core/llm.ts`, which `42f1651` restored as the **Forge client** (forge.manus.im) — replaced with Anthropic-direct (`94927a3`); zero-Forge grep guard restored and extended to engine files. |
| 0d Engine internals | **PASS** | 3–19 window from audited `isEligible`; cap `.slice(0, 15)`; shared `sms_sent_today` dedup read-before/write-after; per-lead try/catch (one failure cannot abort the run); run-level crash → `bot_crash` observation. Intro: `handleEngineClockin` sends pending intros FIRST then clock-ins; `introSentAt` NULL-gate; flag set once post-send. Edge (accepted): send-succeeds-but-flag-write-fails could double-send the internal intro on retry. Clock-off uses today's latest `bot_run_logs` row (last-run, not sum — cosmetic). |
| 0e Access control | **PASS** | All `agentRegistry.*` = `adminProcedure`; suites: unauthenticated + non-admin rejected on all six procedures; `/agent/:slug` leaks no cross-agent rows; UI redirects non-admin to /404 (client-side; the admin-only APIs are the real boundary). |

**Cutover hazard (0b):** flipping a legacy agent `engineActive=true` while their hardcoded file still runs is currently a **safe no-op** (engine refuses legacy slugs) but confusing. **Proposed atomic cutover:** add `legacyRetired` boolean; engine processes a legacy slug only when `engineActive && legacyRetired`; each legacy bot's handler exits when its row says `legacyRetired=true` (shared `isRetired(slug)` helper). One DB write per agent = atomic handoff, no scheduling race. Effort ~1h + migration.

## Part 1 — Python pond-nurture-bot (first-ever test suite: `pond-nurture-bot/tests/`, 33 tests)

| # | Item | Verdict |
|---|---|---|
| 1 | FUB client paths | **PASS (tested)** — exact `/v1/people`, `/notes`, `/events`, `/emEvents`, `/textMessages`, `/users`, `/pipelines`; north-star test asserts `_get_person_deals` calls exactly `https://api.followupboss.com/v1/deals?personId=` (the `/v1deals` class now fails a test); `_metadata.next` pagination; 429 → backoff → retry; 4xx raises |
| 2 | Suppression | **PASS (tested)** — every shared JSON tag reaches `rules.excluded_tags`; excluded sources ("New Agent Inquiry", "BOTM Newsletter") loaded + matched case-insensitively; Replied-Paused excludes |
| 3 | SOI Option B | **PASS (tested)** — source-contains ("Theo's SOI"), tag-prefix, manual-non-Peter; control: Peter-created API/Typeform lead flows |
| 4 | Deal protection | **PASS (tested)** — any-deal blocks pond; closed purchase (pipelines 1,2) → Phase 3; lease-listing-only (pipeline 5) silenced, purchase wins. **Fail-mode: fail-OPEN** (API error → `[]` → protection off, both Python `_get_person_deals` and TS `getPersonDeals`). *Recommendation: fail CLOSED for send-blocking checks — on deals API error, skip the lead this run; a delayed nurture email is cheaper than emailing someone mid-transaction. Effort ~30 min both languages.* |
| 5 | Timeline cadence | **PASS (tested)** — `purchase_window` upsert/get, newer-note re-extraction overrides; stretch is `max(cadence,30)` / `max(cadence,21)` → mathematically can only reduce frequency; runs AFTER SOI/suppression/gap checks in `process_reengagement_candidate` (precedence preserved) |
| 6 | Caps + dedup guard | **PASS (tested)** — pond cap 100 (`phase2_max_customer_emails_per_run`), closed-drip launch cap present; guard counts only status `'sent'` in the today-CT window (proven with seeded audit rows: `dry_run_sent` and `skipped` never trip it); guard exit still pings healthchecks + posts the dashboard observation (asserted) |
| 7 | Dry-run separation | **PASS (tested)** — `dry_run_sent` status; EmailSender in dry-run never constructs SMTP (booby-trapped `smtplib.SMTP`); guard skipped in dry-run |
| 8 | Prompt parity | **FIXED (`fefe685`)** — rule 12 (anti-phantom: never reference prior outreach absent from notes — the "Melissa incident" class) existed only in botHelpers.ts; ported to all four lead-facing Python prompts (pond, quarterly drip, welcome, long-term nurture) + parity test. Pond prompt already had 20 dated notes, temporal rules, persistent angle rotation (tested) |
| 9 | Note/report integrity | **PASS (tested)** — send path checks SOI + excluded sources; pond LOGGER lines are person_id-only |
| 10 | Bounce architecture | **BROKEN-BY-DESIGN, documented** (below) |

### Item 10 — Bounce detection cannot work as built
`nightly_health.py` scans FUB `/v1/emEvents` for bounces/unsubscribes. But every bot email (pond nurture, agent bots) is sent via **Gmail SMTP as peter@**, entirely outside FUB — FUB's Email-Marketing-Events stream only records events for mail FUB itself sends. **Empirical proof from the Jul 17 incident review:** real bounces arrive as DSN emails in peter@'s mailbox (`postmaster@outlook.com` "Undeliverable: Following up — Tiffany Proske", `mailer-daemon@googlemail.com` delay notices) and never appear as FUB events. The detector is a no-op for 100% of bot mail.
**Spec (not implemented, per instructions):** a nightly job authenticates to the peter@ mailbox (Gmail API label query `from:(mailer-daemon OR postmaster) newer_than:1d`), parses each DSN for the failed recipient address and permanence (5.x.x = hard bounce), maps address → FUB person via `/v1/people?email=`, and applies the existing `bounced` suppression tag + FUB note. Reuses the existing suppression semantics; no cap/cadence changes. Effort: ~half a day + a Gmail credential decision (OAuth vs app password).

## Part 2 — Agent bots + shared helpers
- Predecessor guards all hold on current main and are green in the suite: bot-note vs human-note 24h distinction; From-name + BCC (`eac1030`, [botHelpers.ts:1318-1322](lifestyle-bot-dashboard/server/botHelpers.ts)); persistent angle table; zero Forge in every bot path (guard test re-extended to engine files).
- `hasAnyDeal`-first ordering with 10-min in-memory cache. **Cache failure modes:** (a) stale-positive — a deal created mid-run is invisible up to 10 min (worst case: one extra email to a brand-new deal holder); (b) fail-open on API error (see Part 1 rec); (c) per-process memory — restarts clear it (safe). `clearDealCache()` exported for tests; production relies on TTL.
- camelCase schema sync (`90b6525`): tsc is clean across the package **except** `nightlyHealer.ts` (19 errors) — a live-deployment file whose `./db` helpers exist only in the live project's db.ts. Mirror drift, flagged for Manus; it never executes from this repo.
- `todo.md` re-added by `42f1651` despite the no-planning-files rule (previously removed in `0eaa00f`) — flagged.

## Part 3 — Power Queue (nurture-dashboard)
- Suite: 67 passed / 17 env-gated skips / 0 failed.
- Hot-reply pinning: `Replied - Paused` → `is_hot_reply` → sorted first ([dashboardData.ts:292,689,762](nurture-dashboard/server/dashboardData.ts)).
- Anthropic-direct SMS drafts: four behavioral tests assert `api.anthropic.com/v1/messages` + `claude-sonnet-4-6`; per-day draft cache via `getCachedDraft`/`setCachedDraft` (tested; DB-backed tests env-gated).
- Snooze: `snoozeLead` with YYYY-MM-DD validation + `markSnoozeNoteWritten` (FUB note tracking); display-only return-on-date logic in queue filter.
- Stats contract: covered by the cross-system field-name test (weekly_digest.py consumed fields must exist in dashboard server source).
- Clock-in `powerQueueUrl` builds from `https://fub-nurture-phfprjui.manus.space/sms-queue` ([botHelpers.ts:1368,1428](lifestyle-bot-dashboard/server/botHelpers.ts)).
- Bot Monitor reads `bot_observations`; the live duplicate-cron incident (Jul 17 report) remains a Manus-console cleanup item.

## Part 4 — Cross-system seams (tests in `pond-nurture-bot/tests/test_cross_system.py`)
- **Suppression sync test:** Python JSON vs TS JSON copy must be identical (tags + excluded_sources), and the TS hardcoded fallback must cover every shared tag — the suite FAILS on divergence. Currently in sync.
- Deal + SOI + excluded-source rules semantically identical across languages (verified case-by-case; one nuance: TS lease rule also treats pipeline 6 "Lease Applications" as lease and stageId 99 as closed — strictly more protective than Python; Python's rule 1 additionally requires `createdById != 0`, same as TS. No divergence that weakens protection).
- Repo-wide grep: zero Forge/BUILT_IN/manus-LLM refs in active code (guarded by test); non-LLM Manus platform plumbing in `_core/` (storage/heartbeat/maps) is required by the hosting and documented; person_id-only logging asserted for the pond send path; no secrets in repo.
- Snapshot-vs-schema consistency: tested.

---

## Audit-fix commits (this audit)
| SHA | What |
|---|---|
| `8a6f36b` | Incremental report started (credit survival) |
| `94927a3` | Part 0: Anthropic `_core/llm.ts` (intro path was Forge), deals-URL north-star TS tests, SOI/source engine-inheritance tests, zero-Forge guard restored+extended, snapshot test, gated live-API test |
| `fefe685` | Part 1: first Python behavioral suite (33 tests incl. cross-system seams) + rule-12 parity in four Python prompts |
| (this) | Final report |

## Test inventory — what the critical paths now assert
- **FUB deals URL (both languages):** exact `https://api.followupboss.com/v1/deals?personId=` — malformed-path class fails tests.
- **Skip gate (TS):** SOI/excluded-source → skip with zero network calls; deal → skip with no LLM call; human-note-24h → skip with no LLM call; bot-note → not human; LLM error → fail-open documented.
- **Generation (TS):** full dated-note context + temporal + angle + rule-12 reach the real prompt; Anthropic URL/model/key asserted; LLM failure sends nothing.
- **Python guard:** only real `'sent'` rows today-CT trip dedup; pings + observation on guard exit; dry-run isolation booby-trap.
- **Pagination/429:** cursor-following and backoff proven against a recording fake.
- **Seams:** suppression JSON divergence, TS-fallback gaps, and digest/stats field mismatches all fail the suite.

## Defects found, ranked by production severity
1. **Intro email on the Forge LLM path** (launch-day feature calling a retired gateway; would have thrown `OPENAI_API_KEY is not configured` — or silently depended on Manus platform creds) — FIXED `94927a3`.
2. **Rule-12 missing from all Python prompts** (live: pond emails could hallucinate "the email my team sent" to leads never contacted — the exact "Melissa incident") — FIXED `fefe685`.
3. **Deal protection fails OPEN in both languages** (live: an FUB hiccup silently disables the strongest do-not-email guard — same failure shape as the original /v1deals incident) — DOCUMENTED + recommended fail-closed; not changed (semantics change requires owner sign-off).
4. **Bounce detector is a no-op for all bot mail** (live: bounced addresses keep getting emailed; sender reputation risk) — DOCUMENTED + spec'd.
5. `nightlyHealer.ts` mirror drift (19 tsc errors; no runtime impact from this repo) — flagged.

## Requires human verification
1. Deploy current main (≥ `94927a3`) to the Manus lifestyle-bot-dashboard project **before 10:00 AM CT**; redeploy nurture-dashboard is not required today.
2. Register engine heartbeat crons (engine-clockin 15:00 UTC, engine-run 15:05, engine-clockoff 23:00) — exactly once; verify no duplicate jobs (Jul 17 incident pattern) and legacy bots' jobs untouched.
3. `ANTHROPIC_API_KEY` present on the deployment; jason's `agent_bots.agentEmail` correct (not in snapshot).
4. After first engine run: read jason's sent emails in FUB notes/`contacted_leads` for quality + confirm exactly one clock-in per bot.
5. Kill list from the Jul 17 duplicate-cron incident (stale 8th-bot cron set) still pending in the Manus console.

## Top 3 unimplemented recommendations
1. **Fail-closed deal protection** on API error in both languages (~30 min) — closes the last silent-fail-open in a send-blocking check.
2. **DSN mailbox poller for bounces** (~half day) — replaces the broken-by-design emEvents detector; reuses existing `bounced` tag semantics.
3. **`legacyRetired` atomic cutover flag** (~1 h + migration) — makes legacy→engine agent handoff a single safe DB write and unblocks retiring the seven hardcoded bot files.

---

# Session 3 — Registry Propagation / Access Control / Cleanup (2026-07-21)

## Registry Propagation — **Golden Rule: MET** (9.5/10)

nurture-dashboard was already dynamic (`b564101`); lifestyle-bot-dashboard was NOT — it carried three hardcoded agent maps. All fixed in `038bfcb`.

### 1a — Every hardcoded agent list found (both projects)
| Location | Was | Verdict |
|---|---|---|
| nurture-dashboard `agentRegistry.ts` / `dashboardData.ts` / client pages | dynamic via `getActiveAgents()` (FUB users) | **PASS** (Manus's claim verified) |
| nurture-dashboard `SmsQueue.tsx` / `dashboardData.ts:1261` `"Peter"` | pond-section agent name | **PASS** — pond leads are all Peter's (FUB 2); legitimate one-off, not a roster |
| lifestyle-bot-dashboard `botHelpers.ts` `POWER_QUEUE_AGENT_NAME` (8-agent Record) | hardcoded map, Jason absent | **FIXED** → `resolveAgentBotRow` + `derivePowerQueueName` |
| lifestyle-bot-dashboard `botHelpers.ts` `AGENT_DASHBOARD_SLUG` (8-agent Record) | hardcoded map | **FIXED** → `deriveDashboardSlug` |
| lifestyle-bot-dashboard `botMonitor.ts` `ALL_BOTS` (8-bot array) | hardcoded list | **FIXED** → `getAllBots` + `buildWatchedBotList` |
| lifestyle-bot-dashboard legacy `tiffanyBot.ts` … `AGENT_FIRST` | single-agent const per legacy file | **PASS (legacy)** — each hardcoded file owns one agent; slated for retirement (Job 3 flags) |
| lifestyle-bot-dashboard `routers.ts:454` Rue→Stefanie | one-off alias | **PASS** — business rule, mirrors Maria→Laila |

### 1b — lifestyle-bot-dashboard specifics
- `POWER_QUEUE_AGENT_NAME`: **was hardcoded without Jason → now dynamic** (reads agent_bots; legacy map is fallback-only).
- `AGENT_DASHBOARD_SLUG`: **was hardcoded → now dynamic.**
- Bot Monitor watched list: **was hardcoded (Jason had been manually patched in) → now dynamic** from agent_bots.
- Jason's clock-in: verified → `derivePowerQueueName({botSlug:jason, powerQueueName:null, agentFirstName:Jason})` = `"Jason"` → `fub-nurture-phfprjui.manus.space/sms-queue?agent=Jason`. ✅
- Maria→Laila alias: **test added** (`nurture-dashboard/server/agentRegistry.test.ts`), asserts the alias and that it correctly does NOT fire when Laila is absent.

### 1c — Golden Rule test (TestAgent)
`registryPropagation.test.ts` proves a brand-new `testagent` row propagates to: Power Queue link (`derivePowerQueueName`), dashboard slug (`deriveDashboardSlug`), and Bot Monitor watched list (`buildWatchedBotList`) with zero code change. Unit-level (the mirror has no live MySQL). **Requires human verification:** insert a real `testagent` row in the live DB, confirm it appears in the Power Queue dropdown + monitor email, then delete the row.

**Score 9.5/10** — full dynamic propagation with tests; −0.5 because the live DB round-trip is unverifiable from the repo mirror.

## Access Control — **Power Queue now server-enforced** (9/10)

### The vulnerability (as reported)
Access control was **URL-param only**. `SmsQueue.tsx` computed `lockedAgent` from `?agent=` in the URL; the `getPendingQueue` tRPC procedure was `publicProcedure` and returned the **full queue** whenever no filter was passed. Any agent could delete the `?agent=` query string (or call the API directly) and see **every agent's leads**. There was no server-side identity check anywhere.

### The fix (`390aefc`)
- **Server is the boundary.** `resolveQueueViewer(user, agents)` (pure, tested) decides admin vs agent from the authenticated `ctx.user`. `getPendingQueue` is now `protectedProcedure`; for non-admins it **ignores the client `agentFilter` and forces the caller's own name** (unresolved caller → impossible filter → empty result, deny-by-default). `getPondSmsLeads` is protected and returns `[]` for non-admins (pond leads are Peter's — cross-agent).
- **Admin** = dashboard `role === "admin"` OR Peter/Steven login email OR resolved FUB user id ∈ {1, 2}.
- **Client** now derives its lock from the server response (`isAdmin`/`agentName`), not the URL: non-admins get the dropdown hidden (lock chip), heat chart reduced to their own tile, and the pond section hidden. Admins keep the full dropdown, heat chart, and pond.

### 2d — Behavioral tests (`queueAccessControl.test.ts`, 10 tests, all green)
| Scenario | Asserted |
|---|---|
| Peter / Steven / role=admin | `isAdmin=true`; may pass any `agentFilter` or none (full queue) |
| Tiffany (FUB 20) | `isAdmin=false`, locked to "Tiffany"; a crafted `agentFilter="jason"` **and** a removed filter both collapse to "Tiffany" |
| Unauthenticated | not admin, no agent |
| Unresolved non-admin | forced to `__no_such_agent__` → empty result |

### What's protected
Cross-agent lead data on `getPendingQueue` and the pond list — an agent can no longer reach another agent's leads by any client manipulation, because the filter is derived server-side from their session.

### Deployment checklist (nurture-dashboard)
1. Deploy nurture-dashboard (server + client) with `390aefc`.
2. Confirm the deployed `users` rows carry the expected `email`/`role` so agents resolve to their roster identity (the admin bridge is email/FUB-id since the dashboard `users` table has no FUB id column).
3. **Requires human verification (browser):** log in as a non-admin agent → confirm no "All Agents" dropdown, only their own leads and heat tile, no pond section; log in as Peter → confirm full dropdown + all agents + pond.

**Score 9/10** — the server boundary is closed and unit-tested; −1 because the end-to-end browser login and the live `users.role`/email mapping can only be verified post-deploy.

### Pre-existing test note
`fub.procedures.test.ts` has 6 failures that **pre-date this work** (identical with my changes stashed): `logSentNote` and `getPendingQueue` pagination tests need a live FUB fetch mock that the repo mirror doesn't provide (`Cannot read properties of undefined (reading 'ok')`). Not introduced by Job 2; flagged for the harness owner.
