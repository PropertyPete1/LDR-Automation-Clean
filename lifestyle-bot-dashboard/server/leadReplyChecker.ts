/**
 * leadReplyChecker.ts
 *
 * Runs at 3:50am CT via heartbeat. Uses the Gmail MCP (via manus-mcp-cli) to
 * search for replies from leads in the past 24 hours. Any reply found is written
 * as a "lead_reply" observation so the 4am healer report includes it.
 *
 * Gmail search strategy:
 *   - Search for emails IN the agent inboxes that are REPLIES (have "Re:" subject)
 *     and are NOT from the agents themselves (i.e., from leads)
 *   - Cross-reference with bot_contacted_leads to confirm the lead was contacted by a bot
 *   - Write a lead_reply observation for each confirmed reply
 */

import { execSync } from "child_process";
import { writeObservation, type ObservationCategory } from "./botHelpers";
import { getDb } from "./db";
import { contactedLeads } from "../drizzle/schema";
import { gte } from "drizzle-orm";

// Agent email addresses to monitor for replies
const AGENT_EMAILS = [
  "peter@lifestyledesignrealty.com",
  "steven@lifestyledesignrealty.com",
  "tiffany@lifestyledesignrealty.com",
  "stefanie@lifestyledesignrealty.com",
  "abby@lifestyledesignrealty.com",
  "irma@lifestyledesignrealty.com",
  "laila@lifestyledesignrealty.com",
];

// Internal/system senders to exclude (not real lead replies)
const INTERNAL_DOMAINS = [
  "lifestyledesignrealty.com",
  "manus.im",
  "manus.space",
  "mailer-daemon",
  "noreply",
  "no-reply",
  "donotreply",
];

function isInternalSender(from: string): boolean {
  const lower = from.toLowerCase();
  return INTERNAL_DOMAINS.some(d => lower.includes(d));
}

interface GmailMessage {
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  snippet?: string;
  messageId?: string;
  threadId?: string;
}

function searchGmail(query: string, maxResults = 50): GmailMessage[] {
  try {
    const result = execSync(
      `manus-mcp-cli tool call gmail_search_messages --server gmail --input '${JSON.stringify({ q: query, max_results: maxResults })}'`,
      { encoding: "utf8", timeout: 60000 }
    );
    // Result is saved to a file path — read it
    const filePathMatch = result.match(/saved to:\s*(\S+)/);
    if (!filePathMatch) return [];
    const fileContent = require("fs").readFileSync(filePathMatch[1], "utf8");
    // Parse the markdown-formatted result into structured messages
    const messages: GmailMessage[] = [];
    const blocks = fileContent.split("**Email Details**").slice(1);
    for (const block of blocks) {
      const msg: GmailMessage = {};
      const subjectMatch = block.match(/Subject:\s*(.+)/);
      const fromMatch = block.match(/From:\s*(.+)/);
      const toMatch = block.match(/To:\s*(.+)/);
      const dateMatch = block.match(/Date:\s*(.+)/);
      const snippetMatch = block.match(/[\s\S]*?\*\*Snippet\*\*\s*\n([^\n]+)/);
      const msgIdMatch = block.match(/Message ID:\s*(\S+)/);
      const threadIdMatch = block.match(/Thread ID:\s*(\S+)/);
      if (subjectMatch) msg.subject = subjectMatch[1].trim();
      if (fromMatch) msg.from = fromMatch[1].trim();
      if (toMatch) msg.to = toMatch[1].trim();
      if (dateMatch) msg.date = dateMatch[1].trim();
      if (snippetMatch) msg.snippet = snippetMatch[1].trim().slice(0, 200);
      if (msgIdMatch) msg.messageId = msgIdMatch[1].trim();
      if (threadIdMatch) msg.threadId = threadIdMatch[1].trim();
      if (msg.from && msg.subject) messages.push(msg);
    }
    return messages;
  } catch (err) {
    console.error("[leadReplyChecker] Gmail search failed:", err);
    return [];
  }
}

export async function runLeadReplyChecker(): Promise<{
  repliesFound: number;
  observationsWritten: number;
}> {
  console.log("[leadReplyChecker] Starting lead reply scan...");

  // Build yesterday's date string for Gmail query (after:YYYY/MM/DD)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateStr = `${yesterday.getFullYear()}/${String(yesterday.getMonth() + 1).padStart(2, "0")}/${String(yesterday.getDate()).padStart(2, "0")}`;

  // Search for replies in any agent inbox — "Re:" subjects from external senders
  const query = `(${AGENT_EMAILS.map(e => `to:${e}`).join(" OR ")}) subject:Re: after:${dateStr}`;
  const messages = searchGmail(query, 100);

  // Get leads contacted by bots in the past 48 hours to cross-reference
  let contactedLeadEmails = new Set<string>();
  try {
    const db = await getDb();
    if (db) {
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const contacted = await db
        .select()
        .from(contactedLeads)
        .where(gte(contactedLeads.sentAt, since));
      for (const row of contacted) {
        if (row.leadEmail) contactedLeadEmails.add(row.leadEmail.toLowerCase());
      }
    }
  } catch (err) {
    console.error("[leadReplyChecker] DB lookup failed:", err);
  }

  let repliesFound = 0;
  let observationsWritten = 0;
  const seenThreads = new Set<string>();

  for (const msg of messages) {
    // Skip internal senders
    if (!msg.from || isInternalSender(msg.from)) continue;
    // Skip duplicate threads
    if (msg.threadId && seenThreads.has(msg.threadId)) continue;
    if (msg.threadId) seenThreads.add(msg.threadId);

    repliesFound++;

    // Extract lead email from the From field
    const emailMatch = msg.from.match(/<([^>]+)>/) ?? msg.from.match(/(\S+@\S+)/);
    const leadEmail = emailMatch ? emailMatch[1].toLowerCase() : msg.from.toLowerCase();

    // Determine which agent received the reply
    const toField = (msg.to ?? "").toLowerCase();
    const agentEmail = AGENT_EMAILS.find(e => toField.includes(e)) ?? "unknown";
    const agentName = agentEmail.split("@")[0];

    // Check if this lead was contacted by a bot (cross-reference)
    const isBotContacted = contactedLeadEmails.has(leadEmail);
    const source = isBotContacted ? `${agentName}_bot` : "lead_reply_checker";

    const observationMsg = isBotContacted
      ? `🎯 BOT-CONTACTED LEAD REPLIED: "${msg.subject}" from ${msg.from} → ${agentEmail}. Snippet: ${msg.snippet ?? "(no preview)"}`
      : `📩 Lead reply (not bot-contacted): "${msg.subject}" from ${msg.from} → ${agentEmail}. Snippet: ${msg.snippet ?? "(no preview)"}`;

    try {
      await writeObservation({
        source,
        category: "run_complete" as ObservationCategory, // closest category; healer filters by message prefix
        severity: isBotContacted ? "info" : "info",
        message: observationMsg,
      });
      observationsWritten++;
      // Log without PII — no lead email addresses in log output (public repo)
      console.log(`[leadReplyChecker] Logged a lead reply for agent inbox routing`);
    } catch (err) {
      console.error("[leadReplyChecker] Failed to write observation:", err);
    }
  }

  console.log(`[leadReplyChecker] Done: ${repliesFound} replies found, ${observationsWritten} observations written`);
  return { repliesFound, observationsWritten };
}
