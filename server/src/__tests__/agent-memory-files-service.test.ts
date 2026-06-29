import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentMemoryFileService } from "../services/agent-memory-files.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const AGENT = { id: "agent-1", companyId: "company-1" };
const CODEX_AGENT = { id: "agent-1", companyId: "company-1", adapterType: "codex_local" };
const CLAUDE_AGENT = { id: "agent-1", companyId: "company-1", adapterType: "claude_local" };

function harnessMemoryDir(claudeConfigDir: string, agentId: string): string {
  const workspaceDir = resolveDefaultAgentWorkspaceDir(agentId);
  const encoded = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(claudeConfigDir, "projects", encoded, "memory");
}

async function seedHarness(memoryDir: string) {
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, "MEMORY.md"), "# Index\n- [Company](company.md) — hook\n", "utf8");
  await fs.writeFile(path.join(memoryDir, "company.md"), "Company structure fact.\n", "utf8");
  await fs.writeFile(path.join(memoryDir, "api-routes.md"), "Use PUT not POST.\n", "utf8");
}

async function seed(homeDir: string) {
  await fs.mkdir(path.join(homeDir, "memory"), { recursive: true });
  await fs.writeFile(path.join(homeDir, "MEMORY.md"), "# Tacit\nUser prefers concise replies.\n", "utf8");
  await fs.writeFile(path.join(homeDir, "memory", "2026-06-20.md"), "older note\n", "utf8");
  await fs.writeFile(path.join(homeDir, "memory", "2026-06-23.md"), "newer note\n", "utf8");
  await fs.writeFile(path.join(homeDir, "memory", "scratch.md"), "not a daily note\n", "utf8");

  await fs.mkdir(path.join(homeDir, "life", "projects", "launch"), { recursive: true });
  await fs.mkdir(path.join(homeDir, "life", "areas", "people", "jeff"), { recursive: true });
  await fs.writeFile(path.join(homeDir, "life", "index.md"), "# Index\n", "utf8");
  await fs.writeFile(path.join(homeDir, "life", "projects", "launch", "summary.md"), "Launch summary\n", "utf8");
  await fs.writeFile(
    path.join(homeDir, "life", "projects", "launch", "items.yaml"),
    [
      "- id: launch-001",
      '  fact: "Ship date is July"',
      "  category: milestone",
      "  status: active",
      "  superseded_by: null",
      "  related_entities:",
      "    - areas/people/jeff",
      "  last_accessed: \"2026-06-20\"",
      "  access_count: 3",
      "- id: launch-002",
      '  fact: "Old ship date"',
      "  category: milestone",
      "  status: superseded",
      "  superseded_by: launch-001",
      "  access_count: 0",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(homeDir, "life", "areas", "people", "jeff", "summary.md"), "Jeff\n", "utf8");
}

describe("agent memory file service", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const cleanupDirs = new Set<string>();
  const svc = agentMemoryFileService();
  let homeDir: string;
  let claudeConfigDir: string;

  beforeEach(async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-memory-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    claudeConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-memory-claude-"));
    cleanupDirs.add(claudeConfigDir);
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    homeDir = resolveDefaultAgentWorkspaceDir(AGENT.id);
  });

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("returns an empty overview when the home dir does not exist", async () => {
    const overview = await svc.getOverview(AGENT);
    expect(overview.hasMemories).toBe(false);
    expect(overview.dailyNotes).toEqual([]);
    expect(overview.paraEntities).toEqual([]);
    expect(overview.tacit).toBeNull();
  });

  it("groups memory files by layer, newest daily notes first", async () => {
    await seed(homeDir);
    const overview = await svc.getOverview(AGENT);

    expect(overview.hasMemories).toBe(true);
    expect(overview.tacit?.relativePath).toBe("MEMORY.md");
    expect(overview.index?.relativePath).toBe("life/index.md");

    expect(overview.dailyNotes.map((n) => n.date)).toEqual(["2026-06-23", "2026-06-20"]);

    const launch = overview.paraEntities.find((e) => e.name === "launch");
    expect(launch?.category).toBe("projects");
    expect(launch?.summary?.relativePath).toBe("life/projects/launch/summary.md");
    expect(launch?.items?.factCount).toBe(2);

    const jeff = overview.paraEntities.find((e) => e.name === "jeff");
    expect(jeff?.category).toBe("areas");
    expect(jeff?.subcategory).toBe("people");
  });

  it("reads a markdown file as utf8 text", async () => {
    await seed(homeDir);
    const result = await svc.readMemoryFile(AGENT, "MEMORY.md");
    expect(result.resource.kind).toBe("markdown");
    expect(result.content.data).toContain("concise replies");
    expect(result.facts ?? null).toBeNull();
  });

  it("parses items.yaml into facts with snake_case mapping", async () => {
    await seed(homeDir);
    const result = await svc.readMemoryFile(AGENT, "life/projects/launch/items.yaml");
    expect(result.resource.kind).toBe("yaml");
    expect(result.parseError ?? null).toBeNull();
    expect(result.facts).toHaveLength(2);
    const [first, second] = result.facts!;
    expect(first.id).toBe("launch-001");
    expect(first.relatedEntities).toEqual(["areas/people/jeff"]);
    expect(first.lastAccessed).toBe("2026-06-20");
    expect(first.accessCount).toBe(3);
    expect(second.status).toBe("superseded");
    expect(second.supersededBy).toBe("launch-001");
  });

  it("returns parseError but raw content for malformed items.yaml", async () => {
    await fs.mkdir(path.join(homeDir, "life", "projects", "bad"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, "life", "projects", "bad", "items.yaml"),
      "not_a_list: true\n",
      "utf8",
    );
    const result = await svc.readMemoryFile(AGENT, "life/projects/bad/items.yaml");
    expect(result.facts).toBeNull();
    expect(result.parseError).toBeTruthy();
    expect(result.content.data).toContain("not_a_list");
  });

  it("rejects path traversal", async () => {
    await seed(homeDir);
    await expect(svc.readMemoryFile(AGENT, "../../etc/passwd")).rejects.toMatchObject({ status: 403 });
  });

  it("rejects non-memory paths", async () => {
    await seed(homeDir);
    await fs.writeFile(path.join(homeDir, "AGENTS.md"), "secret\n", "utf8");
    await expect(svc.readMemoryFile(AGENT, "AGENTS.md")).rejects.toMatchObject({
      status: 403,
      details: { code: "not_a_memory_file" },
    });
  });

  it("rejects binary memory files", async () => {
    await fs.mkdir(path.join(homeDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(homeDir, "memory", "2026-06-24.md"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await expect(svc.readMemoryFile(AGENT, "memory/2026-06-24.md")).rejects.toMatchObject({
      status: 422,
      details: { code: "binary_content" },
    });
  });

  it("writes a markdown file and reflects the change on re-read", async () => {
    await seed(homeDir);
    const written = await svc.writeMemoryFile(AGENT, "MEMORY.md", "# Tacit\nUpdated.\n");
    expect(written.content.data).toContain("Updated.");
    const reread = await svc.readMemoryFile(AGENT, "MEMORY.md");
    expect(reread.content.data).toContain("Updated.");
  });

  it("creates the home dir on first write", async () => {
    const written = await svc.writeMemoryFile(AGENT, "MEMORY.md", "hello\n");
    expect(written.content.data).toBe("hello\n");
  });

  it("rejects writing invalid items.yaml and leaves the file unchanged", async () => {
    await seed(homeDir);
    const original = await fs.readFile(
      path.join(homeDir, "life", "projects", "launch", "items.yaml"),
      "utf8",
    );
    await expect(
      svc.writeMemoryFile(AGENT, "life/projects/launch/items.yaml", "not_a_list: true\n"),
    ).rejects.toMatchObject({ status: 422, details: { code: "invalid_yaml" } });
    const after = await fs.readFile(
      path.join(homeDir, "life", "projects", "launch", "items.yaml"),
      "utf8",
    );
    expect(after).toBe(original);
  });

  it("rejects writing to a non-memory path", async () => {
    await expect(svc.writeMemoryFile(AGENT, "AGENTS.md", "x")).rejects.toMatchObject({ status: 403 });
  });

  describe("adapter-aware source resolution", () => {
    it("para overview reports memorySource 'para' with no harness facts", async () => {
      await seed(homeDir);
      const overview = await svc.getOverview(CODEX_AGENT);
      expect(overview.memorySource).toBe("para");
      expect(overview.harnessFacts).toEqual([]);
      expect(overview.tacit?.relativePath).toBe("MEMORY.md");
      expect(overview.paraEntities.length).toBeGreaterThan(0);
    });

    it("Codex/other agent does NOT read the harness root (no regression, no leakage)", async () => {
      // Harness dir has files, but the para workspace dir is empty.
      await seedHarness(harnessMemoryDir(claudeConfigDir, CODEX_AGENT.id));
      const overview = await svc.getOverview(CODEX_AGENT);
      expect(overview.hasMemories).toBe(false);
      expect(overview.harnessFacts).toEqual([]);
    });

    it("Claude agent reads harness MEMORY.md + per-fact files from the encoded harness root", async () => {
      await seedHarness(harnessMemoryDir(claudeConfigDir, CLAUDE_AGENT.id));
      const overview = await svc.getOverview(CLAUDE_AGENT);
      expect(overview.memorySource).toBe("harness");
      expect(overview.hasMemories).toBe(true);
      expect(overview.tacit?.relativePath).toBe("MEMORY.md");
      expect(overview.index).toBeNull();
      expect(overview.dailyNotes).toEqual([]);
      expect(overview.paraEntities).toEqual([]);
      expect(overview.harnessFacts.map((f) => f.relativePath).sort()).toEqual([
        "api-routes.md",
        "company.md",
      ]);
    });

    it("Claude agent overview is empty when the harness root does not exist", async () => {
      const overview = await svc.getOverview(CLAUDE_AGENT);
      expect(overview.memorySource).toBe("harness");
      expect(overview.hasMemories).toBe(false);
      expect(overview.harnessFacts).toEqual([]);
    });

    it("Claude agent falls back to para memory when harness is empty (legacy/para data)", async () => {
      // Regression: a claude_local agent that still keeps memory in the workspace
      // para layout (e.g. migrated from codex) must not have it hidden by an
      // empty harness dir.
      await seed(homeDir);
      const overview = await svc.getOverview(CLAUDE_AGENT);
      expect(overview.memorySource).toBe("para");
      expect(overview.hasMemories).toBe(true);
      expect(overview.paraEntities.some((e) => e.name === "launch")).toBe(true);
      // The same fallback governs reads, so a para path resolves rather than 403s.
      const result = await svc.readMemoryFile(CLAUDE_AGENT, "life/projects/launch/items.yaml");
      expect(result.facts?.[0]?.id).toBe("launch-001");
    });

    it("Claude agent prefers harness over para when both exist", async () => {
      await seed(homeDir);
      await seedHarness(harnessMemoryDir(claudeConfigDir, CLAUDE_AGENT.id));
      const overview = await svc.getOverview(CLAUDE_AGENT);
      expect(overview.memorySource).toBe("harness");
      expect(overview.harnessFacts.length).toBeGreaterThan(0);
    });

    it("Claude agent reads an individual harness fact file", async () => {
      await seedHarness(harnessMemoryDir(claudeConfigDir, CLAUDE_AGENT.id));
      const result = await svc.readMemoryFile(CLAUDE_AGENT, "company.md");
      expect(result.resource.kind).toBe("markdown");
      expect(result.content.data).toContain("Company structure fact");
    });

    it("Claude agent writes a harness fact file and re-reads it", async () => {
      await seedHarness(harnessMemoryDir(claudeConfigDir, CLAUDE_AGENT.id));
      await svc.writeMemoryFile(CLAUDE_AGENT, "company.md", "Updated fact.\n");
      const reread = await svc.readMemoryFile(CLAUDE_AGENT, "company.md");
      expect(reread.content.data).toContain("Updated fact");
    });

    it("Claude agent rejects nested (non-harness) paths", async () => {
      await seedHarness(harnessMemoryDir(claudeConfigDir, CLAUDE_AGENT.id));
      await expect(svc.readMemoryFile(CLAUDE_AGENT, "life/index.md")).rejects.toMatchObject({
        status: 403,
        details: { code: "not_a_memory_file" },
      });
    });

    it("Claude agent rejects path traversal out of the harness root", async () => {
      await seedHarness(harnessMemoryDir(claudeConfigDir, CLAUDE_AGENT.id));
      await expect(svc.readMemoryFile(CLAUDE_AGENT, "../../etc/passwd")).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe("project-scoped harness memory", () => {
    function projectHarnessDir(claudeConfig: string, projectDir: string): string {
      const encoded = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
      return path.join(claudeConfig, "projects", encoded, "memory");
    }

    it("locates the harness dir for a managed '_default' project workspace (underscore encoding)", async () => {
      // Regression: Claude encodes every non-alphanumeric char (incl. '_') to '-',
      // so '/_default' becomes '--default'. Encoding only [/.] missed the real dir.
      const projDir = "/tmp/paperclip/projects/cid/pid/_default";
      await seedHarness(projectHarnessDir(claudeConfigDir, projDir));
      const overviews = await svc.getProjectHarnessOverviews([
        { projectId: "p", projectName: "Onboarding", dir: projDir },
      ]);
      expect(overviews).toHaveLength(1);
      expect(overviews[0].tacit?.relativePath).toBe("MEMORY.md");
      // And reads resolve through the same encoding.
      const file = await svc.readProjectMemoryFile(projDir, "company.md");
      expect(file.content.data).toContain("Company structure fact");
    });

    it("reads the shared harness memory for each project dir, skipping empties and dupes", async () => {
      const projA = path.join(os.tmpdir(), "paperclip-proj-a");
      const projB = path.join(os.tmpdir(), "paperclip-proj-b");
      await seedHarness(projectHarnessDir(claudeConfigDir, projA));
      // projB has no harness dir on disk -> skipped.

      const overviews = await svc.getProjectHarnessOverviews([
        { projectId: "a", projectName: "Project A", dir: projA },
        { projectId: "b", projectName: "Project B", dir: projB },
        { projectId: "a-dup", projectName: "Project A dup", dir: projA },
      ]);

      expect(overviews).toHaveLength(1);
      expect(overviews[0].projectId).toBe("a");
      expect(overviews[0].tacit?.relativePath).toBe("MEMORY.md");
      expect(overviews[0].harnessFacts.map((f) => f.relativePath).sort()).toEqual([
        "api-routes.md",
        "company.md",
      ]);
    });

    it("reads an individual project harness fact file", async () => {
      const projA = path.join(os.tmpdir(), "paperclip-proj-read");
      await seedHarness(projectHarnessDir(claudeConfigDir, projA));
      const result = await svc.readProjectMemoryFile(projA, "company.md");
      expect(result.content.data).toContain("Company structure fact");
    });

    it("rejects non-harness paths for project memory reads", async () => {
      const projA = path.join(os.tmpdir(), "paperclip-proj-reject");
      await seedHarness(projectHarnessDir(claudeConfigDir, projA));
      await expect(svc.readProjectMemoryFile(projA, "life/index.md")).rejects.toMatchObject({
        status: 403,
        details: { code: "not_a_memory_file" },
      });
    });

    it("404s when the project harness dir does not exist", async () => {
      await expect(
        svc.readProjectMemoryFile(path.join(os.tmpdir(), "paperclip-proj-none"), "company.md"),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
