import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  insert: vi.fn(() => ({ values: () => ({ onDuplicateKeyUpdate: async () => {} }) })),
  smtp: vi.fn().mockResolvedValue({ messageId: "synthetic" }),
}));
vi.mock("./db", () => ({ getDb: vi.fn(async () => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  insert: fixture.insert,
})) }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: fixture.smtp }) } }));
import { generateFollowUpMessage, sendLeadFollowUpEmail } from "./botHelpers";

const personId = 990001;
const draftOptions = {
  agentFirstName: "Synthetic", agentLastName: "Agent", leadFirstName: null,
  daysStale: 5, stage: "Lead", person: { id: personId, source: "Website Form" },
};
let currentSource = "Zillow";
beforeEach(() => {
  vi.clearAllMocks();
  currentSource = "Zillow";
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("/v1/messages")) return {
      ok: true, status: 200, json: async () => ({ content: [{ text: "SUBJECT: Synthetic\nSynthetic body" }] }),
    } as Response;
    if (String(url).includes(`/people/${personId}?fields=allFields`)) return {
      ok: true, status: 200, json: async () => ({ id: personId, source: currentSource }),
    } as Response;
    if (String(url).includes(`/v1/events?personId=${personId}&limit=100`)) return {
      ok: true, status: 200, json: async () => ({ events: [], _metadata: { collection: "events", total: 0 } }),
    } as Response;
    throw new Error("SYNTHETIC_UNEXPECTED_REQUEST");
  }));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("actual drafting defers the angle sent record and a denied delivery never writes it", async () => {
  const draft = await generateFollowUpMessage({ ...draftOptions, deferSentRecord: true });
  expect(draft.recordDelivery).toBeTypeOf("function");
  expect(fixture.insert).not.toHaveBeenCalled();
  const delivery = await sendLeadFollowUpEmail({
    personId, provenance: draftOptions.person, agentEmail: "agent@example.invalid",
    agentFirstName: "Synthetic", agentLastName: "Agent", leadFirstName: null,
    leadEmail: "fixture@example.invalid", subject: draft.subject, messageBody: draft.body,
  });
  if (delivery.sent) await draft.recordDelivery?.();
  expect(delivery).toEqual({ sent: false, reason: "PORTAL_SOURCE" });
  expect(fixture.smtp).not.toHaveBeenCalled();
  expect(fixture.insert).not.toHaveBeenCalled();
});

it("successful delivery records the same angle only after SMTP", async () => {
  currentSource = "Website Form";
  const draft = await generateFollowUpMessage({ ...draftOptions, deferSentRecord: true });
  expect(fixture.insert).not.toHaveBeenCalled();
  const delivery = await sendLeadFollowUpEmail({
    personId, provenance: draftOptions.person, agentEmail: "agent@example.invalid",
    agentFirstName: "Synthetic", agentLastName: "Agent", leadFirstName: null,
    leadEmail: "fixture@example.invalid", subject: draft.subject, messageBody: draft.body,
  });
  expect(delivery).toEqual({ sent: true });
  expect(fixture.insert).not.toHaveBeenCalled();
  await draft.recordDelivery?.();
  expect(fixture.insert).toHaveBeenCalledTimes(1);
  expect(fixture.smtp.mock.invocationCallOrder[0]).toBeLessThan(fixture.insert.mock.invocationCallOrder[0]);
});

it("direct generation defaults retain existing angle recording behavior", async () => {
  const draft = await generateFollowUpMessage(draftOptions);
  expect(draft.recordDelivery).toBeUndefined();
  expect(fixture.insert).toHaveBeenCalledTimes(1);
});
