import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions bundle", () => {
  it("includes the memory HEARTBEAT.md for the default (non-CEO) role", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    expect(Object.keys(bundle)).toContain("AGENTS.md");
    expect(Object.keys(bundle)).toContain("HEARTBEAT.md");
    // The default HEARTBEAT.md drives the memory lifecycle for every agent.
    expect(bundle["HEARTBEAT.md"]).toMatch(/\$AGENT_HOME/);
    expect(bundle["HEARTBEAT.md"]).toMatch(/para-memory-files/);
    // The mandate must reach the default AGENTS.md too.
    expect(bundle["AGENTS.md"]).toMatch(/para-memory-files/);
  });

  it("maps non-CEO roles to the default bundle and CEO to its own", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("cmo")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
  });

  it("still provides the CEO heartbeat with strengthened extraction", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo");
    expect(Object.keys(bundle)).toContain("HEARTBEAT.md");
    expect(bundle["HEARTBEAT.md"]).toMatch(/Extract/);
  });
});
