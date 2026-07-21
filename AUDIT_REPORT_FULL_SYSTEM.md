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

## Cleanup — conservative deletions + honest flags (8.5/10)

### 3a — Dead code deleted
| Item | Reason | Commit |
|---|---|---|
| `botHelpers.ts` "Launch Day Only" block: `INTRO_LAUNCH_DATE`, `isLaunchDay()`, `BOT_INTRO_COPY`, `sendBotIntroEmail()` (−294 lines) | Superseded by `botEngineIntro.ts` (data-driven, LLM-generated); launch date 2026-06-15 long past; referenced only in one comment; wired to no route/scheduler | `2414991` |
| `lifestyle-bot-dashboard/todo.md` | Planning file; repo rule forbids them (removed once in `0eaa00f`, slipped back in `42f1651`) | `2414991` |

### 3a — Flagged, NOT deleted (still active — conservative)
- **Legacy per-agent bot files** (`tiffanyBot.ts`, `stefanieBot.ts`, `abbyBot.ts`, `irmaBot.ts`, `lailaBot.ts`, `spBot.ts`): each is still imported by `scheduledHandlers.ts` and still runs today (only Jason is on the engine). **Not dead.** Retire them only via the `legacyRetired` atomic-cutover mechanism (Part 0 recommendation).
- **`nurture-dashboard/server/_core/llm.ts` is still the Forge client** (`forge.manus.im`) and is **heavily used** — `memoryLayer`, `routers` (ai.chat / ai.draftReply / dailyBriefing), `replyIntentHandler`, `lifestyleBot`, `pondNurture`, `nightlyHealer`, `_core/index.ts`. Only `ai.draftSms` was rewired to Anthropic (`13efb0d`). **This is a real finding, not a Job-3 deletion:** most nurture-dashboard AI features still route through the retired Forge gateway. Rewiring is a functional change (out of Job 3 scope) — flagged for a follow-up like the lifestyle-bot-dashboard rewire.
- **`/home/ubuntu/...` paths** in nurture-dashboard (`dashboardData.ts`, `_core/index.ts`, `routers.ts`, `vite.config.ts`): these are the **live Manus host filesystem paths** the deployed dashboard reads (sqlite, clicks.json, PDFs). Active deployment config, not dead code — left intact.

### 3a — Routes/endpoints
- **`/api/scheduled/pond-nurture`** (nurture-dashboard `_core/index.ts`) calls `runPondNurture()` — a TS pond-nurture path that still exists even though the README says pond nurture runs from GitHub Actions Python. **Flagged as a potential duplicate-send hazard** (same class as the Jul 17 8th-bot incident): if any cron still hits this endpoint, pond leads get emailed by both the Python workflow and this TS route. Whether a cron calls it is a Manus-console question not visible from the repo — **requires human verification.**

### 3b — Legacy data structures
- **`pond_nurture_log`: the brief's premise ("no longer read by anything") is FACTUALLY INCORRECT.** It is read (cadence dedup), written, and pruned by `pondNurture.ts` + `db.ts`, and `pondNurture.ts` is wired to the live `/api/scheduled/pond-nurture` route. **Dropping it would break dedup and risk duplicate pond emails — NOT dropped.**
- Other schema tables (`leadSnoozes`, `smsDraftCache`, `queueActions`, `speedToLeadTimers`, `pondPromotionLog`, `replyIntentProcessed`): all reachable through `db.ts` wrapper functions used by active routers. **None are dead; none dropped.**
- No stale migrations dropped (the tables they create are all live).

### 3c — Snapshot hygiene
`agent_bots_snapshot.json` = 8 rows (tiffany, stefanie, abby, irma, laila, jason, sp500_peter, sp500_steven), exactly one `engineActive` (jason). Matches the documented 8-row state and the schema (snapshot fields ⊆ `agent_bots` columns). **Live-DB comparison requires human verification** (no MySQL access from the mirror).

### 3d — Dead dependencies (LISTED, not removed — per instructions)
Heuristic candidates after removing confirmed false positives (`nodemailer` — dynamic `await import`; `dotenv` — `import "dotenv/config"`; `tailwindcss-animate` — Tailwind config plugin):

| Package | Projects | Note |
|---|---|---|
| `framer-motion` | both | no import found in server/client/shared |
| `date-fns` | nurture | no import found |
| `@hookform/resolvers` | both | no import found (pairs with react-hook-form; verify no form uses it) |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | both | nurture-dashboard has no S3 usage; lifestyle-bot uses them in `storage.ts` — keep there |

