import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const fixture = vi.hoisted(() => ({
  contacted: [] as unknown[],
  observation: vi.fn().mockResolvedValue(undefined),
  command: vi.fn().mockReturnValue("saved to: /tmp/portal-fix/synthetic-inbound-fixture"),
}));
vi.mock("child_process", () => ({ execSync: fixture.command }));
vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({ select: () => ({ from: () => ({ where: async () => fixture.contacted }) }) })),
}));
vi.mock("./botHelpers", () => ({ writeObservation: fixture.observation }));
import { runLeadReplyChecker } from "./leadReplyChecker";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.command.mockReturnValue("saved to: /tmp/portal-fix/synthetic-inbound-fixture");
  fixture.observation.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const mailbox = (snippet: string) => `
**Email Details**
Subject: Re: Synthetic follow-up
From: Synthetic Lead <fixture@example.invalid>
To: peter@lifestyledesignrealty.com
**Snippet**
${snippet}
Message ID: synthetic-message
Thread ID: synthetic-thread
`;

describe("portal email policy does not suppress existing inbound reply observations", () => {
  it.each([
    { provenance: { source: "Zillow" }, snippet: "Synthetic human reply" },
    { provenance: { source: "Realtor.com" }, snippet: "Synthetic stop contacting me" },
    { provenance: { tags: ["Zillow - Synthetic"] }, snippet: "Synthetic Zillow reply" },
  ])("historically contacted portal lead reply remains processed %#", async ({ provenance, snippet }) => {
    fixture.contacted = [{ leadEmail: "fixture@example.invalid", ...provenance }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(mailbox(snippet));
    const result = await runLeadReplyChecker();
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ repliesFound: 1, observationsWritten: 1 });
    expect(fixture.observation).toHaveBeenCalledWith(expect.objectContaining({
      source: "peter_bot", message: expect.stringContaining("BOT-CONTACTED LEAD REPLIED"),
    }));
  });
});
