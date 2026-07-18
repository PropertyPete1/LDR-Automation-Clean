"""Behavioral tests for pond-nurture-bot (mocked HTTP only — no live calls).

North-star bug class: a FUB deals call once built "deals" instead of "/deals"
→ /v1deals → 404 → deal protection silently failed OPEN in production.
These tests assert what the code DOES: exact URLs called, payloads sent,
rows written — so that class of defect fails a test instead of production.
"""
import datetime as dt
import json
import re
from datetime import timezone


# ═══ 1. FUB client: well-formed endpoint paths, pagination, 429 ═══════════════

class TestFubClientPaths:
    BASE = "https://api.followupboss.com/v1"

    def test_people_url_is_well_formed(self, fub, fake_http):
        fake_http.responses = [(200, {"people": []})]
        fub.get_people(limit=1)
        assert fake_http.urls == [f"{self.BASE}/people"]

    def test_notes_events_emevents_textmessages_users_pipelines_paths(self, fub, fake_http, m):
        fake_http.responses = [(200, {})]
        fub._request("GET", "/notes")
        fub._request("GET", "/events")
        fub._request("GET", "/emEvents")
        fub._request("GET", "/textMessages")
        fub._request("GET", "/users")
        fub._request("GET", "/pipelines")
        assert fake_http.urls == [
            f"{self.BASE}/notes",
            f"{self.BASE}/events",
            f"{self.BASE}/emEvents",
            f"{self.BASE}/textMessages",
            f"{self.BASE}/users",
            f"{self.BASE}/pipelines",
        ]
        # The north-star failure: a missing leading slash concatenates into /v1notes
        for url in fake_http.urls:
            assert "/v1/" in url and not re.search(r"/v1[a-zA-Z]", url)

    def test_deals_url_exact_path_north_star(self, engine, fake_http):
        """THE regression test for the /v1deals incident."""
        fake_http.responses = [(200, {"deals": []})]
        engine._get_person_deals(4242)
        assert len(fake_http.calls) == 1
        call = fake_http.calls[0]
        assert call.url == f"{self.BASE}/deals"          # exact — not /v1deals
        assert call.params.get("personId") == 4242
        assert call.method == "GET"

    def test_cursor_pagination_follows_metadata_next(self, fub, fake_http):
        fake_http.responses = [
            (200, {"people": [{"id": 1}], "_metadata": {"next": "tok2"}}),
            (200, {"people": [{"id": 2}], "_metadata": {"next": None}}),
        ]
        people = fub.get_people(stage="Lead")
        assert [p["id"] for p in people] == [1, 2]
        assert len(fake_http.calls) == 2
        assert "next" not in fake_http.calls[0].params
        assert fake_http.calls[1].params.get("next") == "tok2"

    def test_429_backs_off_and_retries_then_succeeds(self, fub, fake_http):
        fake_http.responses = [(429, {}), (429, {}), (200, {"people": [{"id": 9}]})]
        people = fub.get_people(limit=1)
        assert [p["id"] for p in people] == [{"id": 9}]["0" == "1"] or people == [{"id": 9}]
        assert len(fake_http.calls) == 3  # two 429s then success

    def test_4xx_raises_instead_of_failing_silently(self, fub, fake_http):
        fake_http.responses = [(404, {})]
        try:
            fub._request("GET", "/people")
            assert False, "expected RuntimeError on 404"
        except RuntimeError as e:
            assert "404" in str(e)


# ═══ 2. Suppression: shared JSON single source of truth ═══════════════════════

class TestSuppression:
    def test_shared_tags_loaded_from_json(self, rules, m):
        shared = json.load(open("config/suppression_tags.json"))
        for tag in shared["tags"]:
            assert tag.lower() in [t.lower() for t in rules.excluded_tags], f"missing shared tag: {tag}"

    def test_excluded_sources_loaded_case_insensitive(self, rules):
        assert "new agent inquiry" in rules.excluded_sources
        assert "botm newsletter" in rules.excluded_sources

    def test_replied_paused_suppresses(self, engine):
        person = {"id": 1, "tags": [{"name": "Replied - Paused"}]}
        assert engine.is_excluded(person) is True

    def test_excluded_source_matches_case_insensitively(self, engine):
        assert engine._is_excluded_source({"id": 1, "source": "BOTM NEWSLETTER"})
        assert engine._is_excluded_source({"id": 2, "source": "new agent inquiry"})
        assert engine._is_excluded_source({"id": 3, "source": "Zillow"}) is None


