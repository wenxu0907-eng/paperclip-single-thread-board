import { describe, expect, it } from "vitest";
import { isFallbackEligibleAdapterFailure, isQuotaOrBillingFailure } from "./quota-windows.js";

describe("isQuotaOrBillingFailure", () => {
  it("classifies a claude_local usage-limit message as quota/billing", () => {
    expect(
      isQuotaOrBillingFailure("claude_local", {
        errorCode: "adapter_failed",
        error: "You've hit your usage limit for Claude. Try again at 4:30 PM.",
      }),
    ).toBe(true);
  });

  it("classifies Claude's monthly-spend-limit message as quota/billing", () => {
    expect(
      isQuotaOrBillingFailure("claude_local", {
        errorCode: "adapter_failed",
        error: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
      }),
    ).toBe(true);
  });

  it("classifies a claude_local low-credit-balance message as quota/billing", () => {
    expect(
      isQuotaOrBillingFailure("claude_local", {
        error: "Your credit balance is too low to access the Anthropic API.",
      }),
    ).toBe(true);
  });

  it("classifies a codex_local insufficient_quota error as quota/billing", () => {
    expect(
      isQuotaOrBillingFailure("codex_local", {
        errorCode: "adapter_failed",
        stderr: "Error: insufficient_quota — you exceeded your current quota, please check your plan and billing.",
      }),
    ).toBe(true);
  });

  it("classifies a codex_local rate_limit_exceeded error as quota/billing", () => {
    expect(
      isQuotaOrBillingFailure("codex_local", { error: "rate_limit_exceeded: too many requests" }),
    ).toBe(true);
  });

  it("classifies an HTTP 429 status on any adapter as quota/billing", () => {
    expect(isQuotaOrBillingFailure("gemini_local", { httpStatus: 429 })).toBe(true);
  });

  it("classifies an HTTP 402 status on any adapter as quota/billing", () => {
    expect(isQuotaOrBillingFailure("cursor", { httpStatus: 402 })).toBe(true);
  });

  it("classifies a scraped 'HTTP 429' mentioned in free-form error text", () => {
    expect(isQuotaOrBillingFailure("droid_local", { error: "request failed with HTTP 429 Too Many Requests" })).toBe(true);
  });

  it("does not classify an unrelated adapter failure as quota/billing", () => {
    expect(
      isQuotaOrBillingFailure("claude_local", {
        errorCode: "adapter_failed",
        error: "workspace git worktree branch mismatch",
      }),
    ).toBe(false);
  });

  it("does not classify a timeout with no matching text as quota/billing", () => {
    expect(isQuotaOrBillingFailure("codex_local", { errorCode: "timeout" })).toBe(false);
  });

  it("returns false for empty exit info", () => {
    expect(isQuotaOrBillingFailure("claude_local", {})).toBe(false);
  });

  it("cross-applies the claude pattern set to any claude-family adapter type", () => {
    expect(
      isQuotaOrBillingFailure("claude_local_alt_account", { error: "usage limit reached" }),
    ).toBe(true);
  });

  it("classifies expired Claude credentials as fallback-eligible", () => {
    expect(
      isFallbackEligibleAdapterFailure("claude_local", {
        errorCode: "configuration_incomplete",
        error: "authentication_error: OAuth token has expired",
      }),
    ).toBe(true);
  });

  it("classifies missing Codex credentials as fallback-eligible", () => {
    expect(
      isFallbackEligibleAdapterFailure("codex_local", {
        errorCode: "configuration_incomplete",
        error: "configuration incomplete: no Codex credentials available",
      }),
    ).toBe(true);
  });

  it("does not make an unrelated configuration error fallback-eligible", () => {
    expect(
      isFallbackEligibleAdapterFailure("claude_local", {
        errorCode: "configuration_incomplete",
        error: "model claude-unknown not found",
      }),
    ).toBe(false);
  });
});
