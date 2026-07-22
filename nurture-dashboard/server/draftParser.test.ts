import { describe, it, expect } from "vitest";
import { stripDraftReasoning } from "./draftParser";

describe("stripDraftReasoning", () => {
  describe("clean SMS responses (no stripping needed)", () => {
    it("returns a clean single-line SMS unchanged", () => {
      const input = "Hey Lisbet, how's the home search going in San Antonio?";
      expect(stripDraftReasoning(input)).toBe(input);
    });

    it("returns a clean two-sentence SMS unchanged", () => {
      const input = "Hey Ken, hope you had a great week! Still thinking about that place in Frisco?";
      expect(stripDraftReasoning(input)).toBe(input);
    });

    it("strips surrounding double quotes", () => {
      expect(stripDraftReasoning('"Hey Lisa, any updates on your search?"'))
        .toBe("Hey Lisa, any updates on your search?");
    });

    it("strips surrounding single quotes", () => {
      expect(stripDraftReasoning("'Hey Lisa, any updates on your search?'"))
        .toBe("Hey Lisa, any updates on your search?");
    });

    it("strips surrounding smart quotes", () => {
      expect(stripDraftReasoning("\u201CHey Lisa, how\u2019s it going?\u201D"))
        .toBe("Hey Lisa, how\u2019s it going?");
    });
  });

  describe("reasoning preamble stripping (the Lisbet bug)", () => {
    it("strips multi-paragraph reasoning before the SMS", () => {
      const input = `The notes don't contain specific details about Lisbet's search (city, price range, property type) — only that follow-ups were sent. I'll craft something warm that references the ongoing outreach without being generic.

Hey Lisbet, how's the home search feeling? Any new areas catching your eye?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Lisbet, how's the home search feeling? Any new areas catching your eye?");
    });

    it("strips 'I'll craft...' reasoning followed by the actual SMS", () => {
      const input = `I'll craft something warm and specific. Hey Ken, still thinking about San Antonio? Let me know if anything changes!`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Ken, still thinking about San Antonio? Let me know if anything changes!");
    });

    it("strips 'Here's a...' preamble", () => {
      const input = `Here's a friendly follow-up text:

Hey Melissa, just checking in! How's your home search going?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Melissa, just checking in! How's your home search going?");
    });

    it("strips 'Based on...' reasoning", () => {
      const input = `Based on the limited notes, I'll keep it simple and friendly.

Hey David, hope your week's going well! Still looking at homes in Austin?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey David, hope your week's going well! Still looking at homes in Austin?");
    });

    it("strips 'The notes show...' commentary", () => {
      const input = `The notes show only automated follow-ups with no personal details.

Just wanted to check in, Sarah! Are you still exploring options in Dallas?`;
      expect(stripDraftReasoning(input))
        .toBe("Just wanted to check in, Sarah! Are you still exploring options in Dallas?");
    });

    it("strips 'This message...' meta-commentary", () => {
      const input = `This message should be warm but not pushy since they haven't responded.

Hey Tom, hope things are good! Any updates on your timeline for buying?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Tom, hope things are good! Any updates on your timeline for buying?");
    });

    it("strips 'Since the notes...' reasoning", () => {
      const input = `Since the notes are thin, I'll ask a simple question.

Hey Maria, what areas in Texas are you most interested in?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Maria, what areas in Texas are you most interested in?");
    });

    it("strips 'Given that...' reasoning", () => {
      const input = `Given that this lead has been in the system for 15 days with no response, I should be direct.

Hey James, still interested in finding a home in Houston?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey James, still interested in finding a home in Houston?");
    });

    it("strips 'Looking at the notes...' reasoning", () => {
      const input = `Looking at the notes, there's not much to reference specifically.

Hey Alex, how's the home search going? Anything I can help with?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Alex, how's the home search going? Anything I can help with?");
    });

    it("strips 'Let me...' reasoning", () => {
      const input = `Let me write something that feels personal despite thin notes.

Hey Chris, hope you're having a great week! Still thinking about Texas?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Chris, hope you're having a great week! Still thinking about Texas?");
    });
  });

  describe("single-line reasoning with embedded SMS", () => {
    it("strips inline reasoning sentence before SMS", () => {
      const input = `The notes don't have specifics. Hey Lisbet, how's the home search feeling?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Lisbet, how's the home search feeling?");
    });

    it("strips 'I'll craft' inline before SMS", () => {
      const input = `I'll craft a warm message. Hey Ken, any news on the job front?`;
      expect(stripDraftReasoning(input))
        .toBe("Hey Ken, any news on the job front?");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(stripDraftReasoning("")).toBe("");
    });

    it("handles null/undefined gracefully", () => {
      expect(stripDraftReasoning(null as any)).toBe("");
      expect(stripDraftReasoning(undefined as any)).toBe("");
    });

    it("handles a response that is ONLY reasoning (no SMS)", () => {
      // Should return the text as-is since we can't confidently strip
      const input = "The notes don't contain enough information to write a personalized message.";
      const result = stripDraftReasoning(input);
      // It should still return something (the text itself as fallback)
      expect(result.length).toBeGreaterThan(0);
    });

    it("preserves emoji in clean SMS", () => {
      const input = "Hey Lisa, saw a great listing in Frisco! Want me to send details? 🏡";
      expect(stripDraftReasoning(input)).toBe(input);
    });

    it("handles multi-line reasoning with newlines (not paragraph breaks)", () => {
      const input = `The notes only mention follow-ups.\nI'll keep it simple.\nHey Mike, how's the search going?`;
      const result = stripDraftReasoning(input);
      expect(result).toBe("Hey Mike, how's the search going?");
    });
  });

  describe("thin-notes scenarios (the real-world case)", () => {
    it("produces clean SMS for a lead with only follow-up notes", () => {
      // Simulates what the model SHOULD output with the fixed prompt
      // but if it still leaks reasoning, the parser catches it
      const leakedResponse = `The notes don't contain specific details about Lisbet's search (city, price range, property type) — only that follow-ups were sent. I'll craft something warm that references the ongoing outreach without being generic.

How's the home search feeling, Lisbet? Any new areas catching your eye?`;
      const result = stripDraftReasoning(leakedResponse);
      expect(result).not.toContain("The notes don't");
      expect(result).not.toContain("I'll craft");
      expect(result).toContain("Lisbet");
      expect(result.length).toBeLessThan(200);
    });

    it("handles the exact Lisbet example from the bug report", () => {
      const exactBugInput = `The notes don't contain specific details about Lisbet's search (city, price range, property type) — only that follow-ups were sent. I'll craft something warm that references the ongoing outreach without being generic.

How's the home search feeling?`;
      const result = stripDraftReasoning(exactBugInput);
      expect(result).toBe("How's the home search feeling?");
    });
  });
});
