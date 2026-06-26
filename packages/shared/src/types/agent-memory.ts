// Types for the agent "Memories" panel — surfaces files written by the
// para-memory-files skill under an agent's home dir ($AGENT_HOME).

export type AgentMemoryFileKind = "markdown" | "yaml";

export type AgentMemoryParaCategory = "projects" | "areas" | "resources" | "archives";

/**
 * Which backing store an overview was read from:
 * - "harness": Claude adapter harness auto-memory (flat MEMORY.md + per-fact <slug>.md).
 * - "para": portable para-memory-files layout (MEMORY.md + life/ + daily notes).
 */
export type AgentMemorySource = "harness" | "para";

export interface AgentMemoryFileSummary {
  /** Path relative to the agent home dir, e.g. "memory/2026-06-23.md". */
  relativePath: string;
  /** Basename, e.g. "2026-06-23.md". */
  title: string;
  kind: AgentMemoryFileKind;
  byteSize: number;
  /** ISO timestamp of last modification. */
  modifiedAt: string;
}

export interface AgentMemoryDailyNote extends AgentMemoryFileSummary {
  /** "YYYY-MM-DD" parsed from the filename. */
  date: string;
}

export interface AgentMemoryItemsFile extends AgentMemoryFileSummary {
  /** Number of top-level facts in items.yaml, or null if it could not be parsed. */
  factCount: number | null;
}

export interface AgentMemoryParaEntity {
  category: AgentMemoryParaCategory;
  /** e.g. "people" | "companies" for entities nested under areas/. */
  subcategory?: string | null;
  /** Entity folder name. */
  name: string;
  /** Directory relative to the agent home dir, e.g. "life/areas/people/jeff". */
  relativeDir: string;
  summary: AgentMemoryFileSummary | null;
  items: AgentMemoryItemsFile | null;
}

export interface AgentMemoryOverview {
  agentId: string;
  companyId: string;
  /** Which backing store this overview was read from. */
  memorySource: AgentMemorySource;
  /** False when the agent has never written any memory files. */
  hasMemories: boolean;
  /** MEMORY.md (tacit layer for para; index for harness). */
  tacit: AgentMemoryFileSummary | null;
  /** life/index.md (para only; null for harness). */
  index: AgentMemoryFileSummary | null;
  /** Daily notes, newest first (para only; empty for harness). */
  dailyNotes: AgentMemoryDailyNote[];
  /** Knowledge-graph (PARA) entities (para only; empty for harness). */
  paraEntities: AgentMemoryParaEntity[];
  /** Individual harness auto-memory fact files (harness only; empty for para). */
  harnessFacts: AgentMemoryFileSummary[];
  /** True when scanning hit the entry cap and the listing is incomplete. */
  truncated: boolean;
}

/** A parsed atomic fact from items.yaml (snake_case fields mapped to camelCase). */
export interface AgentMemoryFact {
  id: string | null;
  fact: string | null;
  /** relationship | milestone | status | preference (free-form). */
  category: string | null;
  timestamp: string | null;
  source: string | null;
  /** active | superseded (free-form). */
  status: string | null;
  supersededBy: string | null;
  relatedEntities: string[];
  lastAccessed: string | null;
  accessCount: number | null;
}

export interface AgentMemoryFileResource {
  relativePath: string;
  title: string;
  kind: AgentMemoryFileKind;
  byteSize: number;
  modifiedAt: string;
}

export interface AgentMemoryFileContent {
  resource: AgentMemoryFileResource;
  content: { encoding: "utf8"; data: string };
  /** Populated server-side when kind === "yaml" and parsing succeeded. */
  facts?: AgentMemoryFact[] | null;
  /** Set when items.yaml could not be parsed; raw content is still returned. */
  parseError?: string | null;
}

export interface UpdateAgentMemoryFileRequest {
  path: string;
  content: string;
}
