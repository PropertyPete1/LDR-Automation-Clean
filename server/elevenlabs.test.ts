import { describe, it, expect } from "vitest";

describe("ElevenLabs API Key Validation", () => {
  it("should authenticate and list voices successfully", async () => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    expect(apiKey).toBeTruthy();

    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey! },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.voices).toBeDefined();
    expect(Array.isArray(data.voices)).toBe(true);
    expect(data.voices.length).toBeGreaterThan(0);

    // Verify "Peters pro voice" exists
    const peterVoice = data.voices.find(
      (v: { name: string }) => v.name.toLowerCase() === "peters pro voice"
    );
    expect(peterVoice).toBeDefined();
    console.log(`Found voice: "${peterVoice.name}" (ID: ${peterVoice.voice_id})`);
  });
});
