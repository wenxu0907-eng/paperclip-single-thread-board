import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  buildEventResultSummary,
  HEARTBEAT_RUN_EVENT_SUMMARY_MAX_CHARS,
  isLinkableBaseUrl,
  mergeHeartbeatRunResultJson,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe("## Summary\n\n1. first thing\n2. second thing");
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({ summary: "done" });
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });
});

describe("isLinkableBaseUrl", () => {
  it("accepts absolute http(s) URLs, including localhost", () => {
    expect(isLinkableBaseUrl("https://app.example.com")).toBe(true);
    expect(isLinkableBaseUrl("http://paperclip.internal")).toBe(true);
    expect(isLinkableBaseUrl("http://localhost:3100")).toBe(true);
    expect(isLinkableBaseUrl("http://127.0.0.1:3100")).toBe(true);
  });

  it("rejects missing, non-http, and malformed URLs", () => {
    expect(isLinkableBaseUrl(undefined)).toBe(false);
    expect(isLinkableBaseUrl("")).toBe(false);
    expect(isLinkableBaseUrl("ftp://example.com")).toBe(false);
    expect(isLinkableBaseUrl("not a url")).toBe(false);
  });
});

describe("buildEventResultSummary", () => {
  it("returns null when there is no summary", () => {
    expect(buildEventResultSummary(null, "PAP-35", "https://app.example.com")).toBeNull();
  });

  it("leaves a short summary unchanged", () => {
    const short = "All done.";
    expect(buildEventResultSummary(short, "PAP-35", "https://app.example.com")).toBe(short);
  });

  it("appends a view-full-summary link for long summaries within the budget", () => {
    const long = "x".repeat(2000);
    const result = buildEventResultSummary(long, "PAP-35", "https://app.example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(HEARTBEAT_RUN_EVENT_SUMMARY_MAX_CHARS);
    // The entire markdown link must survive the consumer's leading slice.
    expect(result).toContain("[View full summary](https://app.example.com/PAP/issues/PAP-35)");
    expect(result!.startsWith("x")).toBe(true);
  });

  it("links to a localhost base URL too", () => {
    const long = "x".repeat(2000);
    const result = buildEventResultSummary(long, "PAP-35", "http://localhost:3100");
    expect(result).toContain("[View full summary](http://localhost:3100/PAP/issues/PAP-35)");
    expect(result!.length).toBeLessThanOrEqual(HEARTBEAT_RUN_EVENT_SUMMARY_MAX_CHARS);
  });

  it("returns the full text (no link) when no usable base URL or identifier", () => {
    const long = "x".repeat(2000);
    expect(buildEventResultSummary(long, null, "https://app.example.com")).toBe(long);
    expect(buildEventResultSummary(long, "PAP-35", undefined)).toBe(long);
    expect(buildEventResultSummary(long, "PAP-35", "ftp://example.com")).toBe(long);
  });
});
