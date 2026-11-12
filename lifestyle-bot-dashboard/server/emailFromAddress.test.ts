import { withCompleteHistory } from "./portalHistoryTestSupport";
/** Lead header behavior is preserved after the fresh-person portal gate. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSendMail = vi.fn().mockResolvedValue({ messageId: "synthetic" });
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mockSendMail }) } }));
vi.mock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));

const options = {
  personId: 990001,
  provenance: { source: "Website Form" },
  agentFirstName: "Synthetic",
  agentLastName: "Agent",
  agentEmail: "agent@example.invalid",
  leadEmail: "fixture@example.invalid",
  leadFirstName: null,
  subject: "Synthetic subject",
  messageBody: "Synthetic body",
};

describe("Lead-Facing Email From-Address", () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(withCompleteHistory({
      ok: true, status: 200, json: async () => ({ id: 990001, source: "Website Form" }),
    })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("TEAM_EMAIL constant retains the existing internal alias", async () => {
    const { TEAM_EMAIL } = await import("./botHelpers");
    expect(TEAM_EMAIL).toBe("team@lifestyledesignrealty.com");
  });
  it("LEAD_REPLY_TO retains the existing internal inbox", async () => {
    const { LEAD_REPLY_TO, PETER_EMAIL } = await import("./botHelpers");
    expect(LEAD_REPLY_TO).toBe(PETER_EMAIL);
  });
  it("sendLeadFollowUpEmail preserves From, Reply-To, recipient and BCC", async () => {
    const { sendLeadFollowUpEmail, TEAM_EMAIL, LEAD_REPLY_TO, PETER_EMAIL } = await import("./botHelpers");
    expect(await sendLeadFollowUpEmail(options)).toEqual({ sent: true });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.from).toBe(`Synthetic | Lifestyle Design Realty <${TEAM_EMAIL}>`);
    expect(call.replyTo).toBe(LEAD_REPLY_TO);
    expect(call.to).toBe(options.leadEmail);
    expect(call.bcc).toBe(PETER_EMAIL);
  });
  it("From header uses the existing team alias rather than agent email", async () => {
    const { sendLeadFollowUpEmail, TEAM_EMAIL } = await import("./botHelpers");
    await sendLeadFollowUpEmail(options);
    expect(mockSendMail.mock.calls[0][0].from).not.toContain(options.agentEmail);
    expect(mockSendMail.mock.calls[0][0].from).toContain(TEAM_EMAIL);
  });
  it("From format remains identical for synthetic agent variants", async () => {
    const { sendLeadFollowUpEmail, TEAM_EMAIL, LEAD_REPLY_TO } = await import("./botHelpers");
    for (const agentFirstName of ["SyntheticA", "SyntheticB", "SyntheticC"]) {
      mockSendMail.mockClear();
      await sendLeadFollowUpEmail({ ...options, agentFirstName });
      expect(mockSendMail.mock.calls[0][0].from).toBe(`${agentFirstName} | Lifestyle Design Realty <${TEAM_EMAIL}>`);
      expect(mockSendMail.mock.calls[0][0].replyTo).toBe(LEAD_REPLY_TO);
    }
  });
});
