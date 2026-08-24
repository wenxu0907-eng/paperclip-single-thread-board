import type { ProviderQuotaResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * Shape of a failed run's exit info, as observed by the fallback-chain engine
 * (COM-413). Deliberately loose/partial: callers pass whatever subset of the
 * run record they have (heartbeat run row, adapter execute() result, etc).
 * `httpStatus` is best-effort, scraped from stderr/error text when adapters
 * surface a raw HTTP status from their provider's API.
 */
export interface AdapterRunExitInfo {
  exitCode?: number | null;
  errorCode?: string | null;
  error?: string | null;
  stderr?: string | null;
  stdout?: string | null;
  httpStatus?: number | null;
}

/** Known HTTP statuses that always mean quota/billing regardless of adapter family. */
const QUOTA_OR_BILLING_HTTP_STATUSES = new Set([402, 429]);

/**
 * Per-adapter-family text signatures for quota, rate-limit, and billing
 * failures. Matched against the combined error/stderr/stdout text of a failed
 * run. Every entry here is a *known, reactive* signature seen from a real
 * failed run — this module never predicts or polls for quota state (see
 * `fetchAllQuotaWindows` above for the proactive/predictive path, which is
 * intentionally separate).
 */
const ADAPTER_FAMILY_QUOTA_BILLING_PATTERNS: Record<string, RegExp> = {
  // Anthropic (claude_local and any claude-family adapter, e.g. a second
  // claude_local leg on an alternate account, or a Claude-CLI-compatible
  // credential such as a Kimi K3 coding-plan key routed through claude_local).
  claude: /(?:you(?:'|’)ve hit your (?:monthly )?spend limit|you(?:'|’)ve hit your usage limit|usage limit(?: reached| exceeded)?|rate[_ ]limit(?:_error)?|rate limited|credit balance is too low|insufficient credits?|billing (?:issue|error|hard limit)|quota (?:limit )?exceeded|429 too many requests|purchase additional credits)/i,
  // OpenAI / Codex.
  codex: /(?:insufficient_quota|rate_limit_exceeded|you exceeded your current quota|billing (?:hard limit|issue)|429 too many requests|please check your plan and billing|exceeded your current quota)/i,
  // Generic fallback for adapter families without a bespoke pattern above.
  generic: /(?:quota exceeded|rate limit|429 too many requests|payment required|billing (?:issue|error)|insufficient (?:credits?|balance)|usage limit)/i,
};

const CREDENTIAL_EXHAUSTION_PATTERNS: Record<string, RegExp> = {
  claude: /(?:authentication[_ ]error|invalid (?:api )?key|invalid bearer token|oauth token (?:has )?expired|token expired|subscription (?:has )?expired|account .*?(?:disabled|suspended)|no (?:[a-z]+ )?(?:api )?(?:key|credentials?)|credentials? (?:are |is )?missing|credit balance is too low|billing (?:issue|error)|(?:monthly )?spend limit|usage limit)/i,
  codex: /(?:authentication[_ ]error|invalid (?:api )?key|api key .*?(?:expired|invalid)|oauth token (?:has )?expired|token expired|subscription (?:has )?expired|account .*?(?:disabled|suspended)|no (?:[a-z]+ )?(?:api )?(?:key|credentials?)|credentials? (?:are |is )?missing|insufficient_quota|billing (?:hard limit|issue))/i,
  generic: /(?:authentication[_ ]error|invalid (?:api )?key|oauth token (?:has )?expired|token expired|subscription (?:has )?expired|account .*?(?:disabled|suspended)|no (?:[a-z]+ )?(?:api )?(?:key|credentials?)|credentials? (?:are |is )?missing)/i,
};

function adapterFamilyForQuotaPattern(adapterType: string): keyof typeof ADAPTER_FAMILY_QUOTA_BILLING_PATTERNS {
  const normalized = adapterType.toLowerCase();
  if (normalized.startsWith("claude")) return "claude";
  if (normalized.startsWith("codex")) return "codex";
  return "generic";
}

function combinedExitInfoText(exitInfo: AdapterRunExitInfo): string {
  return [exitInfo.errorCode ?? "", exitInfo.error ?? "", exitInfo.stderr ?? "", exitInfo.stdout ?? ""].join("\n");
}

/**
 * Reactive-only classifier: true when a *failed run's* exit info (exit code,
 * stderr/stdout, HTTP status) matches a known quota/billing/rate-limit
 * signature for the given adapter type. Never fires from proactive quota
 * polling/prediction (see `fetchAllQuotaWindows`) — only from an actual
 * failed run's recorded exit info. Used by the fallback-chain engine
 * (COM-413) to decide whether a run failure should trigger an adapter/
 * credential switch instead of an in-place retry.
 */
export function isQuotaOrBillingFailure(adapterType: string, exitInfo: AdapterRunExitInfo): boolean {
  if (!exitInfo) return false;
  if (typeof exitInfo.httpStatus === "number" && QUOTA_OR_BILLING_HTTP_STATUSES.has(exitInfo.httpStatus)) {
    return true;
  }
  const text = combinedExitInfoText(exitInfo);
  if (!text.trim()) return false;
  const familyPattern = ADAPTER_FAMILY_QUOTA_BILLING_PATTERNS[adapterFamilyForQuotaPattern(adapterType)]!;
  if (familyPattern.test(text)) return true;
  // A raw "HTTP 429"/"HTTP 402" (or "status: 429") mentioned in free-form
  // error text also counts, even for adapter families without a bespoke
  // pattern above.
  const scrapedStatusMatch = text.match(/\b(?:http\s*)?(?:status(?:\s*code)?\s*[:=]?\s*)?(402|429)\b/i);
  if (scrapedStatusMatch) return true;
  return false;
}

export function isFallbackEligibleAdapterFailure(adapterType: string, exitInfo: AdapterRunExitInfo): boolean {
  if (isQuotaOrBillingFailure(adapterType, exitInfo)) return true;
  const text = combinedExitInfoText(exitInfo);
  if (!text.trim()) return false;
  return CREDENTIAL_EXHAUSTION_PATTERNS[adapterFamilyForQuotaPattern(adapterType)]!.test(text);
}

function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 */
export async function fetchAllQuotaWindows(): Promise<ProviderQuotaResult[]> {
  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const settled = await Promise.allSettled(
    adapters.map((adapter) => withQuotaTimeout(adapter.type, adapter.getQuotaWindows!())),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
