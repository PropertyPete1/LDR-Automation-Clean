# Engineering-Quality Audit — LDR-Automation-Clean

**Date:** 2026-08-26 · **Baseline:** `main` @ `43fd2fe` (post PR #24) · **Scope:** Python bot (`pond-nurture-bot/`), TS dashboards (`nurture-dashboard/`, `lifestyle-bot-dashboard/`), workflows (`.github/`), state branch, repo hygiene.

**Method:** read-only sweep of all 494 tracked files; pyflakes over every Python module; full test suite run (648 passed, 49.6s); `pnpm audit` on both dashboards; GitHub API for repo/state-branch metrics; git history for telemetry noise. Every finding carries file/line references against the baseline commit.

---

## Report card

| # | Category | Score | One-line justification |
|---|----------|-------|------------------------|
| 1 | Duplication & drift | **3/10** | ~12 independent FUB HTTP clients, 5 divergent agent denylists, 3 copies of suppression_tags.json + 2 hardcoded fallbacks, Peter's ID/email ×5, TREC URLs ×3, Manus host ×6, `load_dotenv` ×4 |
| 2 | Dead & stale code | **4/10** | An entire never-served FastAPI/APScheduler layer, a 50-line `if False:` self-modifying block, ~3,400 lines of retired-but-callable TS engines, a daily job that computes output no one can read; zero TODO debt is the bright spot |
| 3 | State & data integrity | **5/10** | The CAS+merge protocol is genuinely excellent and tested against real git repos — but it feeds an 18 GB repo (2,062 × ~14 MB blobs, +~700 MB/day) and an index-less, never-pruned SQLite file |
| 4 | Error handling | **6/10** | Strong per-lead isolation + audit rows + dead-man's switches; undermined by 14 unwrapped daily phases, no 5xx retry in the Python client, and a handful of meaningful silent swallows |
| 5 | Security & compliance | **4/10** | Python lead emails are test-pinned compliant; but the LIVE annual-nurture sender has no unsubscribe/TREC/opt-out-tag check, Power Queue agent access requires no secret at all, and the admin token rides in email URLs |
| 6 | Test quality | **7/10** | 648 fast, deliberate, regression-pinning tests incl. real-git integration; gaps: the 30/60-min escalation transitions are untested, and CI still runs suites for retired TS code |
| 7 | Workflow & ops | **5/10** | Sound concurrency groups, shallow fetch, healthchecks; but 97% of main's commits are telemetry noise, crons need manual DST edits, stale comments describe a push that no longer exists, and npm carries 1 critical/44 high vulns |
| 8 | Architecture | **4/10** | Newer modules (ramp, state_sync, controls, state_merge) show excellent seam discipline; the core is a 7,773-line main.py with a ~5,100-line, 160-method god-class and deploy-coupled constants |
| | **Overall** | **4.5/10** | A system with excellent *recent* engineering habits layered over a legacy core that duplicates, retains, and hardcodes too much |

---

## 1. Duplication & drift

### 1.1 Agent denylist — five definitions, four shapes (KNOWN, confirmed + extended)
| Location | Content | Drift |
|---|---|---|
| `pond-nurture-bot/config/rules.yaml:63-67` | ids `[16, 34, 20, 37]` | canonical; 20 = Tiffany (**intentional**, owner request 2026-07-07), 37 = Jason |
| `nurture-dashboard/server/agentRegistry.ts:21` | slugs `{luke, bebe, jason}` | slug-based, **no Tiffany** |
| `nurture-dashboard/server/autoPondPromotion.ts:45` | ids `{16, 34}` | **missing 20, 37** |
| `nurture-dashboard/server/pondNurture.ts:60` | ids `[16, 34]` | **missing 20, 37** |
| `nurture-dashboard/server/speedToLead.ts:30` | `[PETER_USER_ID]` only | different semantic entirely |

Mitigating context discovered during the audit: `pondNurture.ts`, `speedToLead.ts`, and `autoPondPromotion.ts` are **retired engines** — their heartbeat crons were deleted 2026-07-13/17 (`nurture-dashboard/server/heartbeatBootstrap.ts:18-32`). The drift is therefore *latent*, not active — but the endpoints remain wired in `_core/index.ts` and would run the stale lists (Tiffany and Jason included) if ever triggered. The finding is the duplication; the fix is one source of truth (see roadmap P1-1).

### 1.2 ~12 independent FUB HTTP clients in one package
`nurture-dashboard/server/` alone: `agentRegistry.ts:38` (internalFubGet), `annualNurture.ts:43,61`, `autoPondPromotion.ts:55`, `bounceHandler.ts:50,73,103`, `botHelpers.ts:254` (the "official" fubRequest), `compliance.ts:31,42,55`, `dashboardData.ts:187` (the **only** one with 429/5xx retry), `lifestyleBot.ts:82,132`, `pondNurture.ts:76`, `replyIntentHandler.ts:68,91,121`, `reversePondDeals.ts:33,55,77`, `routers.ts:33`, `speedToLead.ts:52`. Each re-implements auth headers, error shapes, and (inconsistently) retries. The Python `FollowUpBossClient` (`main.py:961-993`) retries timeouts/429 but **not 5xx** — the TS `dashboardData` retries 5xx; nobody agrees.

### 1.3 Suppression tags — "single source of truth" is three sources plus two fallbacks
- Canonical: `pond-nurture-bot/config/suppression_tags.json`; copies at `nurture-dashboard/config/` and `lifestyle-bot-dashboard/config/` (all three currently in sync — verified by diff).
- Both `botHelpers.ts` (nurture `:31`, lifestyle `:31`) look first at `../../fub_automation/config/suppression_tags.json` — **that directory does not exist** (the tracked `fub-automation/` dir is a hyphen-spelled orphan holding only an empty sqlite file), so the "primary" path is dead and every load falls through to the per-project copy.
- Both files also embed a hardcoded fallback array (nurture `:56-66`) that duplicates the list a 4th/5th time. The `_description` in the JSON ("Single source of truth") and both file comments are aspirational, not true.

### 1.4 Constants defined N times
- `PETER_USER_ID = 2`: `nurture-dashboard/server/botHelpers.ts:85`, `speedToLead.ts:22`, `pondNurture.ts:29`, `lifestyle-bot-dashboard/server/botHelpers.ts:89`, plus `rules.yaml peter_user_id`. `PETER_EMAIL` ×3.
- TREC URLs: `main.py:7687-7688`, `seller_nurture.py:346-347`, `lifestyle-bot-dashboard/server/botHelpers.ts:1396-1397`. (`nurture-dashboard` has zero TREC references — see §5.3.)
- `load_dotenv` re-implemented ×4: `run_speed_to_lead_check.py:47`, `export_dashboard_data.py:21`, `run_approved_daily_automation.py:21`, `main.py:7281`.
- `_ping_healthcheck` wrapper ×3: `run_speed_to_lead_check.py:151`, `run_approved_daily_automation.py:386`, `weekly_digest.py:637`.
- `America/Chicago` hardcoded in ~12 Python files and several TS files while `rules.yaml local_timezone` exists; business hours 10–18 CT hardcoded at `run_speed_to_lead_check.py:70` while `rules.yaml business_hours_start/end` exists.
- 30/60-minute thresholds: `rules.yaml new_lead_warning/reassign_minutes` **and** `speedToLead.ts:24-25` (retired copy).
- FUB person-view URL builder duplicated ×6 across Python and TS.
- Manus deploy host `fub-nurture-phfprjui.manus.space` hardcoded ×6: `sms_helpers.py:156`, `main.py:3886,3909`, `export_dashboard_data.py:470`, `run_approved_daily_automation.py:320` (env default), `nightly_health.py:1676`. A Manus redeploy hash change breaks every emailed link.
- Agent rosters: `reversePondDeals.ts:23` (hardcodes `28: Abby Martinez`), `botMonitor.ts` bot lists (both dashboards), `agentColors.ts`, `botHelpers.ts` slug maps, `routers.ts:66` (LLM system prompt roster), vs. the live-FUB `agentRegistry.ts`. At least six independently-maintained rosters.

### 1.5 Two full copies of the Manus dashboard scaffold
`nurture-dashboard/` and `lifestyle-bot-dashboard/` each carry the complete `_core/` server runtime and ~50 `components/ui/*` files — near-identical twins (~400 files total). This is a property of the Manus template, noted as accepted-cost rather than a fixable defect.

---

## 2. Dead & stale code

### 2.1 The never-served server layer (Python)
`main.py:7297-7773`: `create_app()` builds a FastAPI app + FUB webhook endpoint (+ HMAC verify, `main.py:7767`) + APScheduler jobs, and `app = create_app()` executes **at import time** (`main.py:7773`). No `uvicorn` invocation exists anywhere (only the dep pin `requirements.txt:2`). Consequences: every runner must set `FUB_DISABLE_SCHEDULER` (7 sites), the test bootstrap must monkey-neuter `BackgroundScheduler.start` (`tests/conftest.py:24-26`), every import constructs a second engine + DB handle, and `fastapi`/`uvicorn`/`apscheduler` are production deps for a server that has never run on Actions.

### 2.2 `if False:` self-modifying-code block
`run_approved_daily_automation.py:164-215` — 50 lines disabled 2026-06-25: generated videos on the retired `/home/ubuntu` VM, then **regex-patched its own `main.py` and a dashboard's `index.ts` on disk**. Behind `if False:` it is provably unreachable. *(Removed in the Phase-2 PR.)*

### 2.3 Output written where no one can read it — daily
`export_dashboard_data.py:510-514` writes exclusively to `/home/ubuntu/fub_nurture_dashboard/...` — a path that exists only on the retired VM. On Actions the writes fail into a warning (`:521-522`), yet the script still runs **every non-dry-run daily** via `refresh_dashboard.sh` (`run_approved_daily_automation.py:271-276`), spending FUB API calls (up to 100-person scan, `:309`) to build JSON that is discarded. `nightly_health.py:178-186,302` additionally re-runs it as a "fix". It also **fabricates click metrics** (`:263-277` — "Irma 12 clicks, Luke 8, … Abby 4") labeled "realistic baseline data" whenever real clicks are absent. Dead in practice; the comment at `run_approved_daily_automation.py:267-270` claims it "runs in GitHub Actions too", which is true but useless.

### 2.4 Retired-but-callable TS engines (~3,459 lines)
Per `heartbeatBootstrap.ts:18-32`, ownership moved to GitHub Actions/Python, crons deleted: `pondNurture.ts` (1,139), `speedToLead.ts` (516), `autoPondPromotion.ts` (311), plus `lifestyleBot.ts` (1,222, partially superseded — `:343` says pondNurture "now handles ALL pond lead emails", itself stale), `reversePondDeals.ts` (271, no scheduled endpoint). Their endpoints remain mounted in `_core/index.ts` (`/api/scheduled/pond-nurture` `:482`, `/api/scheduled/speed-to-lead` `:212`, `/api/scheduled/auto-pond-promotion` `:508`) and their vitest suites still run in CI (`speedToLeadTouch.test.ts`, `powerQueue*` partially, etc.).

### 2.5 Offboarded-agent remnants
**Abby Martinez** (fully offboarded — all references removable):
- `nurture-dashboard/server/botHelpers.ts:1516,1528,2049-2062` (full bot persona incl. `abby@lifestyledesignrealty.com`), `replyIntentHandler.ts:498` (rep-email list — an inbound *from* that mailbox would be treated as a rep, not a lead), `reversePondDeals.ts:23`, `routers.ts:66` (**live LLM system prompt still lists "Abby (Austin)" — and "Tiffany (Austin)" — as agents**), `shared/agentColors.ts:14`, `_core/index.ts:95` (video map)
- `lifestyle-bot-dashboard/server/botEngine.ts:60`, `botMonitor.ts:23` (still monitors "Abby's Lifestyle Bot"), `leadReplyChecker.ts:27`, `botHelpers.ts:1515,1527`, `agent_bots_snapshot.json` (test fixture)
- `pond-nurture-bot/export_dashboard_data.py:273,432` (fake-data blocks)

**Jason Casanova** (left 2026-07-27): correctly excluded in `rules.yaml:67` and `agentRegistry.ts:21`, but `lifestyle-bot-dashboard/server/botMonitor.ts:26` **still monitors "Jason's Lifestyle Bot"**.

### 2.6 Other dead/stale
- `setup_crons.sh` — crontab installer for the retired VM; referenced nowhere. *(Removed in Phase-2 PR.)*
- `fub-automation/data/fub_automation.sqlite3` — tracked 32 KB binary; verified **empty** (all 7 tables 0 rows); the directory name (hyphen) doesn't even match the path TS looks for (underscore). *(Removed in Phase-2 PR; note: git history retains it regardless.)*
- `lifestyle-bot-dashboard/server/legacyGate.ts` (46 lines) — imported by nothing. *(Removed in Phase-2 PR.)*
- pyflakes: 47 findings — 9 unused imports, ~10 unused locals, 2 no-op `global` declarations (`nightly_health.py:841,972`), rest cosmetic f-strings. *(Import/local/global cleanups in Phase-2 PR.)*
- Stale docs at root: `AUDIT_REPORT.md` (Jul 14), `AUDIT_REPORT_FULL_SYSTEM.md` (Aug 1) — point-in-time snapshots that now contradict the code; propose moving under `docs/audits/` with dates.
- `run_approved_daily_automation.py:120-122` — commented-out safety check with rationale; **intentional record, keep**.
- TODO/FIXME inventory: **zero** across all first-party source. Genuinely rare and good.

---

## 3. State & data integrity

### 3.1 Writers and the protocol (sound)
Eight workflows write the `state` branch through `.github/actions/state-sync` (daily-automation, speed-to-lead, reply-detection, nightly-health, weekly-digest, backfill-reengagement, ramp-repair, reply-backfill; investigate-assignments pulls only). The protocol (`state_sync.py`) — shallow fetch of the tip, baseline blob SHA, merge-on-conflict (`state_merge.py`), plumbing commit, fast-forward push as CAS, never force, loud failure — is correct and pinned by real-git tests (`test_state_sync.py`, incl. three-way pileups). Table-level merge rules (ledger union / forward-only clocks / reset-on-assignment) are commutative and fail-loud on unclassified tables. This is the best-engineered corner of the repo.

### 3.2 The store is unsustainable (P0)
- The repo reports **18,737,614 KB (~17.9 GB)**; the `state` branch holds **2,062 commits**, each adding a ~14 MB AES blob git cannot delta-compress, at ~50 commits/day ≈ **+700 MB/day**.
- `--depth=1` (d3d913c) rescued the *jobs* (43-minute cold pulls killed every intraday run on 2026-08-25), but nothing bounds the *branch*. At this rate: ~250 GB/year — GitHub soft limits, slow mirrors/clones, and eventually support intervention.
- Options (roadmap P0-1): (a) scheduled history reset — rewrite `state` to a single orphan commit weekly (the protocol only ever reads the tip; the baseline is a blob SHA, so a rewrite is transparent between runs — needs a brief writer quiesce + one force-with-lease exception to the "never force" rule, done by a dedicated workflow, plus GitHub-side GC via support ticket to reclaim space); (b) move the blob to GitHub Actions artifacts/cache keyed by a tiny pointer commit; (c) real external store (S3/Turso/hosted SQLite). (a) is smallest and keeps the audited protocol intact.

### 3.3 Remaining race windows (bounded, document-level)
The merge preserves *rows*, not *world effects*: two overlapping senders each consult cadence gates against their pull-time snapshot, so a lead due "today" could theoretically be emailed by both the daily run and a concurrently-running backfill before either pushes. In practice only the daily run and explicit repair backfills send nurture mail, and backfills are manually dispatched — risk accepted but worth stating. In-FUB side effects of a **cancelled** speed-to-lead run are a sharper edge: `speed-to-lead.yml:13` sets `cancel-in-progress: true`, so a tick that overruns 5 minutes can be killed *after* posting a warning note but *before* the state push — `warned_at` is lost and the next tick re-warns (duplicate note/task). Low frequency (runs are ~30 s) but real.

### 3.4 SQLite schema
- **Zero secondary indexes** anywhere (`main.py:316-439`, `ramp.py:91`). `audit_log` is the hottest table — `recent_audit_rows` (`main.py:484-492`) filters `action IN (…) AND created_at >=` on every run, plus per-person scans, `weekly_digest.py` aggregations, `telemetry.py`, and `nightly_health.py:1629` filtering on `date(created_at)` (index-defeating expression). Full-table scans on an append-only, never-pruned table. *(Indexes on `(action, created_at)` and `person_id` added in the Phase-2 PR; the `date()` predicates are noted for a later rewrite to range comparisons.)*
- **Unbounded tables:** `audit_log` and `reply_time_log` grow forever; there is no retention policy. Every byte is re-encrypted and re-pushed ~50×/day (multiplying §3.2). Propose 180-day retention for `audit_log` rows whose actions nothing reads beyond 90 days (needs-reply reads 7–90 days; ghost-sweep dedup reads 90).
- `INSERT OR REPLACE` is used only where reset semantics are intended (`assignment_watch`, `main.py:839`); other upserts are explicit `ON CONFLICT` updates; `INSERT OR IGNORE` is used for idempotent enrollments/claims. Semantics are deliberate — no findings beyond documentation.
- `audit_log` consistency: identity-by-payload for merge is sound; statuses are free-text per call site with no enum, so consumers grep loose sets like `('sent','email_sent','completed')` (`nightly_health.py:1629`, `scan_reply_detection`) — drift-prone; propose a constants module.

---

## 4. Error handling

### 4.1 One phase failure kills the rest of the daily run
`run_approved_daily_automation.py:243-265` calls 14 engine phases sequentially with **no isolation**. The Python client raises immediately on any 4xx/5xx after retries (`main.py:988-989` — and 5xx is **not** retried at all), so a single FUB 500 during, e.g., the disqualification scan's candidate fetch aborts pond nurture, seller nurture, agent follow-up, timers, reply detection, and the daily summary for the day. The dead-man's switch does catch it (no success ping), but the blast radius of one transient error is the whole day's automation. Fix shape: per-phase try/except + audit row + continue, exactly like the poll seam in `run_speed_to_lead_check.py:117-131`.

### 4.2 Client retry asymmetry
`main.py:961-993`: retries `ReadTimeout`/`ConnectionError`/429 with exponential backoff; a 500/502/503 raises instantly. The TS `dashboardData.ts:187-218` retries both 429 and 5xx. The Python client is the production-critical one; it should be at least as resilient.

### 4.3 Loop-level isolation is good but uneven
Per-lead try/except with an `error` audit row exists in every daily scan loop spot-checked (`scan_stale_leads` `main.py:3124-3130`, stale-agent `:3157+`, seller nurture, closed drip, disqualification). But `process_new_lead_timers` (`main.py:5607+`) has **no per-timer wrap**: one `get_person` raise skips the remaining timers that tick (self-heals next 5-min tick; still worth the same wrap).

### 4.4 Silent failure census (Python)
17 `except: pass` sites in `main.py`; most are benign cosmetic date-parse guards (e.g. `:1426`, `:1513`, `:4081`, `:5400`). Three are meaningful and should at least `LOGGER.debug`:
- `:3446` — inbound-activity detection swallow (a parse failure can hide a recent inbound and let a disqualification scan skip a lead silently);
- `:6384/:6396` — latest-inbound timestamp swallow inside reply classification (can flip a human reply to "auto" bucketing);
- `:5160` — needs-reply digest source swallow (digest silently loses the auto-reply exclusion set).

### 4.5 Fail-open vs fail-closed
- The untouched-assignment sweep's touch check fails **open** (assume touched) on notes-API errors (`main.py`, legacy mode) — **known and accepted**, per owner; unchanged.
- Speed-to-lead strict mode fails **closed** (PR #24) — an outage cannot cancel a timer. Correct asymmetry, documented in both places.
- `annualNurture.ts` send loop: `sendMail` → FUB note → DB `lastEmailSentAt` update with no claim ledger; a crash between send and update re-sends next run. 365-day cadence makes this minor; the Python seller path solved the same problem with `seller_send_claims` (`main.py:410-425`) — pattern worth copying if annual nurture is kept.

---

## 5. Security & compliance

### 5.1 Power Queue access control (P0)
- **Agent identity requires no secret.** `queueAccess.ts:42-53`: `?agent=<first-name>` matched against the live roster grants agent-scoped access — queue contents and, via `requirePersonOwnership` (`:146-180`), PII reads for every lead assigned to that agent. Ownership *verification* is genuinely implemented and cache-disciplined (the 2026-07-22 deploy note `:199`) — but the identity being verified is a guessable first name in a URL. Anyone who knows an agent's name can read that agent's lead PII.
- **Admin token in email URLs.** Peter's daily clock-in embeds `?admin=<POWER_QUEUE_ADMIN_TOKEN>&agent=all` (pinned by `lifestyle-bot-dashboard/server/clockinAdminUrl.test.ts:56-67`; the test suite properly asserts no other agent receives it). A long-lived bearer token in mail transits providers, link-scanners/prefetchers, browser history, and any forward. Proposal: per-email short-lived HMAC-signed links (exp + scope in the signature) exchanged server-side for a session cookie; rotate the static token to invalidate history.
- Minor: token comparison `queueAccess.ts:37` is `===`, not constant-time.

### 5.2 Hard content rules do NOT hold in every template path
The rule (never reference lead sourcing, foreclosure, divorce, financial circumstances):
- Present: `seller_nurture.py:12` and `:305` ("ABSOLUTELY NEVER reference divorce, foreclosure, financial hardship…").
- **Absent from all nine LLM prompt sites in `main.py`** (`:1210, :1303, :1429, :1536, :1578, :1611, :1710, :1789, :1907` — grep-verified zero prohibition mentions), and absent from `sms_helpers.py` and `annualNurture.ts`'s prompt.
- Worse, the pond-nurture prompt **injects the raw lead source** (`main.py:1434` `Lead source: {lead_source}`) and full note history (`:1439`) with instructions to "reference the most recent note naturally" — if the source is e.g. a distressed-seller list or a note mentions a divorce, nothing forbids the model from echoing it. Fix shape: one shared hard-rules block appended to every lead-facing prompt + drop or sanitize the source line. (Behavior-adjacent to live sends → proposal, not Phase-2.)

### 5.3 The one LIVE TS lead-facing sender is the least compliant (P0)
`annualNurture.ts` (cron `annual-nurture-daily`, `heartbeatBootstrap.ts:53-58` — **live**):
- Emails leads with **no unsubscribe language, no postal address, no TREC IABS/CPN links** (`:235-284` — plain text body straight from the LLM; grep confirms zero TREC/unsubscribe/footer references in the file). Python paths append the full compliant footer (`append_email_footer`, `main.py:7691`, pinned by 25 tests in `test_branding_compliance.py`); this path bypasses all of it. CAN-SPAM requires the opt-out mechanism and postal address; TREC advertising rules require the IABS/CPN.
- **Opt-out is not honored**: the only suppression check is "does the lead still carry `annual nurture only`" (`:249-256`). `replyIntentHandler.ts` applies opt-out by *adding* `opt-out` (`:164` list, `:747+`) without removing the annual tag — an opted-out lead remains eligible for the yearly email. The shared suppression list (`getSharedSuppressionTags`) is imported nowhere in this file.
- No dry-run mode exists for this sender.

### 5.4 Ownership verification on Power Queue procedures
Verified present: `requirePersonOwnership` does a real FUB `assignedUserId` check with a 10-min cache and rejects unassigned/foreign leads (`queueAccess.ts:146-180`); admin bypass is explicit; `accessControl`/`queueAccess*` test files cover it. The weakness is upstream identity (§5.1), not the ownership check.

### 5.5 Secrets & keys
- No hardcoded secrets found (pattern grep for `fka_`, `sk-ant`, `ghp_`, `AKIA`, `xoxb` across source, configs, status, docs).
- `STATE_KEY` handled via env, never argv/logs (`state_sync.py:176-185`) — good.
- **FUB API key reused as a bearer to the Manus dashboard**: `run_approved_daily_automation.py:371-375` sends `Authorization: Bearer <FUB_API_KEY>` to `…manus.space/api/external/write-observation`, which compares it against its own copy (`_core/index.ts:650-654`). The CRM master credential now authenticates a third-party-hosted webhook; a dashboard-side leak burns the CRM key. Propose a dedicated shared secret.
- Webhook HMAC verify exists (`main.py:7767`) but only in the dead server layer.
- `git log` on `main` and `state` carries no plaintext state (encrypted blobs only) — good.

---

## 6. Test quality

### 6.1 Shape
648 Python tests, 49.6 s, zero flakes observed across two full runs. Style is exemplary: regression tests that narrate the incident they pin (`test_state_sync.py`, `test_assignment_changes.py`), real-git integration for the sync protocol, a FakeHttp transport with no live calls. Slowest test 2.49 s (three-way state pileup) — no runtime hotspots. TS: vitest suites across both dashboards (CI-green), including strong compliance pinning (`clockinAdminUrl.test.ts`, branding tests).

### 6.2 Coverage gaps (by module and by behavior)
- **The 30/60-minute escalation transitions are untested.** No test drives `process_new_lead_timers` across `age ≥ warning_minutes` (warning note + task + `mark_warned`) or `age ≥ reassign_minutes` (reassign + late-warning) — the single most business-critical branch in the repo (grep: no test references `reassign_to_peter`/`new_lead_reassigned` behaviorally). *(Added in the Phase-2 PR, clock-independent via `new_lead_timer_mode="24_7"`.)*
- Thin: `controls.py` (1 test file), `state_merge.py` (1, though it's a thorough one), `sms_helpers.py` (2). `nightly_health.py` (1,911 lines) has healthcheck tests but most healer logic is untested.
- No coverage tooling in CI — the map above is grep-inferred; propose `pytest --cov` reporting (measurement only).
- Time-dependence: helpers build timestamps from wall-clock `now`, but no test asserts a *fires* condition dependent on business hours (the discovery suite pins the runner's hours gate with `_ClockShim`). Flake risk low.
- CI runs vitest suites for retired code (`speedToLeadTouch.test.ts` etc.) — wasted signal; retire tests with the engines (roadmap P1-4).

### 6.3 Vacuous-test scan
Assert density is healthy in every file (≥2 asserts/test average; no assert-free files). `test_import_paths.py` looks trivial but pins a real production import-form bug (see its docstring) — not vacuous.

---

## 7. Workflow & ops

### 7.1 Values that must stay in sync
- `ramp.py:63 WORKFLOW_TIMEOUT_MINUTES = 120` ↔ `daily-automation.yml:31 timeout-minutes: 120`. In sync today, guarded by nothing. *(Sync-pinning test added in the Phase-2 PR.)*
- The three suppression_tags.json copies (§1.3): in sync today, guarded by nothing — a sync test is only a band-aid; unify instead (P1-1).
- DST: every cron is UTC with comments like "Adjust to 13:00 UTC when CDT ends (~Nov)" (`daily-automation.yml:1-3`) — manual biannual edits across 5 scheduled workflows. Speed-to-lead already self-gates on CT hours (`run_speed_to_lead_check.py:70`); give the daily the same in-job gate and double-book the cron, or accept the ritual.

### 7.2 Stale comments that lie about behavior
- `daily-automation.yml:71-72` and `reply-detection.yml:98-99` say the state push "checks out the 'state' branch and wipes the working tree" — false since the plumbing rewrite (#9); `state-sync/action.yml:33-40` even documents its own siblings' comments as stale (and its mention of backfill's "Restore the checkout" step is itself stale — that step is already gone). *(All corrected in the Phase-2 PR.)*
- `lifestyleBot.ts:343` ("Pond Nurture now handles ALL pond lead emails") — stale twice over; GH Actions owns it (`heartbeatBootstrap.ts:18-21`).
- `run_approved_daily_automation.py:267-270` dashboard-refresh comment is technically true and materially misleading (§2.3).

### 7.3 Cron overlap & concurrency
Groups are well-designed: the three manual repair workflows share `ldr-state-write` (serialized); scheduled workflows get individual groups; reply-detection documents *why* `cancel-in-progress: false` (`reply-detection.yml:10-16`). Two notes: (1) speed-to-lead's `cancel-in-progress: true` creates the §3.3 lost-write window; (2) daily (12:00 UTC), reply-detection (:00/:10/…), and speed-to-lead (:00/:05/…) all collide at the top of the hour — CAS+merge absorbs it, at the cost of merge-retry work; harmless but worth knowing.

### 7.4 Telemetry commit noise on main (measured)
**233 of 241 commits on `main` in the last 7 days (97%) are `status: telemetry`** (publish-telemetry action, `.github/actions/publish-telemetry/action.yml:2` — "commit them straight to main"). `git log main` is unusable for humans; every checkout/CI fetch carries them; blame on `status/*.json` is meaningless. Proposal: publish to a `telemetry` branch (same plumbing, different ref) or Actions artifacts/Pages; consumers point at the new ref. (Not Phase-2: THE FLOOR's consumer contract must move with it.)

### 7.5 Dependencies
- Python (`requirements.txt`, all pinned — good): behind but not vulnerable-flagged: fastapi 0.115.6→0.141.1, uvicorn 0.34→0.52 (both only serve the dead layer — deleting §2.1 removes them entirely), anthropic 0.120.0→1.1.0 (major; pin is deliberate per its comment), pydantic 2.10→2.13, APScheduler 3.10→3.11 (dead layer).
- npm: `pnpm audit --prod` reports **79 vulns (22 high)** in nurture-dashboard and **82 (22 high, 1 critical — fast-xml-parser <5.3.5 entity-encoding bypass)** in lifestyle-bot-dashboard. Manus-scaffold lockfiles; remediation requires Manus-side checkpoints — P1 proposal, not a local fix.
- `jarvis-build.yml` runs a paid labeled-issue pipeline — label hygiene is the cost control; no findings.

---

## 8. Architecture

### 8.1 main.py: 7,773 lines, 11 classes, one god-class
`RuleEngine` spans `main.py:2109-7272` (~5,100 lines; the file holds 160 methods) and owns: pond nurture, seller/closed/congrats/long-term drips, speed-to-lead timers + assignment watch, untouched-assignment safety net, reply detection + wide sweep + needs-reply, disqualification, agent digests, daily summary, ghost sweep. `nightly_health.py` (1,911 lines) is a second monolith.

**Incremental split (tests green at every step; no behavior change):**
1. `fub_client.py` — move `FollowUpBossClient` + `parse_fub_datetime`/`is_inbound_message` helpers (pure move; `main.py` re-exports so imports/tests don't churn).
2. `db.py` — `AuditDB` (+ the timers migration).
3. `senders.py` — `EmailSender`, `SmsSender`, `append_email_footer`, TREC constants (unifies §1.4's Python copies).
4. `content.py` — `ContentGenerator` + prompts (and the shared hard-rules block from §5.2 lands here once, covering every template).
5. `speed_to_lead.py` — timers + assignment watch + touch checks (RuleEngine keeps thin delegating methods).
6. `reply_detection.py`, then `nurture.py` (pond/drips/seller), then `digest.py` (summary + agent digests).
7. Delete the server layer (§2.1) instead of moving it; runners already never use it.
Each step is a mechanical move + re-export, verifiable by the existing 648 tests (`test_import_paths.py` already pins both import forms).

### 8.2 Deploy-coupled values → config
One `config/deploy.yaml` (or extending rules.yaml): Manus dashboard base URL (×6 sites, §1.4), video CDN map (`main.py` + `_core/index.ts:95`), dashboard observation endpoint + its (new, dedicated) secret, healthcheck slugs. Everything currently requiring a code edit on a Manus redeploy becomes config.

### 8.3 System-boundary observation
The live system is: Python bot on Actions (all lead nurture + timers + digests) / nurture-dashboard (Power Queue UI + 4 live crons: nightly healer, bounce, reply-intent, annual nurture) / lifestyle-bot-dashboard (agent-bot monitoring + clock-in/off). The retired-engine residue (§2.4) makes the boundary illegible to a newcomer — deleting it is the single highest-leverage legibility fix on the TS side.

---

## Prioritized roadmap

**P0 — correctness/compliance/viability exposure now**
| # | Item | Effort | Risk | Cost of NOT doing it |
|---|------|--------|------|----------------------|
| P0-1 | Bound the state store: weekly `state`-branch history reset (orphan tip + support-side GC), or move blob to artifacts/external store; add `audit_log` retention (~180d) to shrink the blob itself | M (1–2 days + support ticket) | M (touch the one protocol that must not silently lose rows — reuse its own tests) | Repo grows ~700 MB/day; 17.9 GB → GitHub limits, slowing every clone/mirror; eventual forced migration under pressure |
| P0-2 | annualNurture compliance: append the standard footer (unsubscribe + address + TREC), check shared suppression tags incl. `opt-out`/`unsubscribed`, have opt-out flow strip `Annual Nurture Only` | S (half-day) + Manus checkpoint | L (additive checks; footer is the tested Python one transliterated) | Live CAN-SPAM/TREC exposure; opted-out leads can be emailed — the exact class of incident the owner most wants never to happen |
| P0-3 | Power Queue identity: short-lived signed links for admin (kill the static token in email); per-agent secret or signed agent links | M (1–2 days) + Manus checkpoint | M (breaks bookmarked links; needs link regeneration in clock-ins) | Lead PII readable by anyone who can guess a first name; admin token replay from any forwarded/scanned email |

**P1 — structural debt with active drift risk**
| # | Item | Effort | Risk | Cost of NOT |
|---|------|--------|------|-------------|
| P1-1 | Denylist unification: single shared source (suppression_tags.json-style JSON consumed by rules.yaml loader + both dashboards), delete the 4 TS copies | M | M (Manus deploys) | Next offboarding repeats the Tiffany/Jason drift; retired-engine endpoints still carry stale lists |
| P1-2 | Daily-run phase isolation: wrap each of the 14 phases (`run_approved_daily_automation.py:243-265`) in try/except + audit row, mirroring the runner's poll seam | S | L | One transient FUB 500 silently cancels whole days of nurture/digests |
| P1-3 | Retry 5xx in the Python FUB client (bounded, same backoff as 429) | S | L | Daily phases die on transient CRM blips (feeds P1-2) |
| P1-4 | Delete retired TS engines + endpoints + their tests (pondNurture, speedToLead, autoPondPromotion, reversePondDeals, lifestyleBot residue) | M + Manus checkpoint | M | ~3,400 lines of callable stale logic (no TREC, stale denylists) one manual POST away from production; boundary illegible |
| P1-5 | Shared hard-content-rules block in every lead-facing prompt; sanitize/drop `Lead source:` injection (`main.py:1434`) | S | M (changes live email generation — stage behind dry-run diffing) | Model can echo sourcing/foreclosure/divorce from notes into a lead's inbox |
| P1-6 | Telemetry off `main` (telemetry branch or artifacts; migrate THE FLOOR's reader) | S/M | L | main history 97% noise; every fetch drags it |
| P1-7 | Offboarding sweep: remove Abby everywhere (incl. `routers.ts:66` prompt roster, `replyIntentHandler.ts:498`), drop Jason from `botMonitor.ts:26`; write the offboarding checklist doc | S + Manus checkpoint | L | Stale personas in live LLM prompts; monitor pages for a bot that shouldn't exist; rep-email misclassification |
| P1-8 | Dedicated shared secret for the dashboard observation endpoint (stop reusing FUB_API_KEY) | S | L | Dashboard-side leak = CRM master key leak |
| P1-9 | Delete the dead server layer (`create_app`/webhook/APScheduler + fastapi/uvicorn/apscheduler deps) | S/M | L (grep-clean + suite green; conftest un-neuters) | Import-time side effects forever; 3 heavyweight deps patched for nothing |
| P1-10 | npm vulnerability remediation in both dashboards (starting with critical fast-xml-parser) | M + Manus checkpoints | M | 1 critical + 44 high advisories in production servers holding lead PII |

**P2 — quality-of-life / long-horizon**
| # | Item | Effort | Risk | Cost of NOT |
|---|------|--------|------|-------------|
| P2-1 | main.py domain split per §8.1 (7 mechanical steps, suite green each) | L | M | Every change pays the god-class tax; onboarding cost compounds |
| P2-2 | TS FUB client consolidation onto `botHelpers.fubRequest` w/ retry | M | M | 12 clients × inconsistent retry/error behavior |
| P2-3 | Retire `export_dashboard_data.py` + `refresh_dashboard.sh` + nightly re-runs (or rewire to a real consumer); delete fake-data blocks | S | L | Daily wasted FUB quota; fabricated metrics ready to surface |
| P2-4 | DST-proof scheduling (in-job CT gates + dual crons) | S | L | Biannual manual edits; a missed edit shifts every send by an hour |
| P2-5 | Config extraction for deploy-coupled values (§8.2) | M | L | Manus redeploys require code edits in 6+ places |
| P2-6 | audit_log status constants module; replace `date(created_at)` predicates with range scans | S | L | Status-string drift between writers and readers |
| P2-7 | Coverage reporting in CI; nightly_health test debt | M | L | Blind spots stay invisible |
| P2-8 | Archive stale root audits under `docs/audits/` | S | L | Contradictory documentation at the front door |

---

## Phase-2 safe fixes applied (this PR)

Per the allowed list only — dead code removal, unused imports, stale comment corrections, missing indexes, added tests. **Zero behavior changes to production sends**; every removal is provably unreachable or unreferenced; full suite green before and after.

1. Removed the `if False:` self-modifying block (`run_approved_daily_automation.py:164-215`) and its dead imports.
2. Deleted `setup_crons.sh` (retired-VM crontab, referenced nowhere).
3. Deleted `fub-automation/data/fub_automation.sqlite3` (tracked empty-schema binary, all tables 0 rows, path referenced nowhere).
4. Deleted `lifestyle-bot-dashboard/server/legacyGate.ts` (imported nowhere; tsc + vitest green).
5. pyflakes cleanup: 9 unused imports, provably-unused locals, 2 no-op `global` declarations.
6. Added SQLite indexes `idx_audit_log_action_created` and `idx_audit_log_person` (`AuditDB._init`, `CREATE INDEX IF NOT EXISTS`) + a schema test; read-path only, merge rules untouched (state_merge copies rows, not schema objects).
7. Corrected the stale state-push comments (`daily-automation.yml`, `reply-detection.yml`, `state-sync/action.yml`).
8. Added the missing escalation-transition tests: 30-min warning fires (note + task + `warned_at`), 60-min reassignment fires (incl. late-warning path) — clock-independent via `24_7` timer mode.
9. Added a sync-guard test pinning `ramp.WORKFLOW_TIMEOUT_MINUTES` to `daily-automation.yml`'s `timeout-minutes`.

Verification: pyflakes clean (cosmetic f-strings aside), byte-compile clean, Python suite **654 passed** (648 baseline + 6 new), `tsc --noEmit` and vitest green in lifestyle-bot-dashboard after the `legacyGate.ts` deletion. One incidental find during cleanup: the removed `city_focus` block was silently spending **one FUB notes GET per lead in every agent digest** and discarding the result.

Everything else above is deliberately **not** implemented here and lives in the roadmap.
