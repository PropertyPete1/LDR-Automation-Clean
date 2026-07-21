/**
 * reversePondDeals.ts — REVERSAL SCRIPT
 * Finds every lead in the pond who has any deal attached.
 * Strategy: fetch all 226 deals → collect unique personIds → check if in pond → reverse.
 *
 * Run with: npx tsx server/reversePondDeals.ts
 * DRY RUN (default): lists leads without making changes
 * LIVE RUN: DRY_RUN=false npx tsx server/reversePondDeals.ts
 */

import { ENV } from "./_core/env";

const FUB_API_KEY = ENV.fubApiKey;
const FUB_BASE = "https://api.followupboss.com/v1";
const DRY_RUN = process.env.DRY_RUN !== "false";
const POND_ID = 2;

// Agent FUB IDs for reference
const AGENTS: Record<number, string> = {
  1: "Steven Van Orden",
  2: "Peter Allen",
  20: "Tiffany",
  28: "Abby Martinez",
  31: "Rue (Stefanie)",
  33: "Irma",
  35: "Laila",
};

function fubAuth(): string {
  return "Basic " + Buffer.from(`${FUB_API_KEY}:`).toString("base64");
}

async function fubGet(path: string): Promise<any> {
  let delay = 2000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const url = path.startsWith("http") ? path : `${FUB_BASE}${path}`;
    const res = await fetch(url, {
      headers: { Authorization: fubAuth(), "Content-Type": "application/json" },
    });
    if (res.status === 429) {
      console.log(`  [rate-limited] waiting ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`FUB ${res.status} on ${path}: ${body}`);
    }
    return res.json();
  }
  throw new Error(`FUB rate-limit exceeded on ${path}`);
}

async function fubPut(path: string, body: object): Promise<any> {
  let delay = 2000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${FUB_BASE}${path}`, {
      method: "PUT",
      headers: { Authorization: fubAuth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`FUB PUT ${res.status} on ${path}: ${txt}`);
    }
    return res.json();
  }
  throw new Error(`FUB rate-limit exceeded on PUT ${path}`);
}

async function fubPost(path: string, body: object): Promise<any> {
  let delay = 2000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${FUB_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: fubAuth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`FUB POST ${res.status} on ${path}: ${txt}`);
    }
    return res.json();
  }
  throw new Error(`FUB rate-limit exceeded on POST ${path}`);
}

interface FubDeal {
  id: number;
  personId?: number;
  person?: { id?: number; firstName?: string; lastName?: string };
  pipelineId: number;
  pipelineName: string;
  stageId: number;
  stageName: string;
  status: string;
}

interface FubPerson {
  id: number;
  firstName?: string;
  lastName?: string;
  assignedUserId?: number;
  assignedPondId?: number;
  tags?: Array<{ name?: string } | string>;
}

interface ReversalCandidate {
  personId: number;
  name: string;
  deals: FubDeal[];
  currentlyInPond: boolean;
  assignedUserId?: number;
}

async function getAllDeals(): Promise<FubDeal[]> {
  const allDeals: FubDeal[] = [];
  let nextUrl: string | null = `/deals?limit=100`;
  while (nextUrl) {
    const resp = await fubGet(nextUrl);
    const deals = resp.deals ?? [];
    allDeals.push(...deals);
    const nextLink = resp._metadata?.nextLink ?? null;
    if (nextLink) {
      nextUrl = nextLink.startsWith("http") ? nextLink : null;
    } else {
      nextUrl = null;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return allDeals;
}

async function getPerson(personId: number): Promise<FubPerson | null> {
  try {
    const resp = await fubGet(`/people/${personId}`);
    return resp as FubPerson;
  } catch {
    return null;
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DEAL-BASED POND REVERSAL SCRIPT");
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "⚠️  LIVE — making changes"}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Step 1: Get ALL deals (only ~226 total)
  console.log("Step 1: Fetching all deals from FUB...");
  const allDeals = await getAllDeals();
  console.log(`  Found ${allDeals.length} total deals.\n`);

  // Step 2: Group deals by personId (deals have a 'people' array, not 'personId')
  const dealsByPerson = new Map<number, FubDeal[]>();
  for (const deal of allDeals) {
    const people = (deal as any).people as Array<{ id?: number; name?: string }> | undefined;
    if (!people || people.length === 0) continue;
    for (const p of people) {
      if (!p.id) continue;
      if (!dealsByPerson.has(p.id)) dealsByPerson.set(p.id, []);
      dealsByPerson.get(p.id)!.push(deal);
    }
  }
  console.log(`  ${dealsByPerson.size} unique people have deals.\n`);

  // Step 3: Check which of those people are currently in the pond
  console.log("Step 3: Checking which deal-holders are in the pond...");
  const candidates: ReversalCandidate[] = [];
  let checked = 0;

  for (const [personId, deals] of Array.from(dealsByPerson.entries())) {
    checked++;
    if (checked % 20 === 0) console.log(`  Checked ${checked}/${dealsByPerson.size}...`);

    const person = await getPerson(personId);
    if (!person) continue;

    // Check if this person is in the pond
    if (person.assignedPondId === POND_ID) {
      candidates.push({
        personId,
        name: `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() || `ID:${personId}`,
        deals,
        currentlyInPond: true,
        assignedUserId: person.assignedUserId,
      });
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n  Found ${candidates.length} leads WITH DEALS currently in the pond.\n`);

  if (candidates.length === 0) {
    console.log("✅ No leads with deals found in the pond. All clear!");
    return;
  }

  // Step 4: Display the list
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  LEADS WITH DEALS IN THE POND (should be reversed):");
  console.log("═══════════════════════════════════════════════════════════════");
  for (const c of candidates) {
    const dealInfo = c.deals.map(d => `${d.pipelineName}/${d.stageName} (${d.status})`).join(", ");
    // Default reassignment to Peter (ID:2) since we can't reliably determine original agent
    console.log(`  • ${c.name} (ID:${c.personId})`);
    console.log(`    Deals: ${dealInfo}`);
    console.log(`    → Will reassign to Peter Allen (ID:2)`);
    console.log("");
  }

  if (DRY_RUN) {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  DRY RUN COMPLETE — no changes made.");
    console.log("  To execute: DRY_RUN=false npx tsx server/reversePondDeals.ts");
    console.log("═══════════════════════════════════════════════════════════════");
    return;
  }

  // Step 5: Execute reversals
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  EXECUTING REVERSALS...");
  console.log("═══════════════════════════════════════════════════════════════");

  let reversed = 0;
  let errors = 0;

  for (const c of candidates) {
    try {
      // Reassign to Peter (removes from pond)
      await fubPut(`/people/${c.personId}`, {
        assignedUserId: 2,
        assignedPondId: null,
      });

      // Add reversal note
      await fubPost(`/notes`, {
        personId: c.personId,
        body: `[Deal Protection] Reversed — client with deal (${c.deals[0].pipelineName}/${c.deals[0].stageName}), moved to pond in error. Reassigned back to Peter Allen.`,
      });

      reversed++;
      console.log(`  ✅ ${c.name} (ID:${c.personId}) → Peter Allen`);
      await new Promise(r => setTimeout(r, 500)); // Rate limit
    } catch (err: any) {
      errors++;
      console.error(`  ❌ ${c.name} (ID:${c.personId}): ${err.message}`);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  REVERSAL COMPLETE: ${reversed} reversed, ${errors} errors`);
  console.log(`═══════════════════════════════════════════════════════════════`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
