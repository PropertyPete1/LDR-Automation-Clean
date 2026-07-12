/**
 * stefanieBot.ts — Rue Lifestyle Bot
 * Agent: Stefanie Graham / Rue (FUB ID: 31)
 * Clock-in: 10am CT | Clock-off: 6pm CT | Recipients: Peter + Steven always.
 */

import {
  sendLeadFollowUpEmail,
  extractEmail,
  logContactedLead,
  MAX_LEADS_PER_RUN,
  fetchLeadsForAgent,
  isEligible,
  shouldSkipLead,
  wasContactedRecently,
  daysStale,
  generateFollowUpMessage,
  postFubNote,
  getSmsSentTodayIds,
  recordSmsSentToday,
  sendClockinEmail,
  sendClockoffEmail,
  writeObservation,
    logBotRun,
  fetchPowerQueueCount,
} from "./botHelpers";
const BOT_NAME = "Rue Lifestyle Bot";
const BOT_SLUG = "stefanie";
const OBSERVATION_SOURCE = "stefanie_bot";

const AGENT_FUB_ID = 31;
const AGENT_FIRST = "Rue";
const AGENT_LAST = "";
const AGENT_EMAIL = "Stefanie@lifestyledesignrealty.com"; // email stays the same

export async function runStefanieBot(): Promise<{
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
  const allLeads = await fetchLeadsForAgent(AGENT_FUB_ID);

  const candidates = allLeads
    .filter(p => !alreadySentToday.has(p.id) && isEligible(p))
    .slice(0, MAX_LEADS_PER_RUN);

  let sent = 0;
  let errored = 0;
  let skipped = allLeads.length - candidates.length;

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
      const { body: message, subject: emailSubject } = await generateFollowUpMessage({
        agentFirstName: AGENT_FIRST,
        agentLastName: AGENT_LAST,
        leadFirstName: person.firstName ?? null,
        daysStale: staleDays,
        stage,
        person,
      });

      const leadEmail = extractEmail(person);
      if (leadEmail) {
        await sendLeadFollowUpEmail({
          leadEmail,
          agentFirstName: AGENT_FIRST,
          agentLastName: AGENT_LAST,
          agentEmail: AGENT_EMAIL,
          leadFirstName: person.firstName ?? null,
          messageBody: message,
          subject: emailSubject,
        });
      }

      await postFubNote(
        personId,
        `[${BOT_NAME}] Follow-up sent by ${AGENT_FIRST} ${AGENT_LAST} on ${new Date().toLocaleDateString()}.\nSubject: ${emailSubject}\n\n${message}`
      );

      await recordSmsSentToday(personId, BOT_NAME);
      await logContactedLead({
        botSlug: BOT_SLUG,
        botName: BOT_NAME,
        person: person,
        daysStaleVal: staleDays,
        messageBody: message,
      });
      alreadySentToday.add(personId);
      sent++;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errored++;
      await writeObservation({
        source: OBSERVATION_SOURCE,
        category: "lead_error",
        severity: "warning",
        message: `${BOT_NAME} failed on lead ${personId}: ${errMsg}`,
      }).catch(() => {});
    }
  }

  const status = errored > 0 ? "warning" : "ok";

  await writeObservation({
    source: OBSERVATION_SOURCE,
    category: "run_complete",
    severity: errored > 0 ? "warning" : "info",
    message: `${BOT_NAME} complete: ${sent} sent, ${errored} errors, ${skipped} skipped`,
  });

  await logBotRun({ botName: BOT_NAME, botSlug: BOT_SLUG, sent, errored, skipped, status });
  return { sent, errored, skipped };
}

export async function sendStefanieBotClockinEmail(): Promise<void> {
  let leadsQueued = 0;
  let powerQueueCount = 0;
  try {
    const alreadySent = await getSmsSentTodayIds();
    const leads = await fetchLeadsForAgent(AGENT_FUB_ID);
    leadsQueued = leads.filter(p => !alreadySent.has(p.id) && isEligible(p)).length;
  } catch { leadsQueued = 0; }
  // Rue bot = Stefanie Graham — Power Queue uses "Stefanie"
  powerQueueCount = await fetchPowerQueueCount("Stefanie");

  await sendClockinEmail({
    botName: BOT_NAME,
    agentFirstName: AGENT_FIRST,
    agentLastName: AGENT_LAST,
    agentEmail: AGENT_EMAIL,
    leadsQueued,
    powerQueueCount,
    accentColor: "#db2777",
    headerGradient: "linear-gradient(135deg,#831843 0%,#db2777 60%,#f472b6 100%)",
  });
}

export async function sendStefanieBotClockoffEmail(
  sent = 0, errored = 0, skipped = 0
): Promise<void> {
    await sendClockoffEmail({
    botName: BOT_NAME,
    agentFirstName: AGENT_FIRST,
    agentLastName: AGENT_LAST,
    agentEmail: AGENT_EMAIL,
    sent, errored, skipped,
    accentColor: "#db2777",
    headerGradient: "linear-gradient(135deg,#831843 0%,#db2777 60%,#f472b6 100%)",
  });
}