**Not removed** — some may be pulled in by shadcn/ui generated components or kept intentionally; removing from a deployment mirror risks breaking the build. Recommend the human confirm with `depcheck` on the live tree before pruning.

### 3e — README
Fixed the stale "7 AI bots" / "7 agent bots" count (components table, System 3 heading+body, nightly-health description, healer-observations line, architecture diagram) → now describes the data-driven `agent_bots` registry (original agents via per-agent files, new agents like Jason via the engine). **Left the Migration History (CC2 cutover dates) intact** — accurate historical record, not a stale feature claim.

**Score 8.5/10** — every genuinely-dead item removed and every ambiguous one correctly flagged rather than deleted; −1.5 because two brief premises were wrong (pond_nurture_log is live; the Forge gateway is still the nurture-dashboard's main LLM path), which are findings to escalate rather than clean.

---

## Session 3 — Requires human verification
1. **Deploy** lifestyle-bot-dashboard (registry-dynamic + cleanup) and nurture-dashboard (access control) with this session's commits.
2. **Browser login test (access control):** non-admin agent → only own leads, no "All Agents" dropdown, own heat tile only, no pond section; Peter/Steven → full dropdown + all agents + pond.
3. **Golden Rule live:** insert a `testagent` row in the live `agent_bots`, confirm it appears in the Power Queue link + Bot Monitor email with no deploy, then delete the row.
4. **`/api/scheduled/pond-nurture`:** confirm NO cron hits this TS endpoint (pond nurture must run only from the GitHub Actions Python workflow) — else duplicate pond sends.
5. **`users.role`/email mapping:** confirm deployed dashboard `users` rows resolve agents to their roster identity (admin bridge is email/FUB-id, since `users` has no FUB-id column).
6. **agent_bots_snapshot.json vs live DB:** confirm the 8-row snapshot still matches production.

## Session 3 — What needs deploying
- **lifestyle-bot-dashboard:** `botHelpers.ts` (dynamic PQ/slug resolution), `botMonitor.ts` (dynamic watched list), `botEngine.ts` (botSlug in clock-in), intro-block/todo removal. Deploy to `lifestyledash-wpnl8v84.manus.space`.
- **nurture-dashboard:** `agentRegistry.ts` (`resolveQueueViewer`), `routers.ts` (protected getPendingQueue/getPondSmsLeads), `SmsQueue.tsx` + `AgentCopilot.tsx` (server-driven lock). Deploy to `fub-nurture-phfprjui.manus.space`.

## Session 3 — Scores
| Job | Score |
|---|---|
| Registry Propagation | 9.5/10 |
| Access Control | 9/10 |
| Cleanup | 8.5/10 |

---

# Access Model — Final Verification (Session 4, 2026-07-21)

## Verdict: **6/10 — NOT 10/10.**
The redesigned URL-param/token model is **correct and coherent for the two lead-list endpoints it gates** (`getPendingQueue`, `getPondSmsLeads`) — that part is 10/10 and now backed by a test that runs the *real* decision function. But the "remove the login wall" change (`c19fa5b`) left **the entire rest of the tRPC surface `publicProcedure`**, including endpoints that return lead PII by id and endpoints that trigger real email sends. The model is sound; its *coverage* is incomplete. Fixing coverage safely requires a coordinated client+server scoping change I can't verify against the live UI, so I fixed the test-integrity defect + Peter-token test and am flagging the rest precisely rather than blind-patching a running dashboard.

## Jobs 1a–1f
- **1a getPendingQueue** — ✅ PASS. Agent param scopes case-insensitively (name or slug) against the live roster; unknown agent → `__no_such_agent__` (empty); no param / `agent=all` without token → `__empty__`; valid token → full queue or admin-filtered. **Fixed a real test defect:** `queueAccessControl.test.ts` previously tested a *copy* of the logic re-implemented in the test file — it could not catch the procedure drifting. Extracted `resolveQueueAccess()` (shared, in `agentRegistry.ts`), wired the procedure to it, and pointed the test at the real function (13 assertions, green). `fff7d06`.
- **1b getPondSmsLeads** — ✅ PASS. Token-only via `isAdminToken()`; `[]` otherwise.
- **1c getRoster + getDashboardStats** — ❌ **STILL PUBLIC.** The redesign updated the Home *client* to read `?agent`/`?admin` but never gated the *server* endpoints. Both remain `publicProcedure` returning every agent's lead counts + company aggregates to anyone. **Flagged, not fixed** (see rationale + recommendation below).
- **1d every publicProcedure classified** — see table below.
- **1e clock-in admin URL** — ✅ PASS + **new test** (`clockinAdminUrl.test.ts`, 4 assertions): `POWER_QUEUE_ADMIN_TOKEN` reaches **only** Peter's clock-in (`admin=TOKEN&agent=all`); Tiffany + a sweep of Stefanie/Abby/Irma/Laila/Jason/Steven get scoped `?agent=Name` with no token; token unset → Peter falls back to a plain link.
- **1f token hygiene** — ✅ PASS. `powerQueueUrl` is used only inside the email HTML anchor; grep of both TS projects + Python found **no** logging of the token or the URL, and it never enters a FUB note or observation.

## 1d — Every `publicProcedure` classified
| Bucket | Procedures | Verdict |
|---|---|---|
| **Scoped/gated (correct)** | `fub.getPendingQueue` (param+token), `fub.getPondSmsLeads` (token) | ✅ FIXED/PASS |
| **Benign** | `auth.me`, `auth.logout`, `system.*`, `logClientError`, `refreshRoster`, `isLeadSuppressed`, `getSuppressionList`, `getSnoozeInfo`, `getTodayTextedLeadIds`, `getDailySmsGoal` | ✅ low/again no cross-agent PII |
| **Cross-agent counts — LEAK (medium)** | `fub.getDashboardStats`, `agent.getRoster`, `agent.getLeads({agentName})`, `leads.getWeeklyStats` | ⚠️ returns any/all agents' pipeline data with no token |
| **Lead PII by personId — LEAK (HIGH)** | `fub.getLatestInboundSms`, `leads.getLastInbound`, `leads.getNotes` | 🔴 anyone can enumerate sequential `personId`s and scrape every lead's FUB notes + inbound texts |
| **Public side-effect mutations (HIGH)** | `bot.runNow` (triggers a real lifestyle-bot email run), `bot.runAutoPondNow` (reassigns leads), `bot.runBounceNow`, `bot.runMonitorNow`, `audit.run`, `leads.markUnsubscribe`, `leads.snoozeLead`, `leads.logSentNote`, `leads.recordAction`, `*.markObsFixed`, `ai.saveMemory`, `ai.logFeedback` | 🔴 callable by anyone with the URL; no token/ownership check |
| **LLM cost/abuse (medium)** | `ai.chat`, `ai.draftSms`, `ai.draftReply`, `ai.dailyBriefing` | ⚠️ unauthenticated callers can run the Copilot/drafts (LLM spend) |
| **System/observation reads (low)** | `bot.getStatus/getRunHistory/getMonitorStatus/getObservations/getDaySummary/getPondPromotionHistory`, `ai.getMemories/getWinningPatterns` | ⚠️ observations are person_id-only (prior audit), so low PII risk |

## Why I flagged rather than blind-patched (1c/1d)
The no-login dashboard *itself* calls these endpoints without a token — an agent viewing their scoped queue needs `getNotes`/`getLastInbound` for lead context; tap-to-text calls `logSentNote`. Correctly closing them means **per-request ownership scoping** (verify the `personId`'s assigned agent matches the `?agent=` param) plus token-gating the admin-only triggers and passing `?agent`/`?admin` from every client call site — a coordinated change whose UI I cannot exercise from the repo mirror. Shipping that blind would likely break agent access or Peter's admin buttons. The safe, high-value fixes (shared tested access fn; Peter-only token test) are done; the rest is specified below.

## Recommended fix (the completeness pass the redesign missed)
1. **Token-gate the pure admin triggers** — `bot.runNow/runAutoPondNow/runBounceNow/runMonitorNow`, `audit.run`, `markUnsubscribe`: require `isAdminToken(input.adminToken, ENV.powerQueueAdminToken)`; return FORBIDDEN otherwise. Agents never call these. (~1–2 h, low UI risk.)
2. **Scope the count endpoints** — `getDashboardStats`/`getRoster`/`getLeads`/`getWeeklyStats`: apply `resolveQueueAccess` (agent param → own row only; admin token → all; none → empty) and pass `?agent`/`?admin` from `Home.tsx` (already read there). (~half day + live check.)
3. **Scope the PII reads** — `getNotes`/`getLastInbound`/`getLatestInboundSms`: require the caller's `?agent=` to match the lead's assigned agent (one FUB lookup, cacheable), or fold them behind the same token. (~half day.)
4. Optional: rate-limit / token-gate the `ai.*` LLM endpoints to prevent unauthenticated spend.

## Job 2 — 12-element functional sweep (code-level)
1. **Agent dropdown** — client renders it only in admin view (`?admin` token); server `getPendingQueue` returns `isAdmin` to drive it. ✅ (unauth screenshot still shows the empty dropdown chrome — cosmetic, no data).
2. **Hot-reply pinning** — `dashboardData.ts` flags `Replied - Paused` → `is_hot_reply`, sorted first. ✅ (unchanged).
3. **Lead cards** — days-stale from `created`, engagement tier, context line — code intact; **live values unverified (no session).**
4. **AI SMS draft** — `ai.draftSms` calls `api.anthropic.com` directly (`claude-sonnet-4-6`), per-day cache, rule-12 present; asserted by `ai.draftSms.test.ts` (4). ✅ *(other `ai.*` still use the Forge gateway — parked, per instructions.)*
5. **Tap-to-Text** — writes FUB note + `queue_actions` row via `logSentNote`/`recordAction`; **but both are public mutations** (see HIGH bucket). Function ✅ / access ❌.
6. **Call Instead** — `recordAction` note + action; same public-mutation caveat.
7. **Snooze** — options render; `snoozeLead` writes FUB note once + `lead_snoozes` row, returns on date, display-only; public-mutation caveat.
8. **Refresh** — busts caches, refetches. ✅
9. **Bot Dashboard link** — ✅ verified live earlier → `https://lifestyledash-wpnl8v84.manus.space/`.
10. **Weekly stats contract** — `getWeeklyStats` field names match `weekly_digest.py`; cross-system test in the Python suite. ✅ (needs token-gating — flagged).
11. **Agent Copilot** — uses the Forge `invokeLLM` gateway (known parked dependency; not rewired). Read-only Q&A + draft helpers; no write endpoints exposed *through it*. ✅ read-only.
12. **Pond SMS section** — admin-token only (`getPondSmsLeads`). ✅

## Job 3 — regression sweep
- **Suites:** nurture-dashboard **87 passed / 17 env-skipped / 0 failed**; lifestyle-bot-dashboard **140 passed / 6 env-skipped / 0 failed**; Python **44 passed**. tsc clean both projects **except** pre-existing `nightlyHealer.ts` mirror drift (19 errors, never runs from this repo); `py_compile` clean.
- **Golden Rule** — still holds (`registryPropagation.test.ts`); the URL-param model resolves agents from the same live roster.
- **Jason** — consistent: scoped link `?agent=Jason`; clock-in test confirms he never receives the admin token.
- **Diff since 038bfcb** — send-path changes are exactly (a) the clock-in admin-URL builder and (b) the intentional From-address switch to `team@lifestyledesignrealty.com` (`ecfcaf5`, tested by `emailFromAddress.test.ts` + `test_email_from_address.py`). No caps/cadences/recipients/suppression semantics changed.
- **Suppression/SOI/deal protection** — spot-run green within the 44 Python + TS suites.

## Requires human verification
1. **Live browser pass with the admin token** — I could not authenticate (no session; entering credentials is disallowed) so lead-card values, AI-draft personalization, tap-to-text, snooze, and copilot answers are code-verified only. Set `POWER_QUEUE_ADMIN_TOKEN`, open `?admin=TOKEN&agent=all`, and spot-check.
2. **Confirm the PII-read + public-mutation exposure** on the live host (e.g., `curl` `bot.runNow` / `getNotes?personId=1`) and prioritize the recommended gating.
3. Gmail "send-as" for the new `team@` From address (per the deploy note) — verify Gmail shows "Tiffany | Lifestyle Design Realty", not a rewrite.

## What would make it 10/10
Apply the four-step completeness fix above (token-gate admin triggers; scope count + PII endpoints via `resolveQueueAccess`/ownership; pass `?agent`/`?admin` from every client call). The foundation is right — a single shared, now-tested decision function exists; it just needs to be applied across the surface, then verified in a live admin session.
