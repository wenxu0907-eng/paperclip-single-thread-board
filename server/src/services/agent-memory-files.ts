import fs from "node:fs/promises";
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

type AgentLike = { id: string; companyId: string };

const TEXT_SNIFF_BYTES = 4096;
const MAX_PARSED_FACTS = 2000;
const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const PARA_CATEGORIES: AgentMemoryParaCategory[] = ["projects", "areas", "resources", "archives"];
const AREA_SUBCATEGORIES = ["people", "companies"];

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
  function resolveRoot(agent: AgentLike): string {
    try {
      return resolveDefaultAgentWorkspaceDir(agent.id);
    } catch {
      throw unprocessable("Invalid agent id for memory path", { code: "invalid_agent_id" });
    }
  }

  function emptyOverview(agent: AgentLike): AgentMemoryOverview {
    return {
      agentId: agent.id,
      companyId: agent.companyId,
      hasMemories: false,
      tacit: null,
      index: null,
      dailyNotes: [],
      paraEntities: [],
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

  async function getOverview(agent: AgentLike): Promise<AgentMemoryOverview> {
    const root = resolveRoot(agent);
    const rootReal = await realpathOrNull(root);
    if (!rootReal) return emptyOverview(agent);

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
      hasMemories,
      tacit,
      index,
      dailyNotes,
      paraEntities,
      truncated: scan.count >= WORKSPACE_FILE_LIST_MAX_SCANNED_ENTRIES,
    };
  }

  /** Allow only paths that belong to the para-memory-files layout. */
  function assertMemoryPath(relativePath: string): void {
    const isAllowed =
      relativePath === "MEMORY.md" ||
      relativePath === "life/index.md" ||
      /^memory\/[^/]+\.md$/.test(relativePath) ||
      /^life\/(projects|areas|resources|archives)\/.+\/(summary\.md|items\.yaml)$/.test(relativePath);
    if (!isAllowed) {
      throw new HttpError(403, "Path is not an agent memory file", { code: "not_a_memory_file" });
    }
  }

  async function readMemoryFile(agent: AgentLike, relativePathInput: string): Promise<AgentMemoryFileContent> {
    const normalized = normalizeWorkspaceRelativePath(relativePathInput);
    throwIfDenied(normalized.segments);
    assertMemoryPath(normalized.relativePath);

    const root = resolveRoot(agent);
    const rootReal = await realpathOrNull(root);
    if (!rootReal) throw notFound("Memory file not found");
    const targetReal = await resolveWithinRoot(rootReal, normalized.relativePath);
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
    const kind = memoryFileKind(normalized.relativePath);

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
        relativePath: normalized.relativePath,
        title: path.posix.basename(normalized.relativePath),
        kind,
        byteSize: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      },
      content: { encoding: "utf8", data },
      facts,
      parseError,
    };
  }

  async function writeMemoryFile(
    agent: AgentLike,
    relativePathInput: string,
    content: string,
  ): Promise<AgentMemoryFileContent> {
    const normalized = normalizeWorkspaceRelativePath(relativePathInput);
    throwIfDenied(normalized.segments);
    assertMemoryPath(normalized.relativePath);

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

    const root = resolveRoot(agent);
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

  return { getOverview, readMemoryFile, writeMemoryFile };
}
