import { describe, expect, it } from "vitest";
import {
  MANAGED_GOAL_BLOCK_END,
  MANAGED_GOAL_BLOCK_MAX_CHARS,
  MANAGED_GOAL_BLOCK_START,
  MANAGED_GOAL_MAX_DECISIONS,
  deriveGoalObjectiveFromDescription,
  extractGoalUpdateFromRunResult,
  extractManagedGoalBlock,
  hasManagedGoalBlock,
  preserveManagedGoalBlockOnWrite,
  readManagedGoalBlockDecisions,
  renderManagedGoalBlock,
  stripManagedGoalBlock,
  syncManagedGoalBlockInDescription,
  upsertManagedGoalBlock,
} from "../services/managed-goal-block.js";

const HUMAN = "## Objective\n\nBuild the thing.\n\n## Acceptance Criteria\n\n- It works.";

describe("managed goal block", () => {
  it("renders a block with objective, decisions, and next action", () => {
    const block = renderManagedGoalBlock({
      objective: "Ship Option C",
      decisions: ["Board chose C on 2026-08-11", "No edits to live server/src"],
      nextAction: "Open the PR",
    });
    expect(block).not.toBeNull();
    expect(block).toContain(MANAGED_GOAL_BLOCK_START);
    expect(block).toContain(MANAGED_GOAL_BLOCK_END);
    expect(block).toContain("**Goal:** Ship Option C");
    expect(block).toContain("- Board chose C on 2026-08-11");
    expect(block).toContain("**Next:** Open the PR");
  });

  it("returns null when there is no objective", () => {
    expect(renderManagedGoalBlock({ objective: "   " })).toBeNull();
    expect(renderManagedGoalBlock({ objective: "", decisions: ["x"] })).toBeNull();
  });

  it("inserts the block at the top and preserves human text", () => {
    const out = upsertManagedGoalBlock(HUMAN, { objective: "Ship Option C" });
    expect(out.startsWith(MANAGED_GOAL_BLOCK_START)).toBe(true);
    expect(out).toContain(HUMAN);
    expect(hasManagedGoalBlock(out)).toBe(true);
  });

  it("is idempotent: re-upserting identical fields does not stack blocks", () => {
    const once = upsertManagedGoalBlock(HUMAN, { objective: "Ship Option C" });
    const twice = upsertManagedGoalBlock(once, { objective: "Ship Option C" });
    expect(twice).toBe(once);
    expect(twice.match(new RegExp(MANAGED_GOAL_BLOCK_START, "g"))?.length).toBe(1);
  });

  it("replaces a stale block rather than appending a second one", () => {
    const v1 = upsertManagedGoalBlock(HUMAN, { objective: "Old goal" });
    const v2 = upsertManagedGoalBlock(v1, { objective: "New goal" });
    expect(v2.match(new RegExp(MANAGED_GOAL_BLOCK_START, "g"))?.length).toBe(1);
    expect(v2).toContain("**Goal:** New goal");
    expect(v2).not.toContain("**Goal:** Old goal");
    expect(v2).toContain(HUMAN);
  });

  it("strips the block back to the human-authored remainder", () => {
    const withBlock = upsertManagedGoalBlock(HUMAN, { objective: "Ship Option C" });
    expect(stripManagedGoalBlock(withBlock)).toBe(HUMAN);
    expect(stripManagedGoalBlock(HUMAN)).toBe(HUMAN);
    expect(stripManagedGoalBlock(null)).toBe("");
  });

  it("extracts the inner block content for change-detection", () => {
    const withBlock = upsertManagedGoalBlock(HUMAN, { objective: "Ship Option C" });
    const inner = extractManagedGoalBlock(withBlock);
    expect(inner).toContain("**Goal:** Ship Option C");
    expect(extractManagedGoalBlock(HUMAN)).toBeNull();
    expect(extractManagedGoalBlock(null)).toBeNull();
  });

  describe("clobber protection", () => {
    it("re-attaches the existing block when an external edit drops it", () => {
      const existing = upsertManagedGoalBlock(HUMAN, { objective: "Ship Option C" });
      const externalEdit = "## Objective\n\nBuild the thing differently.";
      const merged = preserveManagedGoalBlockOnWrite(existing, externalEdit);
      expect(hasManagedGoalBlock(merged as string)).toBe(true);
      expect(merged).toContain("**Goal:** Ship Option C");
      expect(merged).toContain("Build the thing differently.");
    });

    it("respects an incoming description that carries its own block (platform regen)", () => {
      const existing = upsertManagedGoalBlock(HUMAN, { objective: "Old goal" });
      const incoming = upsertManagedGoalBlock(HUMAN, { objective: "New goal" });
      const merged = preserveManagedGoalBlockOnWrite(existing, incoming);
      expect(merged).toBe(incoming);
      expect(merged).toContain("**Goal:** New goal");
    });

    it("passes through undefined/null (no description change)", () => {
      const existing = upsertManagedGoalBlock(HUMAN, { objective: "Ship Option C" });
      expect(preserveManagedGoalBlockOnWrite(existing, undefined)).toBeUndefined();
      expect(preserveManagedGoalBlockOnWrite(existing, null)).toBeNull();
    });

    it("no-ops when neither side has a block", () => {
      const incoming = "## Objective\n\nPlain text.";
      expect(preserveManagedGoalBlockOnWrite(HUMAN, incoming)).toBe(incoming);
    });
  });

  describe("run-end sync", () => {
    it("derives the objective from the Objective section, then first paragraph", () => {
      expect(deriveGoalObjectiveFromDescription(HUMAN)).toBe("Build the thing.");
      expect(deriveGoalObjectiveFromDescription("Just do the task.\n\nmore")).toBe("Just do the task.");
      expect(deriveGoalObjectiveFromDescription("")).toBeNull();
      expect(deriveGoalObjectiveFromDescription(null)).toBeNull();
    });

    it("derives from human text even when a managed block is present", () => {
      const withBlock = upsertManagedGoalBlock(HUMAN, { objective: "stale" });
      expect(deriveGoalObjectiveFromDescription(withBlock)).toBe("Build the thing.");
    });

    it("adds a block on run-end and is idempotent", () => {
      const synced = syncManagedGoalBlockInDescription(HUMAN);
      expect(hasManagedGoalBlock(synced)).toBe(true);
      expect(synced).toContain("**Goal:** Build the thing.");
      expect(synced).toContain(HUMAN);
      expect(syncManagedGoalBlockInDescription(synced)).toBe(synced);
    });

    it("no-ops on empty/null description", () => {
      expect(syncManagedGoalBlockInDescription("")).toBe("");
      expect(syncManagedGoalBlockInDescription(null)).toBe("");
    });

    it("updates the block goal line when the objective changes", () => {
      const changed = HUMAN.replace("Build the thing.", "Build a different thing.");
      const stale = upsertManagedGoalBlock(changed, { objective: "Build the thing." });
      const resynced = syncManagedGoalBlockInDescription(stale);
      expect(resynced).toContain("**Goal:** Build a different thing.");
      expect(resynced).not.toContain("**Goal:** Build the thing.");
    });
  });

  describe("Option B — agent-distilled goal update", () => {
    it("objectiveOverride wins over the static first-paragraph derivation", () => {
      const synced = syncManagedGoalBlockInDescription(HUMAN, {
        objectiveOverride: "Ship the sync mechanism",
      });
      expect(synced).toContain("**Goal:** Ship the sync mechanism");
      expect(synced).not.toContain("**Goal:** Build the thing.");
    });

    it("renders distilled decisions and is idempotent for identical input", () => {
      const synced = syncManagedGoalBlockInDescription(HUMAN, {
        extraDecisions: ["Board chose Option B", "No edits to live server/src"],
      });
      expect(synced).toContain("- Board chose Option B");
      expect(synced).toContain("- No edits to live server/src");
      expect(
        syncManagedGoalBlockInDescription(synced, {
          extraDecisions: ["Board chose Option B", "No edits to live server/src"],
        }),
      ).toBe(synced);
    });

    it("replaces the decision set (does not append) on the next distillation", () => {
      const v1 = syncManagedGoalBlockInDescription(HUMAN, { extraDecisions: ["Old decision"] });
      const v2 = syncManagedGoalBlockInDescription(v1, { extraDecisions: ["New decision"] });
      expect(v2).toContain("- New decision");
      expect(v2).not.toContain("- Old decision");
    });

    it("de-dupes and bounds the decision list", () => {
      const many = Array.from({ length: MANAGED_GOAL_MAX_DECISIONS + 5 }, (_, i) => `decision ${i}`);
      const synced = syncManagedGoalBlockInDescription(HUMAN, {
        extraDecisions: ["Dup", "dup", "  Dup  ", ...many],
      });
      const rendered = readManagedGoalBlockDecisions(synced);
      expect(rendered.length).toBeLessThanOrEqual(MANAGED_GOAL_MAX_DECISIONS);
      // "Dup"/"dup"/"  Dup  " collapse to a single entry.
      expect(rendered.filter((d) => d.toLowerCase() === "dup")).toHaveLength(1);
    });

    it("readManagedGoalBlockDecisions round-trips the rendered decisions", () => {
      const synced = syncManagedGoalBlockInDescription(HUMAN, {
        extraDecisions: ["First decision", "Second decision"],
      });
      expect(readManagedGoalBlockDecisions(synced)).toEqual(["First decision", "Second decision"]);
      expect(readManagedGoalBlockDecisions(HUMAN)).toEqual([]);
      expect(readManagedGoalBlockDecisions(null)).toEqual([]);
    });
  });

  describe("extractGoalUpdateFromRunResult", () => {
    it("reads a structured resultJson.goalUpdate object", () => {
      const update = extractGoalUpdateFromRunResult({
        goalUpdate: { objective: "Do X", decisions: ["A", "B"] },
      });
      expect(update).toEqual({ objective: "Do X", decisions: ["A", "B"] });
    });

    it("reads a fenced ```paperclip:goal block from the final message text", () => {
      const result =
        "Some final message.\n\n```paperclip:goal\n{\"objective\": \"Ship B\", \"decisions\": [\"Board picked B\"]}\n```\n";
      const update = extractGoalUpdateFromRunResult({ result });
      expect(update).toEqual({ objective: "Ship B", decisions: ["Board picked B"] });
    });

    it("returns null when there is no goal update and ignores malformed JSON", () => {
      expect(extractGoalUpdateFromRunResult(null)).toBeNull();
      expect(extractGoalUpdateFromRunResult({ result: "no block here" })).toBeNull();
      expect(
        extractGoalUpdateFromRunResult({ result: "```paperclip:goal\n{ not json }\n```" }),
      ).toBeNull();
      expect(extractGoalUpdateFromRunResult({ goalUpdate: { decisions: [] } })).toBeNull();
    });

    it("tolerates an objective-only or decisions-only update", () => {
      expect(extractGoalUpdateFromRunResult({ goalUpdate: { objective: "Only goal" } })).toEqual({
        objective: "Only goal",
        decisions: [],
      });
      expect(extractGoalUpdateFromRunResult({ goalUpdate: { decisions: ["Only decision"] } })).toEqual({
        objective: null,
        decisions: ["Only decision"],
      });
    });
  });

  it("caps block length while keeping the closing marker parseable", () => {
    const huge = Array.from({ length: 400 }, (_, i) => `decision number ${i} with padding text`);
    const block = renderManagedGoalBlock({ objective: "x", decisions: huge })!;
    expect(block.length).toBeLessThanOrEqual(MANAGED_GOAL_BLOCK_MAX_CHARS);
    expect(block.endsWith(MANAGED_GOAL_BLOCK_END)).toBe(true);
    // Still round-trips: stripping a capped block leaves no marker debris.
    expect(hasManagedGoalBlock(block)).toBe(true);
    expect(stripManagedGoalBlock(`${block}\n\nhuman`)).toBe("human");
  });
});
