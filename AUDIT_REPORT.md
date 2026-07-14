# Agent Bot Brain Upgrade — Independent Audit Report

**Auditor:** Claude (independent code auditor)
**Date:** 2026-07-14
**Scope:** Verify Manus's "Agent Bot Brain Upgrade" against the 5-item spec; fix defects; iterate until green.
**Baseline audited:** commits since `f67bf85` on `main`, including Manus's implementation `4591554` + `0010b2c` (pushed mid-audit).

---

## Verdict: 10/10 after audit fixes (Manus's implementation as delivered: 7/10)

Manus's `4591554` implemented all five spec items in `lifestyle-bot-dashboard/server/botHelpers.ts` and the pond-bot prompt addition, with reasonable structure and a strong generation prompt. The audit found and fixed one **critical spec violation** (the 24h check treated bot notes as human), one **silent-failure defect** (no DB migration for the angle table, masked by a try/catch), a **quality regression risk** (generic fallback email on LLM failure), a **weak URL test** (source-grep instead of asserting the call), **9 failing tests**, **21 TypeScript errors**, and **2 PII issues**.

| # | Spec item | Manus | After audit | Evidence (file:line on final main) |
|---|-----------|-------|-------------|------------------------------------|
| 1 | Anthropic direct (api.anthropic.com, claude-sonnet-4-6, ANTHROPIC_API_KEY); zero Forge LLM refs; test asserts URL is called | PASS with gaps — direct `fetch` calls in `botHelpers.ts`, but the Forge LLM client `_core/llm.ts` remained (imported by dead files) and the "URL test" only grepped source text | **PASS** — Forge LLM client and its dead importers deleted; `agentBotBrain.test.ts` mocks fetch and asserts the URL, model, and `x-api-key` header on real calls | `botHelpers.ts` `shouldSkipLead`/`generateFollowUpMessage` fetch blocks; `server/agentBotBrain.test.ts` |
| 2 | Full context: 20 dated notes, source, price range, city/market, days since assignment, engagement recency | PASS | **PASS** (verified behaviorally: all fields asserted present in the actual prompt string) | `botHelpers.ts` `buildLeadContext` (20 notes, `[YYYY-MM-DD]`), LEAD CONTEXT block |
| 3 | Five angles, last angle in a persistent store, never repeated consecutively | PARTIAL — five angles + `pickAngle` + `emailAngleLog` schema entry, but **no migration was generated**, so the live DB never gets the table; `0010b2c`'s try/catch silently swallows that, meaning rotation would never persist and angles could repeat | **PASS** — migration `drizzle/0003_wild_wolfsbane.sql` added (must be applied in deployment, see below) | `drizzle/schema.ts` `emailAngleLog`; `botHelpers.ts` `pickAngle`/`saveAngle` |
| 4 | Temporal reasoning in generation prompt; same instruction in pond bot | PASS — agent-bot prompt items 7–8; pond bot `main.py` TEMPORAL REASONING line added (date-awareness + dated note history already existed there since Tier 3) | **PASS** | `botHelpers.ts` prompt; `pond-nurture-bot/src/fub_automation/main.py:937` |
| 5 | Skip gate: intent check + 24h agent note; bot notes must NOT count; person_id-only logging | **FAIL on the bot-note requirement** — the 24h check skipped on ANY recent note; bot notes carry no `userId`, which the code treated as "assume human". Automation notes (bot sends, `Automation:` reply-detection notes written every 10 min) could permanently block sends. A test even codified this as a "fail-safe". | **PASS** — `isBotAuthoredNote()` marker detection; bot notes ignored by the 24h gate, human notes still skip; skip decisions logged with person_id only; LLM told to keep names out of its reason | `botHelpers.ts` `isBotAuthoredNote` + 24h loop; behavioral tests in `agentBotBrain.test.ts` |

