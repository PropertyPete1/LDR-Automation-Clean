/**
 * clockinAdminUrl.test.ts — Job 1e: the admin Power Queue token must reach
 * ONLY Peter's clock-in email, never any other agent's, under any env state.
 *
 * The clock-in email embeds the Power Queue link. Peter (or the combined S&P
 * bot he is on) gets ?admin=TOKEN&agent=all; every other agent gets their
 * scoped ?agent=Name link with no token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSendMail = vi.fn().mockResolvedValue({ messageId: "test-id" });
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
}));
// agent_bots lookup + power-queue count must not hit a real DB / FUB.
vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));

const TOKEN = "super-secret-admin-token-123";

function lastHtml(): string {
  const call = mockSendMail.mock.calls.at(-1);
  return call ? String(call[0].html ?? "") : "";
}

describe("Job 1e — admin token only ever reaches Peter's clock-in", () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "test@test.com";
    process.env.SMTP_PASSWORD = "pw";
    process.env.EMAIL_FROM = "peter@lifestyledesignrealty.com";
    process.env.FUB_API_KEY = "test-key";
    process.env.POWER_QUEUE_ADMIN_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.POWER_QUEUE_ADMIN_TOKEN;
  });

  it("Tiffany's clock-in contains her scoped ?agent link and NO admin token", async () => {
    const { sendClockinEmail } = await import("./botHelpers");
    await sendClockinEmail({
      botName: "Tiffany's Lifestyle Bot",
      agentFirstName: "Tiffany",
      agentLastName: "Proske",
      agentEmail: "tiffany@lifestyledesignrealty.com",
      leadsQueued: 3,
      powerQueueCount: 5,
    });
    const html = lastHtml();
    expect(html).toContain("/sms-queue?agent=Tiffany");
    expect(html).not.toContain("admin=");
    expect(html).not.toContain(TOKEN);
  });

  it("Peter's clock-in DOES carry the admin token (admin=all)", async () => {
    const { sendClockinEmail } = await import("./botHelpers");
    await sendClockinEmail({
      botName: "Peter's Lifestyle Bot",
      agentFirstName: "Peter",
      agentLastName: "Allen",
      agentEmail: "peter@lifestyledesignrealty.com",
      leadsQueued: 2,
      powerQueueCount: 4,
    });
    const html = lastHtml();
    expect(html).toContain(`admin=${encodeURIComponent(TOKEN)}`);
    expect(html).toContain("agent=all");
  });

  it("with the token UNSET, even Peter's clock-in carries no token (graceful fallback)", async () => {
    delete process.env.POWER_QUEUE_ADMIN_TOKEN;
    const { sendClockinEmail } = await import("./botHelpers");
    await sendClockinEmail({
      botName: "Peter's Lifestyle Bot",
      agentFirstName: "Peter",
      agentLastName: "Allen",
      agentEmail: "peter@lifestyledesignrealty.com",
      leadsQueued: 1,
      powerQueueCount: 0,
    });
    const html = lastHtml();
    expect(html).not.toContain("admin=");
    expect(html).toContain("/sms-queue"); // still produces a working link
  });

  it("no other agent gets the token even when it is set (sweep)", async () => {
    const { sendClockinEmail } = await import("./botHelpers");
    for (const name of ["Stefanie", "Abby", "Irma", "Laila", "Jason", "Steven"]) {
      mockSendMail.mockClear();
      await sendClockinEmail({
        botName: `${name}'s Lifestyle Bot`,
        agentFirstName: name,
        agentLastName: "X",
        agentEmail: `${name.toLowerCase()}@lifestyledesignrealty.com`,
        leadsQueued: 1,
        powerQueueCount: 1,
      });
      const html = lastHtml();
      expect(html, `${name} must not receive the admin token`).not.toContain(TOKEN);
      expect(html, `${name} must not receive admin=`).not.toContain("admin=");
    }
  });
});
