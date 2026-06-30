import { describe, it, expect } from "vitest";
import { getConnectedNetworks } from "./metricool";

describe("Metricool API", () => {
  it("should return connected networks for the brand", async () => {
    const networks = await getConnectedNetworks();
    // Should have at least Instagram connected
    expect(Array.isArray(networks)).toBe(true);
    expect(networks.length).toBeGreaterThan(0);
    const instagram = networks.find(n => n.network === "INSTAGRAM");
    expect(instagram).toBeDefined();
    expect(instagram?.id).toBeTruthy();
  }, 15000);

  it("should include LinkedIn now that it is connected", async () => {
    const networks = await getConnectedNetworks();
    const linkedin = networks.find(n => n.network === "LINKEDIN");
    expect(linkedin).toBeDefined();
    expect(linkedin?.id).toBeTruthy();
  }, 15000);
});
