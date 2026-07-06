import { describe, it, expect } from "vitest";

describe("Google Drive Token Validation", () => {
  it("should authenticate and list files from the Camera Roll folder", async () => {
    const token = process.env.GOOGLE_WORKSPACE_CLI_TOKEN || process.env.GOOGLE_DRIVE_TOKEN;
    expect(token).toBeTruthy();

    const FOLDER_ID = "16mNnK1avek0LUljjFPZ5iNxON2OJZod7";
    const url = `https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents&pageSize=1&fields=files(id,name)`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files).toBeDefined();
    expect(data.files.length).toBeGreaterThan(0);
    console.log(`Drive token valid - found file: ${data.files[0].name}`);
  });
});