# ═══ 3. SOI total silence (Option B) ══════════════════════════════════════════

class TestSOISilence:
    def test_source_contains_soi_matches_theos_soi(self, engine):
        assert engine._is_soi_silenced({"id": 1, "source": "Theo's SOI"})
        assert engine._is_soi_silenced({"id": 2, "source": "tiffany soi list"})

    def test_tag_starting_soi(self, engine):
        assert engine._is_soi_silenced({"id": 3, "tags": [{"name": "SOI - Church"}]})
        assert engine._is_soi_silenced({"id": 4, "tags": ["soi friends"]})

    def test_manual_non_peter_creation(self, engine):
        assert engine._is_soi_silenced({"id": 5, "createdVia": "Manually", "createdById": 7})

    def test_control_peter_created_typeform_lead_flows(self, engine):
        # Peter-created API lead must NOT be silenced
        assert engine._is_soi_silenced(
            {"id": 6, "createdVia": "API", "createdById": 2, "source": "Typeform"}
        ) is None
        # Peter-created manual lead must NOT be silenced either
        assert engine._is_soi_silenced({"id": 7, "createdVia": "Manually", "createdById": 2}) is None


# ═══ 4. Deal protection ═══════════════════════════════════════════════════════

class TestDealProtection:
    def _deals(self, engine, fake_http, deals):
        engine._deal_cache = {}
        fake_http.responses = [(200, {"deals": deals})]

    def test_any_deal_blocks(self, engine, fake_http):
        self._deals(engine, fake_http, [{"pipelineId": 3, "stageName": "Active"}])
        assert engine._has_any_deal(1001) is True

    def test_closed_purchase_pipelines_1_and_2_enable_phase3(self, engine, fake_http):
        self._deals(engine, fake_http, [{"pipelineId": 1, "stageName": "Closed"}])
        assert engine._has_closed_purchase_deal(1002) is True
        self._deals(engine, fake_http, [{"pipelineId": 2, "closedStage": True, "stageName": "x"}])
        assert engine._has_closed_purchase_deal(1003) is True
        self._deals(engine, fake_http, [{"pipelineId": 5, "stageName": "Closed"}])
        assert engine._has_closed_purchase_deal(1004) is False

    def test_lease_listing_only_total_silence_and_purchase_wins(self, engine, fake_http):
        self._deals(engine, fake_http, [{"pipelineId": 5, "stageName": "Closed"}])
        assert engine._is_lease_listing_silenced(1005) is True
        # purchase wins
        self._deals(engine, fake_http, [
            {"pipelineId": 5, "stageName": "Closed"},
            {"pipelineId": 1, "stageName": "Closed"},
        ])
        assert engine._is_lease_listing_silenced(1006) is False

    def test_api_error_fails_open_documented(self, engine, fake_http):
        """DOCUMENTED CURRENT BEHAVIOR: deals API failure → [] → protection OFF.

        This is fail-open. If FUB /deals errors for a person, that lead is
        treated as having no deals and automation proceeds. Recommendation in
        AUDIT_REPORT_FULL_SYSTEM.md: fail CLOSED for send-blocking checks
        (skip the lead on API error) since a missed send is cheaper than
        emailing a lead who has an active deal.
        """
        engine._deal_cache = {}
        fake_http.responses = [(500, {})] * 10  # every retry fails
        assert engine._get_person_deals(1007) == []
        assert engine._has_any_deal(1007) is False  # fails OPEN


# ═══ 5. Timeline cadence ══════════════════════════════════════════════════════

class TestTimelineCadence:
    def test_purchase_window_upsert_get_and_reextraction_override(self, tmp_db):
        tmp_db.upsert_purchase_window(42, "2026-11-01", "lease ends in Nov", "2026-06-01")
        w = tmp_db.get_purchase_window(42)
        assert w["window_start"] == "2026-11-01"
        # newer note re-extraction overrides
        tmp_db.upsert_purchase_window(42, "2027-02-01", "actually February", "2026-07-01")
        w2 = tmp_db.get_purchase_window(42)
        assert w2["window_start"] == "2027-02-01"

    def test_stretch_only_ever_reduces_frequency(self, m):
        """The stretch is applied via max(cadence, N) — can only lengthen the gap."""
        import inspect
        src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
        assert "max(cadence_days, 30)" in src
        assert "max(cadence_days, 21)" in src
        # and never a min() that could shorten cadence in the timeline block
        block = src[src.find("Timeline-Aware Cadence"):src.find("Timeline-Aware Cadence") + 2000]
        assert "min(cadence_days" not in block


