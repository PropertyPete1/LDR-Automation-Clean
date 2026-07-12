/**
 * spBot.ts — S&P500 Lifestyle Bot
 * Works for BOTH Steven Van Orden (FUB ID: 1) and Peter Allen (FUB ID: 2).
 * Follows all non-pond, non-Hot-Prospect, non-Active-Client leads 20+ days stale.
 * Sends personalized AI-generated emails to leads from the agent's email address.
 * Clock-in: 10am CT | Clock-off: 6pm CT | Recipients: Peter + Steven always.
 */

import {
  MAX_LEADS_PER_RUN,
  fetchLeadsForAgent,
  isEligible,
  shouldSkipLead,
  wasContactedRecently,
  daysStale,
  generateFollowUpMessage,
  sendLeadFollowUpEmail,
  extractEmail,
  postFubNote,
  getSmsSentTodayIds,
  recordSmsSentToday,
  logContactedLead,
  sendClockinEmail,
  sendClockoffEmail,
  writeObservation,
  logBotRun,
  PETER_EMAIL,
  STEVEN_EMAIL,
  fetchPowerQueueCount,
} from "./botHelpers";

const BOT_NAME = "S&P500 Lifestyle Bot";
const BOT_SLUG = "sp500";
const OBSERVATION_SOURCE = "sp500_bot";

const AGENTS = [
  { fubId: 1, firstName: "Steven", lastName: "Van Orden", email: STEVEN_EMAIL },
  { fubId: 2, firstName: "Peter", lastName: "Allen", email: PETER_EMAIL },
];

const PETER_AGENT = { fubId: 2, firstName: "Peter", lastName: "Allen", email: PETER_EMAIL };
const STEVEN_AGENT = { fubId: 1, firstName: "Steven", lastName: "Van Orden", email: STEVEN_EMAIL };

/** Run the bot for a single agent — avoids 2-min heartbeat timeout when running both together */
async function runSpBotForAgent(
  agent: { fubId: number; firstName: string; lastName: string; email: string },
  slug: string
): Promise<{ sent: number; errored: number; skipped: number }> {
  const OBSERVATION_SRC = `${slug}_bot`;
  await writeObservation({
    source: OBSERVATION_SRC,
    category: "run_start",
    severity: "info",
    message: `${BOT_NAME} (${agent.firstName}) started at ${new Date().toISOString()}`,
  });

  const alreadySentToday = await getSmsSentTodayIds();
  let sent = 0;
  let errored = 0;
  let skipped = 0;

  const allLeads = await fetchLeadsForAgent(agent.fubId);
  const candidates = allLeads
    .filter(p => !alreadySentToday.has(p.id) && isEligible(p))
    .slice(0, MAX_LEADS_PER_RUN);
  skipped += allLeads.length - candidates.length;

  for (const person of candidates) {
    const personId = person.id;
    try {
      // LLM-powered skip check — understands any context, not just keywords
      const skipCheck = await shouldSkipLead(person);
      if (skipCheck.skip) {
        skipped++;
        await postFubNote(
          personId,
          `[${BOT_NAME}] Skipped automated follow-up. Reason: ${skipCheck.reason ?? "Notes indicate no follow-up needed"}`
        ).catch(() => {});
        continue;
      }

      // Minimum contact gap check — don't email the same lead within 3 days
      if (await wasContactedRecently(personId)) {
        skipped++;
        continue;
      }

      const staleDays = daysStale(person);
      const stage = person.stage ?? "Lead";
      const leadFirstName = person.firstName ?? null;
      const leadEmail = extractEmail(person);
      const { body: message, subject: emailSubject } = await generateFollowUpMessage({
        agentFirstName: agent.firstName,
        agentLastName: agent.lastName,
        leadFirstName,
        daysStale: staleDays,
        stage,
        person,
      });
      if (leadEmail) {
        await sendLeadFollowUpEmail({
          agentEmail: agent.email,
          agentFirstName: agent.firstName,
          agentLastName: agent.lastName,
          leadEmail,
          leadFirstName,
          messageBody: message,
          subject: emailSubject,
        });
      }
      await postFubNote(
        personId,
        `[${BOT_NAME}] Follow-up email sent by ${agent.firstName} ${agent.lastName} on ${new Date().toLocaleDateString()}.\nSubject: ${emailSubject}\n\n${message}`
      );
      await logContactedLead({
        botSlug: slug,
        botName: `${BOT_NAME} (${agent.firstName})`,
        person,
        daysStaleVal: staleDays,
        messageBody: message,
      });
      await recordSmsSentToday(personId, BOT_NAME);
      alreadySentToday.add(personId);
      sent++;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errored++;
      await writeObservation({
        source: OBSERVATION_SRC,
        category: "lead_error",
        severity: "warning",
        message: `${BOT_NAME} (${agent.firstName}) failed on lead ${personId}: ${errMsg}`,
      }).catch(() => {});
    }
  }

  skipped += allLeads.filter(p => alreadySentToday.has(p.id) || !isEligible(p)).length;

  const status = errored > 0 ? "warning" : "ok";
  await writeObservation({
    source: OBSERVATION_SRC,
    category: "run_complete",
    severity: errored > 0 ? "warning" : "info",
    message: `${BOT_NAME} (${agent.firstName}) complete: ${sent} sent, ${errored} errors, ${skipped} skipped`,
  });
  await logBotRun({
    botName: `${BOT_NAME} (${agent.firstName})`,
    botSlug: slug,
    sent,
    errored,
    skipped,
    status,
  });
  return { sent, errored, skipped };
}

