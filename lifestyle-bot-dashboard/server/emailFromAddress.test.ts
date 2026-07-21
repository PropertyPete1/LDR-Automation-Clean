/**
 * emailFromAddress.test.ts
 * Asserts that all lead-facing email sends use:
 *   From: "AgentFirstName | Lifestyle Design Realty <team@lifestyledesignrealty.com>"
 *   Reply-To: peter@lifestyledesignrealty.com
 *
 * Internal emails (clock-in, clock-off, monitor alerts, intro) are NOT changed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the nodemailer transport before importing botHelpers
const mockSendMail = vi.fn().mockResolvedValue({ messageId: "test-id" });
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: mockSendMail,
    }),
  },
}));

// Mock the FUB API calls and DB
vi.mock("./db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

describe("Lead-Facing Email From-Address", () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    // Set required env vars
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "test@test.com";
    process.env.SMTP_PASSWORD = "test-password";
    process.env.EMAIL_FROM = "peter@lifestyledesignrealty.com";
    process.env.FUB_API_KEY = "test-key";
  });

  it("TEAM_EMAIL constant is team@lifestyledesignrealty.com", async () => {
    const { TEAM_EMAIL } = await import("./botHelpers");
    expect(TEAM_EMAIL).toBe("team@lifestyledesignrealty.com");
  });

  it("LEAD_REPLY_TO constant is peter@lifestyledesignrealty.com", async () => {
    const { LEAD_REPLY_TO } = await import("./botHelpers");
    expect(LEAD_REPLY_TO).toBe("peter@lifestyledesignrealty.com");
  });

  it("sendLeadFollowUpEmail uses From: 'Agent | LDR <team@...>' and Reply-To: peter@", async () => {
    const { sendLeadFollowUpEmail, TEAM_EMAIL, LEAD_REPLY_TO } = await import("./botHelpers");

    // Call with test data — this will hit the mocked sendMail
    await sendLeadFollowUpEmail({
      agentFirstName: "Tiffany",
      agentLastName: "Proske",
      agentEmail: "tiffany@lifestyledesignrealty.com",
      leadEmail: "lead@example.com",
      leadFirstName: "John",
      subject: "Test Subject",
      messageBody: "Test body content\nSecond line",
    });

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const callArgs = mockSendMail.mock.calls[0][0];

    // From MUST be: "Tiffany | Lifestyle Design Realty <team@lifestyledesignrealty.com>"
    expect(callArgs.from).toBe(`Tiffany | Lifestyle Design Realty <${TEAM_EMAIL}>`);

    // Reply-To MUST be peter@ (not the agent email, not team@)
    expect(callArgs.replyTo).toBe(LEAD_REPLY_TO);
    expect(callArgs.replyTo).toBe("peter@lifestyledesignrealty.com");

    // To MUST be the lead
    expect(callArgs.to).toBe("lead@example.com");

    // BCC MUST still be peter@
    expect(callArgs.bcc).toBe("peter@lifestyledesignrealty.com");
  });

  it("From header uses team@ NOT the agent's individual email", async () => {
    const { sendLeadFollowUpEmail } = await import("./botHelpers");

    await sendLeadFollowUpEmail({
      agentFirstName: "Steven",
      agentLastName: "Allen",
      agentEmail: "steven@lifestyledesignrealty.com",
      leadEmail: "buyer@example.com",
      leadFirstName: "Jane",
      subject: "Follow up",
      messageBody: "Hello\nWorld",
    });

    const callArgs = mockSendMail.mock.calls[0][0];

    // MUST NOT contain the agent's individual email in From
    expect(callArgs.from).not.toContain("steven@lifestyledesignrealty.com");
    // MUST contain team@
    expect(callArgs.from).toContain("team@lifestyledesignrealty.com");
    // MUST contain agent's first name
    expect(callArgs.from).toContain("Steven");
  });

  it("From header format matches exact pattern: 'FirstName | Lifestyle Design Realty <team@lifestyledesignrealty.com>'", async () => {
    const { sendLeadFollowUpEmail } = await import("./botHelpers");

    const agents = ["Peter", "Tiffany", "Stefanie", "Abby", "Irma", "Laila", "Jason"];

    for (const agent of agents) {
      mockSendMail.mockClear();
      await sendLeadFollowUpEmail({
        agentFirstName: agent,
        agentLastName: "TestLast",
        agentEmail: `${agent.toLowerCase()}@lifestyledesignrealty.com`,
        leadEmail: "test@example.com",
        leadFirstName: "Lead",
        subject: "Test",
        messageBody: "Test body\nLine two",
      });

      const callArgs = mockSendMail.mock.calls[0][0];
      const expectedFrom = `${agent} | Lifestyle Design Realty <team@lifestyledesignrealty.com>`;
      expect(callArgs.from).toBe(expectedFrom);
      expect(callArgs.replyTo).toBe("peter@lifestyledesignrealty.com");
    }
  });
});
