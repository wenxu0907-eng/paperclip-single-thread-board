export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;
/**
 * Maximum characters for the `resultSummary` carried on run-lifecycle plugin
 * events. Chat notification plugins (e.g. the Discord plugin) render only the
 * leading slice of this value inside an embed field, so when the full summary
 * is longer we replace it with a short preview ending in a "view full summary"
 * link that fits entirely within this budget.
 */
export const HEARTBEAT_RUN_EVENT_SUMMARY_MAX_CHARS = 500;

function truncateSummaryText(value: unknown, maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A base URL is usable for a clickable deep link if it is an absolute http(s)
 * URL. Localhost is allowed: chat clients (e.g. Discord) render localhost masked
 * links fine — they're just only reachable from the host running Paperclip,
 * which is the common single-machine setup.
 */
export function isLinkableBaseUrl(baseUrl: string | undefined | null): baseUrl is string {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Absolute deep link to an issue's detail page, mirroring `issueMarkdownLink`. */
export function buildIssueDeepLink(baseUrl: string, issueIdentifier: string): string {
  const prefix = issueIdentifier.split("-")[0] || "PAP";
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/${prefix}/issues/${encodeURIComponent(issueIdentifier)}`;
}

/**
 * Build the `resultSummary` carried on run-lifecycle plugin events. When the
 * full summary exceeds the budget that chat plugins render and we can build a
 * deep link, return a short preview ending in a "view full summary" link that
 * fits entirely within `HEARTBEAT_RUN_EVENT_SUMMARY_MAX_CHARS` (so the link
 * survives the plugin's leading slice). Otherwise return the full summary
 * unchanged.
 */
export function buildEventResultSummary(
  fullSummary: string | null,
  issueIdentifier: string | null,
  baseUrl: string | undefined,
): string | null {
  if (!fullSummary) return null;
  if (
    fullSummary.length <= HEARTBEAT_RUN_EVENT_SUMMARY_MAX_CHARS ||
    !issueIdentifier ||
    !isLinkableBaseUrl(baseUrl)
  ) {
    return fullSummary;
  }
  const linkMarkdown = `[View full summary](${buildIssueDeepLink(baseUrl, issueIdentifier)})`;
  const joiner = "…\n\n";
  const previewBudget =
    HEARTBEAT_RUN_EVENT_SUMMARY_MAX_CHARS - linkMarkdown.length - joiner.length;
  if (previewBudget <= 0) {
    // The link alone does not fit the budget; leave the full text for the
    // consumer to truncate rather than emitting a broken link.
    return fullSummary;
  }
  return `${fullSummary.slice(0, previewBudget).trimEnd()}${joiner}${linkMarkdown}`;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  return (
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message)
    ?? null
  );
}
