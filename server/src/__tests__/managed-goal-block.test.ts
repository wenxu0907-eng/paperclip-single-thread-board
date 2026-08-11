import { describe, expect, it } from "vitest";
import {
  MANAGED_GOAL_BLOCK_END,
  MANAGED_GOAL_BLOCK_MAX_CHARS,
  MANAGED_GOAL_BLOCK_START,
  deriveGoalObjectiveFromDescription,
  extractManagedGoalBlock,
  hasManagedGoalBlock,
  preserveManagedGoalBlockOnWrite,
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