/** Run Peter's leads only — separate heartbeat to avoid 2-min timeout */
export async function runSpBotPeter(): Promise<{ sent: number; errored: number; skipped: number }> {
  return runSpBotForAgent(PETER_AGENT, "sp500_peter");
}

/** Run Steven's leads only — separate heartbeat to avoid 2-min timeout */
export async function runSpBotSteven(): Promise<{ sent: number; errored: number; skipped: number }> {
  return runSpBotForAgent(STEVEN_AGENT, "sp500_steven");
}

/** Legacy combined run — kept for reference but no longer used by heartbeat */
export async function runSpBot(): Promise<{
  sent: number;
  errored: number;
  skipped: number;
}> {
  await writeObservation({
    source: OBSERVATION_SOURCE,
    category: "run_start",
    severity: "info",
    message: `${BOT_NAME} started at ${new Date().toISOString()}`,
  });

  const alreadySentToday = await getSmsSentTodayIds();
  let sent = 0;
  let errored = 0;
  let skipped = 0;

  for (const agent of AGENTS) {
    const allLeads = await fetchLeadsForAgent(agent.fubId);

    const eligible = allLeads
      .filter(p => !alreadySentToday.has(p.id) && isEligible(p))
      .slice(0, MAX_LEADS_PER_RUN);

    for (const person of eligible) {
      const personId = person.id;
      try {
        const staleDays = daysStale(person);
        const stage = person.stage ?? "Lead";
        const leadFirstName = person.firstName ?? null;
        const leadEmail = extractEmail(person);

        // Generate highly intelligent, context-aware follow-up message
        const { body: message, subject: emailSubject } = await generateFollowUpMessage({
          agentFirstName: agent.firstName,
          agentLastName: agent.lastName,
          leadFirstName,
          daysStale: staleDays,
          stage,
          person,
        });

        // Send email to lead from agent's email address
        if (leadEmail) {
          await sendLeadFollowUpEmail({
            agentEmail: agent.email,
            agentFirstName: agent.firstName,
            agentLastName: agent.lastName,
            leadEmail,
            leadFirstName,
            messageBody: message,
            subject: emailSubject,
          });
        }

        // Log FUB note
        await postFubNote(
          personId,
          `[${BOT_NAME}] Follow-up email sent by ${agent.firstName} ${agent.lastName} on ${new Date().toLocaleDateString()}.\nSubject: ${emailSubject}\n\n${message}`
        );

        // Log to contacted_leads for dashboard lead list view
        await logContactedLead({
          botSlug: BOT_SLUG,
          botName: BOT_NAME,
          person,
          daysStaleVal: staleDays,
          messageBody: message,
        });

        // Mark as sent today (dedup)
        await recordSmsSentToday(personId, BOT_NAME);
        alreadySentToday.add(personId);
        sent++;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errored++;
        await writeObservation({
          source: OBSERVATION_SOURCE,
          category: "lead_error",
          severity: "warning",
          message: `${BOT_NAME} failed on lead ${personId} (agent ${agent.firstName}): ${errMsg}`,
        }).catch(() => {});
      }
    }

    // Count leads skipped for this agent
    skipped += allLeads.filter(
      p => alreadySentToday.has(p.id) || !isEligible(p)
    ).length;
  }

  const status = errored > 0 ? "warning" : "ok";

  await writeObservation({
    source: OBSERVATION_SOURCE,
    category: "run_complete",
    severity: errored > 0 ? "warning" : "info",
    message: `${BOT_NAME} complete: ${sent} sent, ${errored} errors, ${skipped} skipped`,
  });

  await logBotRun({
    botName: BOT_NAME,
    botSlug: BOT_SLUG,
    sent,
    errored,
    skipped,
    status,
  });

  return { sent, errored, skipped };
}

export async function sendSpBotClockinEmail(): Promise<void> {
  let leadsQueued = 0;
  let powerQueueCount = 0;
  try {
    const alreadySent = await getSmsSentTodayIds();
    for (const agent of AGENTS) {
      const leads = await fetchLeadsForAgent(agent.fubId);
      leadsQueued += leads.filter(p => !alreadySent.has(p.id) && isEligible(p)).length;
    }
  } catch {
    leadsQueued = 0;
  }
  // Combined bot: sum Peter + Steven Power Queue counts (FUB IDs: Peter=2, Steven=1)
  const [peterPQ, stevenPQ] = await Promise.all([
    fetchPowerQueueCount("Peter"),
    fetchPowerQueueCount("Steven"),
  ]);
  powerQueueCount = peterPQ + stevenPQ;

  await sendClockinEmail({
    botName: BOT_NAME,
    agentFirstName: "Steven & Peter",
    agentLastName: "",
    agentEmail: STEVEN_EMAIL,
    leadsQueued,
    powerQueueCount,
    accentColor: "#1d4ed8",
    headerGradient: "linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 60%,#3b82f6 100%)",
  });
}

export async function sendSpBotClockoffEmail(
  sent = 0,
  errored = 0,
  skipped = 0
): Promise<void> {
  await sendClockoffEmail({
    botName: BOT_NAME,
    agentFirstName: "Steven & Peter",
    agentLastName: "",
    agentEmail: STEVEN_EMAIL,
    sent,
    errored,
    skipped,
    accentColor: "#1d4ed8",
    headerGradient: "linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 60%,#3b82f6 100%)",
  });
}
