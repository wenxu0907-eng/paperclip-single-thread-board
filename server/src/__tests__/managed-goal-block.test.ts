import { describe, expect, it } from "vitest";
import {
  BOARD_DECISION_ACCEPTED_PREFIX,
  BOARD_DECISION_DECLINED_PREFIX,
  BOARD_DECISION_SUPERSEDED_SUFFIX,
  isCompletionClaimObjective,
  MANAGED_GOAL_BLOCK_END,
  MANAGED_GOAL_BLOCK_MAX_CHARS,
  MANAGED_GOAL_BLOCK_START,
  MANAGED_GOAL_MAX_DECISIONS,
  deriveGoalObjectiveFromDescription,
  extractGoalUpdateFromRunResult,
  extractManagedGoalBlock,
  foldBoardDecisionIntoDescription,
  hasManagedGoalBlock,
  isBoardAuthoredDecision,
  preserveManagedGoalBlockOnWrite,
  readManagedGoalBlockDecisions,
  readManagedGoalBlockObjective,
  renderBoardDecisionLine,
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

  describe("COM-294 recurrence — board decision fold-in", () => {
    const DATE = new Date("2026-08-12T10:00:00Z");
    // A description whose block carries a stale standing preference (the TRA-6 bug).
    const withStalePref = syncManagedGoalBlockInDescription(HUMAN, {
      objectiveOverride: "Produce the video",
      extraDecisions: ["Prefer free post-layer fixes before spending Vidu credits"],
    });

    it("renders an imperative, self-bounded accepted line", () => {
      const line = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "Approve spending credits to generate shot #1 (the plaque shot)",
        date: DATE,
      })!;
      expect(line.startsWith(BOARD_DECISION_ACCEPTED_PREFIX)).toBe(true);
      expect(line).toContain("2026-08-12");
      expect(line).toContain("execute this now");
      expect(isBoardAuthoredDecision(line)).toBe(true);
    });

    it("renders a declined line with an optional reason", () => {
      const line = renderBoardDecisionLine({
        outcome: "declined",
        summary: "Spend credits on the intro",
        reason: "too expensive for a first pass",
        date: DATE,
      })!;
      expect(line.startsWith(BOARD_DECISION_DECLINED_PREFIX)).toBe(true);
      expect(line).toContain("do not pursue this");
      expect(line).toContain("reason: too expensive");
      expect(isBoardAuthoredDecision(line)).toBe(true);
    });

    it("returns null for an empty summary", () => {
      expect(renderBoardDecisionLine({ outcome: "accepted", summary: "   ", date: DATE })).toBeNull();
    });

    it("folds an accepted decision in as the newest, top-most decision", () => {
      const line = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "Generate shot #1 via credits",
        date: DATE,
      })!;
      const next = foldBoardDecisionIntoDescription(withStalePref, line);
      const decisions = readManagedGoalBlockDecisions(next);
      expect(decisions[0]).toBe(line); // board decision is first / most authoritative
      expect(decisions).toContain("Prefer free post-layer fixes before spending Vidu credits");
      // Objective is preserved (not downgraded to a description-derived one).
      expect(readManagedGoalBlockObjective(next)).toBe("Produce the video");
    });

    it("is idempotent — folding the same decision twice is a no-op", () => {
      const line = renderBoardDecisionLine({ outcome: "accepted", summary: "Do X", date: DATE })!;
      const once = foldBoardDecisionIntoDescription(withStalePref, line);
      const twice = foldBoardDecisionIntoDescription(once, line);
      expect(twice).toBe(once);
      expect(readManagedGoalBlockDecisions(twice).filter((d) => d === line)).toHaveLength(1);
    });

    it("no-ops when there is no objective to anchor a block on", () => {
      const line = renderBoardDecisionLine({ outcome: "accepted", summary: "Do X", date: DATE })!;
      expect(foldBoardDecisionIntoDescription("", line)).toBe("");
      expect(foldBoardDecisionIntoDescription(null, line)).toBe("");
    });

    it("survives run-end agent distillation that forgot to re-echo it", () => {
      // Board approves -> folded in.
      const line = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "Generate shot #1 via credits",
        date: DATE,
      })!;
      const afterFold = foldBoardDecisionIntoDescription(withStalePref, line);

      // Next run: the agent distills its own decisions and forgets the board one.
      // The continuation-summary caller keeps board-authored decisions on top.
      const preserved = readManagedGoalBlockDecisions(afterFold);
      const preservedBoard = preserved.filter(isBoardAuthoredDecision);
      const agentDecisions = ["Use ffmpeg deshake for the push-in segment"];
      const afterRun = syncManagedGoalBlockInDescription(afterFold, {
        objectiveOverride: "Produce the video",
        extraDecisions: [...preservedBoard, ...agentDecisions],
      });
      const finalDecisions = readManagedGoalBlockDecisions(afterRun);
      expect(finalDecisions).toContain(line); // board decision NOT wiped
      expect(finalDecisions).toContain("Use ffmpeg deshake for the push-in segment");
    });

    it("readManagedGoalBlockObjective returns null without a block", () => {
      expect(readManagedGoalBlockObjective(HUMAN)).toBeNull();
      expect(readManagedGoalBlockObjective(null)).toBeNull();
    });
  });

  describe("COM-361 recency-precedence supersession", () => {
    const DATE_OLD = new Date("2026-08-11T10:00:00Z");
    const DATE_NEW = new Date("2026-08-12T02:00:00Z");
    const base = syncManagedGoalBlockInDescription(HUMAN, {
      objectiveOverride: "Produce the launch video",
    });

    it("demotes a prior accepted approval when a newer accepted direction arrives", () => {
      const older = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "Reference-mode 720p/5s paid试镜 with FLF params",
        date: DATE_OLD,
      })!;
      const withOlder = foldBoardDecisionIntoDescription(base, older);
      expect(readManagedGoalBlockDecisions(withOlder)[0]).toContain("execute this now");

      const newer = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "Rework: 1080p/8s, rename to 糖小豆, drop style, follow reference only",
        date: DATE_NEW,
      })!;
      const withNewer = foldBoardDecisionIntoDescription(withOlder, newer);
      const decisions = readManagedGoalBlockDecisions(withNewer);

      // Newest direction is first and keeps top authority.
      expect(decisions[0]).toBe(newer);
      expect(decisions[0]).toContain("execute this now");
      // The older approval is demoted: imperative stripped, superseded note added.
      const demoted = decisions.find((d) => d.includes("720p/5s"))!;
      expect(demoted).not.toContain("execute this now");
      expect(demoted).not.toContain("overrides any standing preference");
      expect(demoted).toContain(BOARD_DECISION_SUPERSEDED_SUFFIX.trim());
      // Exactly one line still carries the top-authority imperative.
      expect(decisions.filter((d) => d.includes("execute this now"))).toHaveLength(1);
    });

    it("still demotes when a long-summary approval was truncated mid-imperative", () => {
      // A CJK summary at the 150-char cap makes the rendered line exceed the 240-char
      // decision cap, so sanitizeDecisions clips the imperative tail. Supersession must
      // still fire off the un-truncatable "— execute this now" marker.
      const longSummary = "返修方向确认".repeat(30); // > 150 chars, gets capped to 150
      const older = renderBoardDecisionLine({
        outcome: "accepted",
        summary: longSummary,
        date: DATE_OLD,
      })!;
      const withOlder = foldBoardDecisionIntoDescription(base, older);
      const storedOld = readManagedGoalBlockDecisions(withOlder)[0];
      // Confirm the stored line was truncated (full imperative tail is gone).
      expect(storedOld).toContain("— execute this now");
      expect(storedOld.endsWith("to the contrary.")).toBe(false);

      const newer = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "New direction",
        date: DATE_NEW,
      })!;
      const decisions = readManagedGoalBlockDecisions(
        foldBoardDecisionIntoDescription(withOlder, newer),
      );
      const demoted = decisions.find((d) => d.includes("返修方向确认"))!;
      expect(demoted).not.toContain("execute this now");
      // The suffix head survives even if this very long summary clips its tail.
      expect(demoted).toContain("superseded by a newer board decision");
    });

    it("does NOT demote a prior approval when the incoming decision is a decline", () => {
      const approval = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "Ship the 1080p rework",
        date: DATE_OLD,
      })!;
      const withApproval = foldBoardDecisionIntoDescription(base, approval);
      const decline = renderBoardDecisionLine({
        outcome: "declined",
        summary: "Add an unrelated intro card",
        date: DATE_NEW,
      })!;
      const decisions = readManagedGoalBlockDecisions(
        foldBoardDecisionIntoDescription(withApproval, decline),
      );
      // The standing approval keeps its authority; a decline of X doesn't retire Y.
      const kept = decisions.find((d) => d.includes("1080p rework"))!;
      expect(kept).toContain("execute this now");
    });

    it("is idempotent — re-folding the newest approval does not double or re-demote", () => {
      const older = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "Old approval",
        date: DATE_OLD,
      })!;
      const newer = renderBoardDecisionLine({
        outcome: "accepted",
        summary: "New approval",
        date: DATE_NEW,
      })!;
      const once = foldBoardDecisionIntoDescription(
        foldBoardDecisionIntoDescription(base, older),
        newer,
      );
      const twice = foldBoardDecisionIntoDescription(once, newer);
      expect(twice).toBe(once);
      // The newest still carries authority; the older stays demoted (single copy).
      const decisions = readManagedGoalBlockDecisions(twice);
      expect(decisions.filter((d) => d.includes("execute this now"))).toHaveLength(1);
      expect(decisions.filter((d) => d.includes("Old approval"))).toHaveLength(1);
    });
  });

  describe("COM-361 completion-claim guard", () => {
    it("detects English and Chinese completion claims", () => {
      expect(isCompletionClaimObjective("Reference-mode paid试镜 already executed; nothing pending")).toBe(
        true,
      );
      expect(isCompletionClaimObjective("这个 Reference Mode 我们已经做过了")).toBe(true);
      expect(isCompletionClaimObjective("无待办事项")).toBe(true);
      expect(isCompletionClaimObjective("Task is complete")).toBe(true);
    });

    it("does not fire on a live, in-progress objective", () => {
      expect(isCompletionClaimObjective("Produce the 1080p/8s rework video (糖小豆)")).toBe(false);
      expect(isCompletionClaimObjective("Fix the goal-block supersession gap")).toBe(false);
      expect(isCompletionClaimObjective(null)).toBe(false);
      expect(isCompletionClaimObjective("")).toBe(false);
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
