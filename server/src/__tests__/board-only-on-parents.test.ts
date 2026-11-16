import { describe, expect, it } from "vitest";
import {
  boardOnlyOnParentsActive,
  boardOnlyOnParentsEnabled,
  violatesBoardOnlyOnParents,
  violatesBoardOnlyOnParentsReviewer,
} from "../services/board-only-on-parents.js";

describe("boardOnlyOnParentsEnabled", () => {
  it("defaults to off when the flag is unset or empty", () => {
    expect(boardOnlyOnParentsEnabled({})).toBe(false);
    expect(boardOnlyOnParentsEnabled({ PAPERCLIP_BOARD_ONLY_ON_PARENTS: "" })).toBe(false);
    expect(boardOnlyOnParentsEnabled({ PAPERCLIP_BOARD_ONLY_ON_PARENTS: "off" })).toBe(false);
    expect(boardOnlyOnParentsEnabled({ PAPERCLIP_BOARD_ONLY_ON_PARENTS: "0" })).toBe(false);
  });

  it("is enabled for truthy flag values (case-insensitive)", () => {
    for (const raw of ["1", "true", "TRUE", "on", "Yes"]) {
      expect(boardOnlyOnParentsEnabled({ PAPERCLIP_BOARD_ONLY_ON_PARENTS: raw })).toBe(true);
    }
  });
});

describe("violatesBoardOnlyOnParents", () => {
  it("rejects a human assignee on a child issue", () => {
    expect(violatesBoardOnlyOnParents({ hasParent: true, assigneeUserId: "user-1" })).toBe(true);
  });

  it("allows a human assignee on a top-level issue", () => {
    expect(violatesBoardOnlyOnParents({ hasParent: false, assigneeUserId: "user-1" })).toBe(false);
  });

  it("allows children with no human assignee (agent-owned or unassigned)", () => {
    expect(violatesBoardOnlyOnParents({ hasParent: true, assigneeUserId: null })).toBe(false);
    expect(violatesBoardOnlyOnParents({ hasParent: true, assigneeUserId: undefined })).toBe(false);
    expect(violatesBoardOnlyOnParents({ hasParent: true, assigneeUserId: "   " })).toBe(false);
  });
});

describe("violatesBoardOnlyOnParentsReviewer", () => {
  it("rejects a human reviewer on a child issue", () => {
    expect(violatesBoardOnlyOnParentsReviewer({ hasParent: true, reviewerUserId: "user-1" })).toBe(true);
  });

  it("allows a human reviewer on a top-level issue", () => {
    expect(violatesBoardOnlyOnParentsReviewer({ hasParent: false, reviewerUserId: "user-1" })).toBe(false);
  });

  it("allows children with no human reviewer (agent reviewer or unset)", () => {
    // Agent reviewers never surface a reviewerUserId, so the guard sees null/undefined.
    expect(violatesBoardOnlyOnParentsReviewer({ hasParent: true, reviewerUserId: null })).toBe(false);
    expect(violatesBoardOnlyOnParentsReviewer({ hasParent: true, reviewerUserId: undefined })).toBe(false);
    expect(violatesBoardOnlyOnParentsReviewer({ hasParent: true, reviewerUserId: "   " })).toBe(false);
  });
});

describe("boardOnlyOnParentsActive", () => {
  it("is active when the env flag is on, regardless of the company setting", () => {
    expect(boardOnlyOnParentsActive({ envEnabled: true, companySetting: false })).toBe(true);
    expect(boardOnlyOnParentsActive({ envEnabled: true, companySetting: null })).toBe(true);
    expect(boardOnlyOnParentsActive({ envEnabled: true, companySetting: undefined })).toBe(true);
    expect(boardOnlyOnParentsActive({ envEnabled: true, companySetting: true })).toBe(true);
  });

  it("is active when the company opts in, even with the env flag off", () => {
    expect(boardOnlyOnParentsActive({ envEnabled: false, companySetting: true })).toBe(true);
  });

  it("is inactive when neither the env flag nor the company setting is on", () => {
    expect(boardOnlyOnParentsActive({ envEnabled: false, companySetting: false })).toBe(false);
    expect(boardOnlyOnParentsActive({ envEnabled: false, companySetting: null })).toBe(false);
    expect(boardOnlyOnParentsActive({ envEnabled: false, companySetting: undefined })).toBe(false);
  });
});
