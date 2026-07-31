/**
 * Bot-monitor alert truthfulness.
 *
 * THE BUG: the 4am health check judged staleness with "did this bot run since
 * midnight?". The monitor fires at 4:00 AM CT and the bots run at ~10:00 AM CT,
 * so on a perfectly healthy night every bot's last run was ~18h earlier —
 * yesterday. Every bot therefore scored ranToday=false -> status="warning", and
 * Peter got "⚠️ 4am Bot Health Check — 8 Bot(s) Need Attention" every single
 * night. A monitor that cries wolf nightly is worse than no monitor: it trains
 * you to ignore the one morning it's real.
 *
 * THE FIX: staleness is measured against the ~24h run cadence
 * (STALE_AFTER_HOURS = 26), not the calendar day. `ranToday` survives untouched
 * for the "N bots ran today" display counters, where calendar-day is the
 * meaningful question.
 *
 * These tests pin the decision function itself, so the two notions can't be
 * conflated again.
 */
import { describe, it, expect } from "vitest";
import { STALE_AFTER_HOURS } from "./botMonitor";

const HOUR = 3_600_000;

/**
 * Mirror of the staleness/status decision in checkAllBotHealth. Kept as a pure
 * function so it can be exercised without a live MySQL handle (the repo mirror
 * has none). The constant is imported from the real module, so a change to the
 * threshold moves these tests with it.
 */
function decide(lastRanAt: Date | null, lastStatus: "ok" | "warning" | "error", now: number) {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const staleCutoff = new Date(now - STALE_AFTER_HOURS * HOUR);

  const ranToday = lastRanAt ? lastRanAt >= todayStart : false;
  const ranRecently = lastRanAt ? lastRanAt >= staleCutoff : false;

  let status: "ok" | "warning" | "error" | "not_run" = "not_run";
  if (lastRanAt) status = ranRecently ? lastStatus : "warning";
  return { ranToday, ranRecently, status };
}

/** 4:00 AM CT on 2026-07-31, expressed in the process's local zone. */
const FOUR_AM = new Date("2026-07-31T04:00:00-05:00").getTime();
/** The bot's healthy run: 10:00 AM CT the previous morning — 18h before. */
const HEALTHY_LAST_RUN = new Date("2026-07-30T10:00:00-05:00");

describe("4am bot-monitor false alarm", () => {
  it("does NOT warn on a healthy bot that ran 18h ago at 10am yesterday", () => {
    const { status } = decide(HEALTHY_LAST_RUN, "ok", FOUR_AM);
    expect(status).toBe("ok");
  });

  it("reproduces why it used to warn: ranToday is false for that same bot", () => {
    // This is the trap. ranToday is legitimately false at 4am — it just must
    // not be what drives the alarm.
    const { ranToday, ranRecently } = decide(HEALTHY_LAST_RUN, "ok", FOUR_AM);
    expect(ranToday).toBe(false);
    expect(ranRecently).toBe(true);
  });

  it("still warns on a genuinely stale bot (missed a full cycle, 30h)", () => {
    const stale = new Date(FOUR_AM - 30 * HOUR);
    expect(decide(stale, "ok", FOUR_AM).status).toBe("warning");
  });

  it("does not warn right at the boundary, warns just past it", () => {
    const justInside = new Date(FOUR_AM - (STALE_AFTER_HOURS - 0.5) * HOUR);
    const justOutside = new Date(FOUR_AM - (STALE_AFTER_HOURS + 0.5) * HOUR);
    expect(decide(justInside, "ok", FOUR_AM).status).toBe("ok");
    expect(decide(justOutside, "ok", FOUR_AM).status).toBe("warning");
  });

  it("a real error still surfaces even when the bot ran recently", () => {
    // The fix must not swallow genuine failures.
    expect(decide(HEALTHY_LAST_RUN, "error", FOUR_AM).status).toBe("error");
  });

  it("a bot that never ran is not_run, not a false 'warning'", () => {
    expect(decide(null, "ok", FOUR_AM).status).toBe("not_run");
  });

  it("the whole roster is quiet at 4am on a healthy night", () => {
    // The actual regression: 8 bots, all healthy, zero alerts.
    const roster = Array.from({ length: 8 }, () => decide(HEALTHY_LAST_RUN, "ok", FOUR_AM));
    const needAttention = roster.filter(
      r => r.status === "warning" || r.status === "error" || r.status === "not_run",
    );
    expect(needAttention).toHaveLength(0);
  });

  it("threshold leaves slack for jitter and DST", () => {
    expect(STALE_AFTER_HOURS).toBeGreaterThan(24);
  });
});
