import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../../home-paths.js";
import {
  applyMemoryBridgeForFallbackStep,
  renderHarnessMemoryBridgeMarkdown,
  resolveMemoryBridgeFilePath,
} from "./fallback-chain-memory-bridge.js";

// Mirrors the private encodeClaudeProjectDir() in agent-memory-files.ts: Claude Code encodes a
// project's working dir into a single path segment by replacing every non-alphanumeric character
// with "-", without collapsing runs.
function encodeClaudeProjectDir(absoluteDir: string): string {
  return absoluteDir.replace(/[^a-zA-Z0-9]/g, "-");
}

describe("fallback-chain memory bridge", () => {
  let tempRoot: string;
  let previousPaperclipHome: string | undefined;
  let previousClaudeConfigDir: string | undefined;
  const companyId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const claudeAgent = { id: agentId, companyId, adapterType: "claude_local", adapterConfig: {} };

  async function writeHarnessMemory(input: { indexBody: string; facts: Record<string, string> }) {
    const workspaceDir = resolveDefaultAgentWorkspaceDir(agentId);
    const memoryDir = path.join(
      process.env.CLAUDE_CONFIG_DIR!,
      "projects",
      encodeClaudeProjectDir(path.resolve(workspaceDir)),
      "memory",
    );
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "MEMORY.md"), input.indexBody, "utf8");
    for (const [name, body] of Object.entries(input.facts)) {
      await fs.writeFile(path.join(memoryDir, name), body, "utf8");
    }
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fallback-chain-memory-bridge-"));
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.PAPERCLIP_HOME = path.join(tempRoot, "instance");
    process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, "claude-config");
  });

  afterEach(async () => {
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("returns null when the agent has no harness memory to bridge", async () => {
    await expect(renderHarnessMemoryBridgeMarkdown(claudeAgent)).resolves.toBeNull();
  });

  it("renders the MEMORY.md index and linked fact files into one markdown document", async () => {
    await writeHarnessMemory({
      indexBody: "# MEMORY.md\n\n- see [board prefers async standups](board-async-standups.md)\n",
      facts: { "board-async-standups.md": "The board prefers async written standups over calls.\n" },
    });

    const rendered = await renderHarnessMemoryBridgeMarkdown(claudeAgent);
    expect(rendered).not.toBeNull();
    expect(rendered).toContain("board prefers async written standups");
    expect(rendered).toContain("Continuity memory (fallback-chain bridge)");
  });

  it("is a no-op for a claude-family target (native harness auto-memory)", async () => {
    await writeHarnessMemory({
      indexBody: "# MEMORY.md\n",
      facts: { "fact.md": "Some durable fact.\n" },
    });

    const result = await applyMemoryBridgeForFallbackStep({
      sourceAgent: claudeAgent,
      targetAdapterType: "claude_local",
      targetAdapterConfig: { cwd: "/some/path" },
    });

    expect(result).toEqual({ cwd: "/some/path" });
    await expect(fs.stat(resolveMemoryBridgeFilePath(claudeAgent))).rejects.toThrow();
  });

  it("writes a bridge file and points instructionsFilePath at it for a non-claude target", async () => {
    await writeHarnessMemory({
      indexBody: "# MEMORY.md\n",
      facts: { "kimi-board-standup.md": "The board prefers async written standups over calls.\n" },
    });

    const result = await applyMemoryBridgeForFallbackStep({
      sourceAgent: claudeAgent,
      targetAdapterType: "codex_local",
      targetAdapterConfig: {},
    });

    const bridgePath = resolveMemoryBridgeFilePath(claudeAgent);
    expect(result.instructionsFilePath).toBe(bridgePath);
    const written = await fs.readFile(bridgePath, "utf8");
    expect(written).toContain("board prefers async written standups");
  });

  it("preserves an existing instructionsFilePath's content ahead of the bridged memory", async () => {
    await writeHarnessMemory({
      indexBody: "# MEMORY.md\n",
      facts: { "fact.md": "A durable fact worth carrying over.\n" },
    });
    const existingInstructionsPath = path.join(tempRoot, "AGENTS.md");
    await fs.writeFile(existingInstructionsPath, "# AGENTS.md\n\nAlways run tests before committing.\n", "utf8");

    const result = await applyMemoryBridgeForFallbackStep({
      sourceAgent: claudeAgent,
      targetAdapterType: "codex_local",
      targetAdapterConfig: { instructionsFilePath: existingInstructionsPath },
    });

    const written = await fs.readFile(result.instructionsFilePath as string, "utf8");
    expect(written).toContain("Always run tests before committing.");
    expect(written).toContain("A durable fact worth carrying over.");
    // The original file itself is untouched; only the bridge file combines both.
    const original = await fs.readFile(existingInstructionsPath, "utf8");
    expect(original).not.toContain("A durable fact worth carrying over.");
  });

  it("leaves the target adapterConfig untouched when the source agent has no memory to bridge", async () => {
    const result = await applyMemoryBridgeForFallbackStep({
      sourceAgent: claudeAgent,
      targetAdapterType: "codex_local",
      targetAdapterConfig: { instructionsFilePath: "/some/existing/AGENTS.md" },
    });
    expect(result).toEqual({ instructionsFilePath: "/some/existing/AGENTS.md" });
  });
});