**Final test state:** `lifestyle-bot-dashboard` 58 passed / 4 env-gated skips / 0 failed, `tsc --noEmit` clean (was 21 errors); `nurture-dashboard` 67 passed / 17 env-gated skips / 0 failed (was 16 failures, including all four of Manus's own Anthropic-URL tests — `ENV.anthropicApiKey` was snapshotted at import, before the tests set the key); `pond-nurture-bot` has no test suite (spec: "if present"); `py_compile` clean.

**Grep-proof:** zero `forge`/`BUILT_IN`/`manus.im` **LLM** references remain anywhere in `lifestyle-bot-dashboard` — the Forge LLM client is deleted outright. Remaining matches are non-LLM Manus WebDev platform plumbing the hosted app needs (file storage, heartbeat cron scheduler, maps proxy, notifications, image/voice helpers in `_core/`), an email-domain exclusion list in `leadReplyChecker.ts:35` (classifies `manus.im` senders as internal — correct behavior, not an LLM ref), and the English word "forgetting" in marketing copy. Both `brainUpgrade.test.ts` (Manus's) and `agentBotBrain.test.ts` (audit's) now guard this permanently.

---

## Audit-fix commits

| SHA | Description |
|-----|-------------|
| `6d240a5` | Skip gate: bot-authored notes no longer count as human (marker-based `isBotAuthoredNote`); removed the generic fallback email on Anthropic failure (bot now records an error and sends nothing); person_id-only skip logging + PRIVACY line in the skip prompt; `hasDncTag` matches hyphenated variants |
| `def935f` | Added the missing drizzle migration for `email_angle_log` (angle persistence would silently no-op on the live DB forever); `ENV.anthropicApiKey` is now a lazy, sanitized getter |
| `2fb4b25` | Behavioral test suite `agentBotBrain.test.ts` (asserts the Anthropic URL is actually CALLED with claude-sonnet-4-6, full context + temporal text reaches the prompt, bot-note/human-note 24h behavior, fail-open, no-fallback); repaired 5 stale `bots.test.ts` assertions; env-gated secret tests |
| `452b03f` | Deleted `dashboardData.ts`/`lifestyleBot.ts`/`pondNurture.ts` (never-compiling dead copies synced from nurture-dashboard; 21 tsc errors) and the now-orphaned Forge LLM client `_core/llm.ts`; removed a lead email address from a log line |
| `ef8dc80` | nurture-dashboard: lazy `anthropicApiKey` getter (makes Manus's four Anthropic-URL tests pass), env-gated live-API/SMTP/DB tests, replaced a dead `/home/ubuntu/...` path assertion retired at the GitHub Actions cutover |

## Regression checks (spec item e) — all intact

- **From-name** `"<Agent> | Lifestyle Design Realty"`: `main.py:3167` (digest) and `:4448` (welcome) — untouched.
- **BCC `peter@lifestyledesignrealty.com`**: `main.py:3176` and `:4457` — untouched. (This feature lives in the Python system per commit `3688f55`; TS bot emails send from the agent's address as before, with the full email logged to a FUB note and `contacted_leads`.)
- **Shared suppression list** `config/suppression_tags.json`: still consulted by both systems; file unmodified. TS matching now also catches hyphenated variants — strictly more protective.
- **"Replied - Paused"**: still present in the shared JSON, the TS fallback list, and four hardcoded Python suppress sets.
- **Caps/cadences/recipients/schedules**: 15/bot/run, 3–19 day window, 3-day gap, 14-day pond cadence, 100/day caps, clock emails, and `.github/workflows/` — all unchanged.

## Prompt quality (rubric item)

Manus's rewritten generation prompt is genuinely good: dated 20-note history, named freshness angle with the previous angle banned, temporal reasoning with concrete worked examples ("lease ends in August" → "your lease is coming up next month, right?"), anti-hallucination rules (never claim listings were sent unless a note says so; no invented personal details; destination-only relocation references), single greeting, one easy question, 80–150 words. The audit's only quality change was removing the generic fallback email, which would have sent exactly the "just checking in" blast the prompt forbids whenever Anthropic hiccuped.

## Could NOT verify from the repo alone — requires human verification

1. **The live Manus-hosted deployment** (`lifestyledash-wpnl8v84.manus.space`): this repo is a code mirror; the upgraded code must be synced to the Manus WebDev project and redeployed. Note the audit deleted `server/pondNurture.ts` / `lifestyleBot.ts` / `dashboardData.ts` as dead code **in this repo** — if the live Manus project somehow wires those files, sync selectively.
2. **`ANTHROPIC_API_KEY` on the Lifestyle Bot Dashboard deployment** — without it, bots cannot generate emails (skip checks fail open; generation now errors instead of sending a generic email).
3. **Apply migration 0003** (`email_angle_log`) to the live MySQL DB (`pnpm db:push` in the deployment). Until then angle rotation does not persist across runs.
4. **`claude-sonnet-4-6` availability on the dashboard's Anthropic account** — verified by Manus for the nurture-dashboard key only.
5. **Actual email rendering/delivery** (SMTP auth, HTML, deliverability) — nothing in the repo exercises a real send.
6. **FUB payload assumptions** — `notes[].userId`, `source`, `priceRange`/`price`, `addresses`, `created` on `/people?includeNotes=true`; standard FUB fields, but the account's real payloads weren't observable here. If FUB uses `createdById` instead of `userId` on notes, the 24h gate still works (bot-marker + treat-unknown-as-human), just without per-agent attribution.
7. **Pre-existing, out of scope:** pond bot Phase 3 "local spots" enrichment (`main.py:1553`) still calls the Forge **Maps proxy** (not an LLM). On GitHub Actions those env vars are absent, so it logs a warning and sends drip emails without local-spots data. Decide whether to move it to a direct Google Places key or retire it.

## 3 things a human should spot-check in production

1. **Read the first 2–3 live bot emails after deploy** (full text is in each lead's FUB note and `contacted_leads`): confirm they reference only real, correctly-dated events — no resurrected "this Friday" from an old note, no "the listings I sent" when none were sent, and the temporal touches ("lease coming up next month, right?") are accurate.
2. **Query `email_angle_log` after two send cycles for the same lead** and confirm consecutive angles differ; confirm `bot_run_logs` populates and the 6pm clock-off emails show non-zero stats.
3. **Skip-gate live check:** write a manual agent note on a test lead → the bot must skip it for 24h with the reason in a FUB note; a lead whose only fresh note is bot-authored (`[… Lifestyle Bot] …` or `Automation: …`) must NOT be skipped for that reason; and a pond email still arrives From "Peter | Lifestyle Design Realty" with BCC to peter@.
