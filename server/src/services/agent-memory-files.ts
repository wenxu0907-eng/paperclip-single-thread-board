import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import type {
  AgentMemoryDailyNote,
  AgentMemoryFact,
  AgentMemoryFileContent,
  AgentMemoryFileKind,
  AgentMemoryFileSummary,
  AgentMemoryItemsFile,
  AgentMemoryOverview,
  AgentMemoryParaCategory,
  AgentMemoryParaEntity,
  AgentMemorySource,
  AgentProjectMemory,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  WORKSPACE_FILE_LIST_MAX_SCANNED_ENTRIES,
  WORKSPACE_FILE_TEXT_MAX_BYTES,
  isInsideRoot,
  looksLikeText,
  normalizeWorkspaceRelativePath,
  readStableFile,
  throwIfDenied,
} from "./workspace-file-resources.js";

type AgentLike = { id: string; companyId: string; adapterType?: string | null };

const TEXT_SNIFF_BYTES = 4096;
const MAX_PARSED_FACTS = 2000;
const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
/** Root-level markdown file (no nested segments) — the harness fact-file shape. */
const HARNESS_FILE_RE = /^[^/]+\.md$/;
const PARA_CATEGORIES: AgentMemoryParaCategory[] = ["projects", "areas", "resources", "archives"];
const AREA_SUBCATEGORIES = ["people", "companies"];

/**
 * Resolve the Claude Code config dir (`~/.claude` by default), mirroring
 * resolveSharedClaudeConfigDir in the claude-local adapter. Respecting
 * CLAUDE_CONFIG_DIR keeps this in lockstep with where the harness actually
 * writes auto-memory, and lets tests redirect it to a temp dir.
 */
function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

/**
 * Claude Code encodes a project's working dir into a single path segment by
 * replacing every "/" and "." with "-". Verified against a live path:
 *   /Users/cryswen/.paperclip/instances/default/workspaces/<id>
 *   -> -Users-cryswen--paperclip-instances-default-workspaces-<id>
 * (the leading "/" becomes "-"; "/." becomes "--").
 */
function encodeClaudeProjectDir(absoluteDir: string): string {
  return absoluteDir.replace(/[/.]/g, "-");
}

/**
 * The harness auto-memory dir for a given runtime working dir (cwd). Claude
 * keeps auto-memory under ~/.claude/projects/<encode(cwd)>/memory. For a
 * project-working agent the cwd is the project workspace dir, so this is how the
 * (shared) project-scoped memory is located.
 */
function harnessMemoryDirForCwd(absoluteCwd: string): string {
  return path.join(resolveClaudeConfigDir(), "projects", encodeClaudeProjectDir(absoluteCwd), "memory");
}

function resolveMemorySource(agent: AgentLike): AgentMemorySource {
  const adapter = (agent.adapterType ?? "").trim().toLowerCase();
  return adapter.startsWith("claude") ? "harness" : "para";
}

