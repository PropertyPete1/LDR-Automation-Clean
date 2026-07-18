/**
 * botEngineIntro.ts — One-time introduction email for engine-driven agents.
 *
 * Unlike the hardcoded BOT_INTRO_COPY in botHelpers.ts (which only supports
 * the original 6 bots), this generates intro copy dynamically using the LLM
 * for any new engine agent.
 *
 * The intro email is sent ONCE per agent (tracked by agent_bots.introSentAt).
 * It uses the same gorgeous HTML template as the original sendBotIntroEmail().
 */

import { getDb } from "./db";
import { agentBots } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type { AgentBot } from "../drizzle/schema";
import { sendEmail, PETER_EMAIL, STEVEN_EMAIL } from "./botHelpers";
import { invokeLLM } from "./_core/llm";

const OLD_DASHBOARD_BASE = "https://fub-nurture-phfprjui.manus.space";
const NEW_DASHBOARD_BASE = "https://lifestyledash-wpnl8v84.manus.space";

/**
 * Generate intro email copy via LLM for a new engine agent.
 */
async function generateIntroCopy(agent: AgentBot): Promise<{
  openingLine: string;
  originStory: string;
  whatIDo: string;
  powerQueueNote: string;
  hype: string;
}> {
  const currentYear = new Date().getFullYear(); // 2026
  const prompt = `You are writing a fun, energetic introduction email for a new AI automation bot at Lifestyle Design Realty.

The bot is called "${agent.botName}" and is assigned to agent ${agent.agentFirstName} ${agent.agentLastName}.
The current year is ${currentYear}.

Write the following sections:

1. OPENING_LINE: A warm, exciting headline greeting the agent about their new bot (1 sentence).

2. ORIGIN_STORY: A short, cute, made-up tale (2-3 paragraphs) about how this bot was "born." Make it personal and charming — maybe Peter was up late at the office one night, fueled by coffee and ambition, staring at Follow Up Boss data, and thought "${agent.agentFirstName} deserves a tireless AI partner that never forgets a lead." So he built one from scratch, trained it on the team's best follow-up patterns, and named it ${agent.botName}. Give it personality — it's eager, loyal, and a little proud of itself. End with the bot introducing itself directly to ${agent.agentFirstName}.

3. WHAT_I_DO: A single paragraph explaining the daily routine — scans leads 3-19 days stale, sends personalized AI-crafted emails drawing from the most recent FUB notes, logs detailed notes in Follow Up Boss for full accountability, and sends a complete summary report at 6:00 PM CT.

4. POWER_QUEUE_NOTE: A brief note about the Power Queue — the agent also has a mobile-first texting queue for leads 1-20 days stale that shows one lead at a time with full context. It complements the bot's email work perfectly.

5. HYPE: An exciting statement about how rare and powerful this automation is — most real estate teams don't have anything close to this level of AI automation working for them 24/7. This is cutting-edge technology that gives a massive competitive advantage.

Return ONLY valid JSON with keys: openingLine, originStory, whatIDo, powerQueueNote, hype
All values should be strings. The originStory can have \\n\\n for paragraph breaks.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: "You are a copywriter for a real estate tech company. Return only valid JSON." },
      { role: "user", content: prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "intro_copy",
        strict: true,
        schema: {
          type: "object",
          properties: {
            openingLine: { type: "string", description: "Exciting headline greeting" },
            originStory: { type: "string", description: "Cute origin story about how the bot was born" },
            whatIDo: { type: "string", description: "Daily routine explanation" },
            powerQueueNote: { type: "string", description: "Power Queue complement note" },
            hype: { type: "string", description: "Exciting rarity statement" },
          },
          required: ["openingLine", "originStory", "whatIDo", "powerQueueNote", "hype"],
          additionalProperties: false,
        },
      },
    },
  });

  const rawContent = response.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : "{}";
  const parsed = JSON.parse(content);
  return {
    openingLine: parsed.openingLine ?? `Meet ${agent.botName}!`,
    originStory: parsed.originStory ?? `It was a late Tuesday night at the office. Peter was three cups of coffee deep, staring at Follow Up Boss data, watching leads slip through the cracks. "${agent.agentFirstName} deserves better," he muttered. "A tireless partner that never forgets a lead, never takes a day off, and always knows exactly what to say."

So he built one. Line by line, trained on the team's best follow-up patterns, infused with the warmth and professionalism that defines Lifestyle Design Realty. And when it was done, he smiled and said: "Your name is ${agent.botName}."

Hi ${agent.agentFirstName}! I'm ${agent.botName}, and I'm thrilled to finally introduce myself. I was built specifically for you — to handle your follow-ups with the same care you would, so you can focus on closing deals and building relationships.`,
    whatIDo: parsed.whatIDo ?? `Every day I scan your leads that are 3-19 days stale, send personalized AI-crafted emails that draw from your most recent FUB notes, log detailed notes in Follow Up Boss for full accountability, and send you a complete summary report at 6:00 PM CT.`,
    powerQueueNote: parsed.powerQueueNote ?? `You also have a Power Queue — a mobile-first texting queue for leads 1-20 days stale. It shows you one lead at a time with full context so you can send a quick personalized text. It complements my email work perfectly.`,
    hype: parsed.hype ?? `You're part of something rare — most real estate teams don't have anything close to this level of AI automation working for them 24/7. This is cutting-edge technology that gives you a massive competitive advantage.`,
  };
}

/**
 * Send the one-time introduction email for an engine agent.
 * Returns true if sent, false if already sent or agent not found.
 */
export async function sendEngineIntroEmail(botSlug: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const [agent] = await db.select().from(agentBots).where(eq(agentBots.botSlug, botSlug)).limit(1);
  if (!agent) return false;
  if (agent.introSentAt) return false; // Already sent

  // Generate copy via LLM
  const { openingLine, originStory, whatIDo, powerQueueNote, hype } = await generateIntroCopy(agent);

  const accentColor = agent.accentColor;
  const headerGradient = agent.headerGradient;
  const botName = agent.botName;
  const agentEmail = agent.agentEmail;

  // Build links
  const powerQueueUrl = `${OLD_DASHBOARD_BASE}/sms-queue?agent=${encodeURIComponent(agent.powerQueueName ?? agent.agentFirstName)}`;
  const newDashUrl = `${NEW_DASHBOARD_BASE}/agent/${agent.botSlug}`;

  const subject = `🚀 ${botName} is LIVE — Your New AI Automation Assistant`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

        <!-- HERO HEADER -->
        <tr>
          <td style="background:${headerGradient};padding:48px 40px 36px;text-align:center;">
            <div style="display:inline-block;background:rgba(255,255,255,0.12);border-radius:50%;width:72px;height:72px;line-height:72px;font-size:36px;margin-bottom:16px;">🤖</div>
            <p style="margin:0 0 8px 0;font-size:12px;color:rgba(255,255,255,0.65);letter-spacing:3px;text-transform:uppercase;">Lifestyle Design Realty</p>
            <h1 style="margin:0 0 6px 0;font-size:30px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">${botName}</h1>
            <p style="margin:0 0 20px 0;font-size:15px;color:rgba(255,255,255,0.85);">Your Dedicated AI Automation Assistant</p>
            <div style="display:inline-block;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.3);border-radius:24px;padding:8px 20px;">
              <span style="font-size:13px;color:#fff;font-weight:600;">🚀 &nbsp;Now Online &mdash; ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>
            </div>
          </td>
        </tr>

        <!-- OPENING LINE -->
        <tr>
          <td style="padding:40px 44px 0;">
            <h2 style="margin:0 0 20px 0;font-size:24px;font-weight:700;color:#111827;line-height:1.3;">${openingLine}</h2>
            <div style="font-size:15px;color:#374151;line-height:1.85;">
              ${originStory.split("\n\n").map((p: string) => `<p style="margin:0 0 16px 0;">${p.trim()}</p>`).join("")}
            </div>
          </td>
        </tr>

        <!-- DIVIDER -->
        <tr>
          <td style="padding:28px 44px 0;">
            <div style="height:2px;background:linear-gradient(90deg,${accentColor}33,${accentColor},${accentColor}33);border-radius:2px;"></div>
          </td>
        </tr>

        <!-- WHAT I DO EVERY DAY -->
        <tr>
          <td style="padding:28px 44px 0;">
            <h3 style="margin:0 0 16px 0;font-size:18px;font-weight:700;color:#111827;">📅 Here's What I Do Every Day</h3>
            <div style="font-size:15px;color:#374151;line-height:1.85;">
              <p style="margin:0 0 16px 0;">${whatIDo}</p>
            </div>
          </td>
        </tr>

        <!-- POWER QUEUE CALLOUT -->
        <tr>
          <td style="padding:20px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 10px 0;font-size:12px;color:#92400e;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">⚡ Power Queue</p>
                <p style="margin:0;font-size:14px;color:#374151;line-height:1.7;">${powerQueueNote}</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- HYPE SECTION -->
        <tr>
          <td style="padding:28px 44px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-left:4px solid ${accentColor};border-radius:0 10px 10px 0;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 10px 0;font-size:12px;color:${accentColor};text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">🏆 You're Part of Something Rare</p>
                <p style="margin:0;font-size:15px;color:#374151;line-height:1.85;">${hype}</p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- CTA BUTTONS -->
        <tr>
          <td style="padding:32px 44px 0;text-align:center;">
            <p style="margin:0 0 16px 0;font-size:13px;color:#9ca3af;text-transform:uppercase;letter-spacing:1.5px;">Get Started</p>
            <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td style="padding-right:12px;">
                  <a href="${powerQueueUrl}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.3px;">⚡ Launch Power Queue</a>
                </td>
                <td>
                  <a href="${newDashUrl}" style="display:inline-block;background:${accentColor};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.3px;">📊 View Dashboard</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- SIGN-OFF -->
        <tr>
          <td style="padding:36px 44px 28px;">
            <p style="margin:0 0 6px 0;font-size:15px;color:#374151;line-height:1.8;">Excited to get to work for you,</p>
            <p style="margin:0 0 4px 0;font-size:20px;font-weight:800;color:#111827;">${botName}</p>
            <p style="margin:0;font-size:13px;color:#9ca3af;">Assigned to ${agent.agentFirstName} ${agent.agentLastName} &mdash; Lifestyle Design Realty</p>
          </td>
        </tr>

        <!-- AUTOMATION ASK -->
        <tr>
          <td style="padding:0 44px 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
              <tr><td style="padding:18px 22px;">
                <p style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:#166534;">💬 Is there anything I can automate to make your life easier?</p>
                <p style="margin:0;font-size:13px;color:#374151;line-height:1.6;">Reply to this email with any ideas or requests — <strong>Peter will review and implement them for you!</strong></p>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:18px 44px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">Powered by <strong style="color:#6b7280;">Lifestyle Technologies</strong> &nbsp;&bull;&nbsp; Lifestyle Design Realty &nbsp;&bull;&nbsp; ${new Date().getFullYear()}</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const recipients = [PETER_EMAIL, STEVEN_EMAIL, agentEmail].filter((e, i, arr) => arr.indexOf(e) === i);

  await sendEmail({
    to: recipients,
    subject,
    html,
    replyTo: PETER_EMAIL,
  });

  // Mark intro as sent
  await db.update(agentBots).set({ introSentAt: new Date() }).where(eq(agentBots.id, agent.id));

  return true;
}

/**
 * Send intro emails for all engine agents that haven't received one yet.
 * Called manually or from a one-time endpoint.
 */
export async function sendAllPendingIntroEmails(): Promise<{ sent: string[]; skipped: string[] }> {
  const db = await getDb();
  if (!db) return { sent: [], skipped: [] };

  const agents = await db.select().from(agentBots).where(eq(agentBots.engineActive, true));
  const sent: string[] = [];
  const skipped: string[] = [];

  for (const agent of agents) {
    if (agent.introSentAt) {
      skipped.push(agent.botSlug);
      continue;
    }
    try {
      const didSend = await sendEngineIntroEmail(agent.botSlug);
      if (didSend) sent.push(agent.botSlug);
      else skipped.push(agent.botSlug);
    } catch {
      skipped.push(agent.botSlug);
    }
  }

  return { sent, skipped };
}
