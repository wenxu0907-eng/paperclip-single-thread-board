import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentMemoryFileService } from "../services/agent-memory-files.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const AGENT = { id: "agent-1", companyId: "company-1" };

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
  const cleanupDirs = new Set<string>();
  const svc = agentMemoryFileService();
  let homeDir: string;

  beforeEach(async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-memory-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    homeDir = resolveDefaultAgentWorkspaceDir(AGENT.id);
  });

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
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
});