function memoryFileKind(relativePath: string): AgentMemoryFileKind {
  return relativePath.toLowerCase().endsWith(".yaml") || relativePath.toLowerCase().endsWith(".yml")
    ? "yaml"
    : "markdown";
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function realpathOrNull(targetPath: string): Promise<string | null> {
  return fs.realpath(targetPath).catch(() => null);
}

function summaryFromStat(relativePath: string, stat: { size: number; mtime: Date }): AgentMemoryFileSummary {
  return {
    relativePath,
    title: path.posix.basename(relativePath),
    kind: memoryFileKind(relativePath),
    byteSize: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/**
 * Resolve a relative path inside the agent home root, enforcing the same
 * realpath-containment + denylist hardening the workspace file service uses,
 * and skipping symlinks. Returns the realpath, or null when the target does not
 * exist / escapes the root / is denied / is a symlink.
 */
async function resolveWithinRoot(rootReal: string, relativePath: string): Promise<string | null> {
  const segments = relativePath.split("/").filter(Boolean);
  try {
    throwIfDenied(segments);
  } catch {
    return null;
  }
  const targetLexical = path.resolve(rootReal, ...segments);
  const lstat = await fs.lstat(targetLexical).catch(() => null);
  if (!lstat || lstat.isSymbolicLink()) return null;
  const targetReal = await realpathOrNull(targetLexical);
  if (!targetReal || !isInsideRoot(rootReal, targetReal)) return null;
  return targetReal;
}

async function fileSummaryWithinRoot(
  rootReal: string,
  relativePath: string,
): Promise<AgentMemoryFileSummary | null> {
  const targetReal = await resolveWithinRoot(rootReal, relativePath);
  if (!targetReal) return null;
  const stat = await statIfExists(targetReal);
  if (!stat || !stat.isFile()) return null;
  return summaryFromStat(relativePath, stat);
}

/** Best-effort fact count for an items.yaml file (top-level array length). */
async function countFacts(absolutePath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = parseYaml(raw);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function coerceString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function coerceFact(entry: unknown): AgentMemoryFact {
  const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
  const related = record.related_entities ?? record.relatedEntities;
  const relatedEntities = Array.isArray(related)
    ? related.map((item) => coerceString(item)).filter((item): item is string => item != null)
    : [];
  const accessRaw = record.access_count ?? record.accessCount;
  const accessCount = typeof accessRaw === "number" ? accessRaw : null;
  return {
    id: coerceString(record.id),
    fact: coerceString(record.fact),
    category: coerceString(record.category),
    timestamp: coerceString(record.timestamp),
    source: coerceString(record.source),
    status: coerceString(record.status),
    supersededBy: coerceString(record.superseded_by ?? record.supersededBy),
    relatedEntities,
    lastAccessed: coerceString(record.last_accessed ?? record.lastAccessed),
    accessCount,
  };
}

/** Parse items.yaml text into facts; throws when the top level is not an array. */
function parseFacts(raw: string): AgentMemoryFact[] {
  const parsed = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("items.yaml must contain a top-level list of facts");
  }
  return parsed.slice(0, MAX_PARSED_FACTS).map(coerceFact);
}

export function agentMemoryFileService() {
  function paraRootDir(agent: AgentLike): string {
    try {
      return resolveDefaultAgentWorkspaceDir(agent.id);
    } catch {
      throw unprocessable("Invalid agent id for memory path", { code: "invalid_agent_id" });
    }
  }

  function harnessRootDir(agent: AgentLike): string {
    // Claude harness auto-memory lives under ~/.claude/projects/<encoded-ws>/memory.
    return harnessMemoryDirForCwd(paraRootDir(agent));
  }

  function resolveRoot(agent: AgentLike, source: AgentMemorySource): string {
    return source === "harness" ? harnessRootDir(agent) : paraRootDir(agent);
  }

  /** True when a directory holds at least one top-level *.md file. */
  async function dirHasMarkdown(rootReal: string | null): Promise<boolean> {
    if (!rootReal) return false;
    const entries = await fs.readdir(rootReal, { withFileTypes: true }).catch(() => []);
    return entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"));
  }

  /** True when the para workspace holds any recognizable memory (MEMORY.md, life/, or memory/). */
  async function paraHasMemory(paraRootReal: string | null): Promise<boolean> {
    if (!paraRootReal) return false;
    if (await fileSummaryWithinRoot(paraRootReal, "MEMORY.md")) return true;
    for (const sub of ["life", "memory"]) {
      const subReal = await resolveWithinRoot(paraRootReal, sub);
      const st = subReal ? await statIfExists(subReal) : null;
      if (st?.isDirectory()) return true;
    }
    return false;
  }

  /**
   * Decide which store actually backs this agent's memory. Claude adapters use
   * harness auto-memory, but agents created before the migration (or still
   * running para) keep their memory in the workspace para layout. Prefer harness
   * when it has content; otherwise fall back to existing para memory so the
   * viewer never hides real memories. When both are empty, use the nominal
   * (adapter-derived) source so a fresh Claude agent still reads as harness.
   */
  async function resolveEffectiveSource(agent: AgentLike): Promise<AgentMemorySource> {
    if (resolveMemorySource(agent) !== "harness") return "para";
    if (await dirHasMarkdown(await realpathOrNull(harnessRootDir(agent)))) return "harness";
    if (await paraHasMemory(await realpathOrNull(paraRootDir(agent)))) return "para";
    return "harness";
  }

  function emptyOverview(agent: AgentLike, source: AgentMemorySource): AgentMemoryOverview {
    return {
      agentId: agent.id,
      companyId: agent.companyId,
      memorySource: source,
      hasMemories: false,
      tacit: null,
      index: null,
      dailyNotes: [],
      paraEntities: [],
      harnessFacts: [],
      projectMemories: [],
      truncated: false,
    };
  }

  async function listDailyNotes(rootReal: string, scan: { count: number }): Promise<AgentMemoryDailyNote[]> {
    const memoryDirReal = await resolveWithinRoot(rootReal, "memory");
    if (!memoryDirReal) return [];
    const memoryStat = await statIfExists(memoryDirReal);
    if (!memoryStat || !memoryStat.isDirectory()) return [];
    const entries = await fs.readdir(memoryDirReal, { withFileTypes: true }).catch(() => []);
    const notes: AgentMemoryDailyNote[] = [];
    for (const entry of entries) {
      if (scan.count >= WORKSPACE_FILE_LIST_MAX_SCANNED_ENTRIES) break;
      scan.count += 1;
      if (!entry.isFile() || !DAILY_NOTE_RE.test(entry.name)) continue;
      const summary = await fileSummaryWithinRoot(rootReal, `memory/${entry.name}`);
      if (!summary) continue;
      notes.push({ ...summary, date: entry.name.slice(0, 10) });
    }
    notes.sort((a, b) => b.date.localeCompare(a.date));
    return notes;
  }

  async function listEntitiesInDir(
    rootReal: string,
    category: AgentMemoryParaCategory,
    subcategory: string | null,
    relativeDir: string,
    scan: { count: number },
    out: AgentMemoryParaEntity[],
  ): Promise<void> {
    const dirReal = await resolveWithinRoot(rootReal, relativeDir);
    if (!dirReal) return;
    const dirStat = await statIfExists(dirReal);
    if (!dirStat || !dirStat.isDirectory()) return;
    const entries = await fs.readdir(dirReal, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scan.count >= WORKSPACE_FILE_LIST_MAX_SCANNED_ENTRIES) return;
      scan.count += 1;
      if (!entry.isDirectory()) continue;
      const entityDir = `${relativeDir}/${entry.name}`;
      const summary = await fileSummaryWithinRoot(rootReal, `${entityDir}/summary.md`);
      const itemsSummary = await fileSummaryWithinRoot(rootReal, `${entityDir}/items.yaml`);
      let items: AgentMemoryItemsFile | null = null;
      if (itemsSummary) {
        const itemsReal = await resolveWithinRoot(rootReal, `${entityDir}/items.yaml`);
        items = { ...itemsSummary, factCount: itemsReal ? await countFacts(itemsReal) : null };
      }
      if (!summary && !items) continue;
      out.push({ category, subcategory, name: entry.name, relativeDir: entityDir, summary, items });
    }
  }

  /**
   * Harness auto-memory is a flat directory: a MEMORY.md index plus one
   * <slug>.md file per fact. The root IS the memory dir, so we enumerate its
   * top-level *.md files (MEMORY.md surfaced as the index/tacit summary, the
   * rest as individual facts).
   */
  async function readHarnessDir(
    rootReal: string,
  ): Promise<{ tacit: AgentMemoryFileSummary | null; harnessFacts: AgentMemoryFileSummary[]; truncated: boolean }> {
    const scan = { count: 0 };
    const tacit = await fileSummaryWithinRoot(rootReal, "MEMORY.md");
    const harnessFacts: AgentMemoryFileSummary[] = [];
    const entries = await fs.readdir(rootReal, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scan.count >= WORKSPACE_FILE_LIST_MAX_SCANNED_ENTRIES) break;
      scan.count += 1;
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name === "MEMORY.md") continue;
      const summary = await fileSummaryWithinRoot(rootReal, entry.name);
      if (summary) harnessFacts.push(summary);
    }
    return { tacit, harnessFacts, truncated: scan.count >= WORKSPACE_FILE_LIST_MAX_SCANNED_ENTRIES };
  }

  async function getHarnessOverview(agent: AgentLike, rootReal: string): Promise<AgentMemoryOverview> {
    const { tacit, harnessFacts, truncated } = await readHarnessDir(rootReal);
    return {
      agentId: agent.id,
      companyId: agent.companyId,
      memorySource: "harness",
      hasMemories: Boolean(tacit) || harnessFacts.length > 0,
      tacit,
      index: null,
      dailyNotes: [],
      paraEntities: [],
      harnessFacts,
      projectMemories: [],
      truncated,
    };
  }

  /**
   * Read the (shared) harness auto-memory for each project the agent works in.
   * Each project's memory is keyed by its runtime working dir (`dir`). Projects
   * with no harness memory on disk are skipped, and duplicate dirs (e.g. two
   * projects sharing a checkout) are read once. DB-free: the caller resolves the
   * project dirs and passes them in.
   */
  async function getProjectHarnessOverviews(
    projects: { projectId: string; projectName: string; dir: string }[],
  ): Promise<AgentProjectMemory[]> {
    const out: AgentProjectMemory[] = [];
    const seenDirs = new Set<string>();
    for (const project of projects) {
      const dir = project.dir?.trim();
      if (!dir) continue;
      const harnessDir = harnessMemoryDirForCwd(dir);
      if (seenDirs.has(harnessDir)) continue;
      seenDirs.add(harnessDir);
      const rootReal = await realpathOrNull(harnessDir);
      if (!rootReal) continue;
      const { tacit, harnessFacts, truncated } = await readHarnessDir(rootReal);
      if (!tacit && harnessFacts.length === 0) continue;
      out.push({
        projectId: project.projectId,
        projectName: project.projectName,
        tacit,
        harnessFacts,
        truncated,
      });
    }
    return out;
  }

  async function getOverview(agent: AgentLike): Promise<AgentMemoryOverview> {
    const source = await resolveEffectiveSource(agent);
    const root = resolveRoot(agent, source);
    const rootReal = await realpathOrNull(root);
    if (!rootReal) return emptyOverview(agent, source);
    if (source === "harness") return getHarnessOverview(agent, rootReal);

    const scan = { count: 0 };
    const tacit = await fileSummaryWithinRoot(rootReal, "MEMORY.md");
    const index = await fileSummaryWithinRoot(rootReal, "life/index.md");
    const dailyNotes = await listDailyNotes(rootReal, scan);

    const paraEntities: AgentMemoryParaEntity[] = [];
    for (const category of PARA_CATEGORIES) {
      if (category === "areas") {
        for (const subcategory of AREA_SUBCATEGORIES) {
          await listEntitiesInDir(rootReal, category, subcategory, `life/areas/${subcategory}`, scan, paraEntities);
        }
      } else {
        await listEntitiesInDir(rootReal, category, null, `life/${category}`, scan, paraEntities);
      }
    }

    const hasMemories = Boolean(tacit) || Boolean(index) || dailyNotes.length > 0 || paraEntities.length > 0;
    return {
      agentId: agent.id,
      companyId: agent.companyId,
      memorySource: "para",
      hasMemories,
      tacit,
      index,
      dailyNotes,
      paraEntities,
      harnessFacts: [],
      projectMemories: [],
      truncated: scan.count >= WORKSPACE_FILE_LIST_MAX_SCANNED_ENTRIES,
    };
  }

  /** Allow only paths that belong to the resolved memory layout for this agent. */
  function assertMemoryPath(relativePath: string, source: AgentMemorySource): void {
    const isAllowed =
      source === "harness"
        ? // Flat harness layout: MEMORY.md + root-level <slug>.md fact files.
          HARNESS_FILE_RE.test(relativePath)
        : relativePath === "MEMORY.md" ||
          relativePath === "life/index.md" ||
          /^memory\/[^/]+\.md$/.test(relativePath) ||
          /^life\/(projects|areas|resources|archives)\/.+\/(summary\.md|items\.yaml)$/.test(relativePath);
    if (!isAllowed) {
      throw new HttpError(403, "Path is not an agent memory file", { code: "not_a_memory_file" });
    }
  }

  /** Read + validate a single memory file given an already-resolved root real path. */
  async function readFileFromRoot(
    rootReal: string,
    relativePath: string,
  ): Promise<AgentMemoryFileContent> {
    const targetReal = await resolveWithinRoot(rootReal, relativePath);
    if (!targetReal) throw notFound("Memory file not found");

    const stat = await statIfExists(targetReal);
    if (!stat || !stat.isFile()) throw notFound("Memory file not found");
    if (stat.size > WORKSPACE_FILE_TEXT_MAX_BYTES) {
      throw unprocessable("Memory file is too large to preview", { code: "too_large" });
    }

    const buffer = await readStableFile(targetReal, WORKSPACE_FILE_TEXT_MAX_BYTES);
    if (!looksLikeText(buffer.subarray(0, Math.min(buffer.length, TEXT_SNIFF_BYTES)))) {
      throw unprocessable("Memory file is not a text file", { code: "binary_content" });
    }
    const data = buffer.toString("utf8");
    const kind = memoryFileKind(relativePath);

    let facts: AgentMemoryFact[] | null = null;
    let parseError: string | null = null;
    if (kind === "yaml") {
      try {
        facts = parseFacts(data);
      } catch (error) {
        parseError = error instanceof Error ? error.message : "Failed to parse items.yaml";
      }
    }

    return {
      resource: {
        relativePath,
        title: path.posix.basename(relativePath),
        kind,
        byteSize: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      },
      content: { encoding: "utf8", data },
      facts,
      parseError,
    };
  }

  async function readMemoryFile(agent: AgentLike, relativePathInput: string): Promise<AgentMemoryFileContent> {
    const normalized = normalizeWorkspaceRelativePath(relativePathInput);
    throwIfDenied(normalized.segments);
    const source = await resolveEffectiveSource(agent);
    assertMemoryPath(normalized.relativePath, source);

    const root = resolveRoot(agent, source);
    const rootReal = await realpathOrNull(root);
    if (!rootReal) throw notFound("Memory file not found");
    return readFileFromRoot(rootReal, normalized.relativePath);
  }

  /**
   * Read a single file from a project's (shared) harness auto-memory dir. Only
   * the flat harness layout is valid here (MEMORY.md + root-level <slug>.md). The
   * caller resolves the project's runtime working dir and passes it in (DB-free).
   */
  async function readProjectMemoryFile(
    projectDir: string,
    relativePathInput: string,
  ): Promise<AgentMemoryFileContent> {
    const normalized = normalizeWorkspaceRelativePath(relativePathInput);
    throwIfDenied(normalized.segments);
    assertMemoryPath(normalized.relativePath, "harness");

    const trimmed = projectDir?.trim();
    if (!trimmed) throw notFound("Memory file not found");
    const rootReal = await realpathOrNull(harnessMemoryDirForCwd(trimmed));
    if (!rootReal) throw notFound("Memory file not found");
    return readFileFromRoot(rootReal, normalized.relativePath);
  }

  async function writeMemoryFile(
    agent: AgentLike,
    relativePathInput: string,
    content: string,
  ): Promise<AgentMemoryFileContent> {
    const normalized = normalizeWorkspaceRelativePath(relativePathInput);
    throwIfDenied(normalized.segments);
    const source = await resolveEffectiveSource(agent);
    assertMemoryPath(normalized.relativePath, source);

    if (Buffer.byteLength(content, "utf8") > WORKSPACE_FILE_TEXT_MAX_BYTES) {
      throw unprocessable("Memory file content is too large", { code: "too_large" });
    }
    if (content.includes("\0")) {
      throw unprocessable("Memory file content must be text", { code: "binary_content" });
    }
    // Reject content that would corrupt the agent's own loader.
    if (memoryFileKind(normalized.relativePath) === "yaml") {
      try {
        parseFacts(content);
      } catch (error) {
        throw unprocessable(error instanceof Error ? error.message : "Invalid items.yaml", {
          code: "invalid_yaml",
        });
      }
    }

    const root = resolveRoot(agent, source);
    await fs.mkdir(root, { recursive: true });
    const rootReal = await fs.realpath(root);

    const targetLexical = path.resolve(rootReal, ...normalized.segments);
    const parentDir = path.dirname(targetLexical);
    await fs.mkdir(parentDir, { recursive: true });
    // Re-check containment against the realpath of the parent before writing.
    const parentReal = await fs.realpath(parentDir);
    if (!isInsideRoot(rootReal, parentReal)) {
      throw new HttpError(403, "Path is outside the agent home", { code: "outside_workspace" });
    }
    const existing = await fs.lstat(targetLexical).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new HttpError(403, "Refusing to write through a symlink", { code: "denied_symlink" });
    }
    await fs.writeFile(targetLexical, content, "utf8");

    return readMemoryFile(agent, normalized.relativePath);
  }

  return { getOverview, getProjectHarnessOverviews, readMemoryFile, readProjectMemoryFile, writeMemoryFile };
}