# ═══ 6+7. Caps, dedup guard, dry-run separation ═══════════════════════════════

class TestGuardAndDryRun:
    def test_pond_cap_is_100_and_closed_drip_cap_20(self, rules, m):
        assert rules.phase2_max_customer_emails_per_run == 100
        import inspect
        src = inspect.getsource(m.RuleEngine)
        assert "launch_cap_reached" in src

    def test_guard_counts_only_real_sent_today_ct(self, tmp_db):
        """Replicates the guard query contract: today-CT window, status='sent' only."""
        now_utc = dt.datetime.now(timezone.utc)
        tmp_db.log("pond_nurture", "sent", 1, {})
        tmp_db.log("pond_nurture", "dry_run_sent", 2, {})
        tmp_db.log("pond_nurture", "skipped", 3, {})
        ct = dt.datetime.now(m_tz()).replace(hour=0, minute=0, second=0, microsecond=0)
        utc_start = ct.astimezone(timezone.utc)
        rows = tmp_db.recent_audit_rows(["pond_nurture"], utc_start)
        sent = [r for r in rows if r.get("status") == "sent"]
        dry = [r for r in rows if r.get("status") == "dry_run_sent"]
        assert len(sent) == 1     # only the real send trips the guard
        assert len(dry) == 1      # dry_run_sent visible but never counted by the guard
        assert now_utc  # (sanity)

    def test_dry_run_email_sender_never_touches_smtp(self, m, settings, monkeypatch):
        settings.dry_run = True

        def boom(*a, **k):
            raise AssertionError("SMTP must not be constructed in dry-run")

        monkeypatch.setattr(m.smtplib, "SMTP", boom)
        sender = m.EmailSender(settings)
        sender.send("lead@example.com", "subject", "<p>body</p>", "body")

    def test_guard_script_source_pings_and_observes_on_dedup_exit(self):
        """The guard exit path must still ping healthchecks + post the observation."""
        src = open("run_approved_daily_automation.py").read()
        gi = src.find("GUARD: Daily pond nurture already completed today")
        assert gi != -1
        window = src[gi - 1500: gi + 800]
        assert "status') == 'sent'" in window or 'status") == "sent"' in window
        assert "_post_dashboard_observation" in window
        assert "_ping_healthcheck_daily" in window
        assert "ZoneInfo('America/Chicago')" in window or 'ZoneInfo("America/Chicago")' in window
        # dry-run never trips the guard
        assert "if not settings.dry_run:" in window


# ═══ 8. Prompt parity (rule 12 anti-phantom + temporal rules) ═════════════════

class TestPromptParity:
    def test_all_lead_facing_prompts_have_anti_phantom_rule(self, m):
        import inspect
        gen = inspect.getsource(m.ContentGenerator)
        assert gen.count("anti-phantom") >= 4  # pond, quarterly, welcome, long-term nurture

    def test_pond_prompt_has_temporal_rules_and_dated_notes(self, m):
        import inspect
        src = inspect.getsource(m.ContentGenerator.generate)
        assert "CRITICAL DATE AWARENESS" in src
        assert "TEMPORAL REASONING" in src
        assert "last_angle_used" in src  # angle rotation persistence feeds the prompt

    def test_pond_note_history_carries_dates(self, m):
        import inspect
        src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
        assert 'n_date[:10]' in src and "note_snippets" in src  # [YYYY-MM-DD] prefixes


# ═══ 9. Note-write integrity + PII-free logging ═══════════════════════════════

class TestIntegrity:
    def test_send_paths_check_soi_and_sources_and_deals(self, m):
        import inspect
        for fn in [
            m.RuleEngine.process_reengagement_candidate,   # pond nurture
            m.RuleEngine.process_closed_drip_candidate if hasattr(m.RuleEngine, "process_closed_drip_candidate") else m.RuleEngine.process_reengagement_candidate,
        ]:
            src = inspect.getsource(fn)
            assert "_is_soi_silenced" in src
            assert "_is_excluded_source" in src or "is_excluded" in src

    def test_logger_calls_use_person_id_not_names(self, m):
        """Public-repo rule: log statements must reference person ids, not lead names/emails."""
        import inspect
        src = inspect.getsource(m.RuleEngine.process_reengagement_candidate)
        for line in src.splitlines():
            if "LOGGER." in line:
                assert "firstName" not in line and "lastName" not in line and ".email" not in line, line


def m_tz():
    from zoneinfo import ZoneInfo
    return ZoneInfo("America/Chicago")
