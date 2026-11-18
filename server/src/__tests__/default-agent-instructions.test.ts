import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveAgentMemoryMode,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions bundle", () => {
  it("includes the memory HEARTBEAT.md for the default (non-CEO) role", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    expect(Object.keys(bundle)).toContain("AGENTS.md");
    expect(Object.keys(bundle)).toContain("HEARTBEAT.md");
    // The default HEARTBEAT.md drives the memory lifecycle for every para agent.
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

  it("never leaks raw memory markers into any rendered bundle", async () => {
    for (const role of ["default", "ceo"] as const) {
      for (const adapterType of ["codex_local", "claude_local"]) {
        const bundle = await loadDefaultAgentInstructionsBundle(role, { adapterType });
        for (const content of Object.values(bundle)) {
          expect(content).not.toMatch(/<!-- MEMORY:/);
        }
      }
    }
  });
});

describe("adapter-aware memory mode", () => {
  it("routes Claude adapters to harness memory and everything else to para", () => {
    expect(resolveAgentMemoryMode("claude_local")).toBe("harness");
    expect(resolveAgentMemoryMode("claude_anything")).toBe("harness");
    expect(resolveAgentMemoryMode("codex_local")).toBe("para");
    expect(resolveAgentMemoryMode("gemini_local")).toBe("para");
    expect(resolveAgentMemoryMode(undefined)).toBe("para");
    expect(resolveAgentMemoryMode(null)).toBe("para");
  });

  it("Codex/other agents keep the para mandate unchanged (default role)", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default", { adapterType: "codex_local" });
    expect(Object.keys(bundle)).toContain("HEARTBEAT.md");
    expect(bundle["AGENTS.md"]).toMatch(/para-memory-files/);
    expect(bundle["AGENTS.md"]).toMatch(/## Memory and Planning/);
    expect(bundle["HEARTBEAT.md"]).toMatch(/para-memory-files/);
  });

  it("Claude agents get harness auto-memory and a harness-variant HEARTBEAT.md (default role)", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default", { adapterType: "claude_local" });
    // No para mandate anywhere (the harness text may still name the skill to say "do NOT use it").
    expect(bundle["AGENTS.md"]).not.toMatch(/MUST use the [`']?para-memory-files/);
    // Harness auto-memory is described instead.
    expect(bundle["AGENTS.md"]).toMatch(/auto-memory/i);
    expect(bundle["AGENTS.md"]).toMatch(/MEMORY\.md/);
    // HEARTBEAT.md is kept for a complete, consistent bundle — but with harness content,
    // and AGENTS.md still references it.
    expect(Object.keys(bundle)).toContain("HEARTBEAT.md");
    expect(bundle["AGENTS.md"]).toMatch(/HEARTBEAT\.md/);
    expect(bundle["HEARTBEAT.md"]).toMatch(/auto-memory/i);
    // The para lifecycle is gone: no $AGENT_HOME paths, no qmd recall, and it explicitly
    // tells the agent NOT to run the para skill.
    expect(bundle["HEARTBEAT.md"]).not.toMatch(/\$AGENT_HOME/);
    expect(bundle["HEARTBEAT.md"]).not.toMatch(/qmd/);
    expect(bundle["HEARTBEAT.md"]).toMatch(/do NOT use the [`']?para-memory-files/);
  });

  it("Claude CEO keeps coordination HEARTBEAT but drops the para memory lifecycle", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo", { adapterType: "claude_local" });
    // CEO still gets its heartbeat (coordination), but with no para mandate.
    expect(Object.keys(bundle)).toContain("HEARTBEAT.md");
    expect(bundle["AGENTS.md"]).not.toMatch(/MUST use the [`']?para-memory-files/);
    expect(bundle["HEARTBEAT.md"]).not.toMatch(/para-memory-files/);
    expect(bundle["AGENTS.md"]).toMatch(/auto-memory/i);
    // Coordination sections survive.
    expect(bundle["HEARTBEAT.md"]).toMatch(/Delegation/);
  });

  it("Codex CEO keeps the para memory lifecycle in both AGENTS.md and HEARTBEAT.md", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo", { adapterType: "codex_local" });
    expect(bundle["AGENTS.md"]).toMatch(/para-memory-files/);
    expect(bundle["HEARTBEAT.md"]).toMatch(/para-memory-files/);
    expect(bundle["HEARTBEAT.md"]).toMatch(/Fact Extraction/);
  });
});
