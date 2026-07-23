import {
  extractCompanyPrefixFromPath,
  normalizeCompanyPrefix,
  toCompanyRelativePath,
} from "./company-routes";

const GLOBAL_SEGMENTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs"]);

export function isRememberableCompanyPath(path: string): boolean {
  const pathname = path.split("?")[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const [root] = segments;
  if (GLOBAL_SEGMENTS.has(root!)) return false;
  return true;
}

function findCompanyByPrefix<T extends { id: string; issuePrefix: string }>(params: {
  companies: T[];
  companyPrefix: string;
}): T | null {
  const normalizedPrefix = normalizeCompanyPrefix(params.companyPrefix);
  return params.companies.find((company) => normalizeCompanyPrefix(company.issuePrefix) === normalizedPrefix) ?? null;
}

export function getRememberedPathOwnerCompanyId<T extends { id: string; issuePrefix: string }>(params: {
  companies: T[];
  pathname: string;
  fallbackCompanyId: string | null;
}): string | null {
  const routeCompanyPrefix = extractCompanyPrefixFromPath(params.pathname);
  if (!routeCompanyPrefix) {
    return params.fallbackCompanyId;
  }

  return findCompanyByPrefix({
    companies: params.companies,
    companyPrefix: routeCompanyPrefix,
  })?.id ?? null;
}

/**
 * When an unprefixed path targets a specific issue (e.g. `/issues/COM-171`),
 * return the company that owns that issue, matched by the issue identifier's
 * prefix. Returns null when the path is not an issue path or no company matches,
 * so callers can apply their own fallback. Keeps notification "Review issue"
 * deep links (Discord, etc.) on the owning company instead of the last-selected
 * one (COM-171).
 */
export function findCompanyForUnprefixedIssuePath<T extends { id: string; issuePrefix: string }>(params: {
  companies: T[];
  pathname: string;
}): T | null {
  const identifierPrefix = /^\/issues\/([A-Za-z]+)-\d+/.exec(params.pathname)?.[1];
  if (!identifierPrefix) return null;
  return findCompanyByPrefix({ companies: params.companies, companyPrefix: identifierPrefix });
}

const ISSUE_UUID_PATH = /^\/issues\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[/?#])/i;

/**
 * When an unprefixed path targets an issue by its UUID (e.g. `/issues/<uuid>`),
 * the owning company can't be derived from the path — the company prefix lives
 * in the issue's identifier, not its id. Return the UUID so callers can look the
 * issue up and route to its company. The Discord plugin's notification buttons
 * link to `/issues/<uuid>` (the button only carries the entity id), so without
 * this every such link lands on whatever company the viewer last had open
 * (COM-171).
 */
export function extractUnprefixedIssueUuid(pathname: string): string | null {
  return ISSUE_UUID_PATH.exec(pathname)?.[1] ?? null;
}

export function sanitizeRememberedPathForCompany(params: {
  path: string | null | undefined;
  companyPrefix: string;
}): string {
  const relativePath = params.path ? toCompanyRelativePath(params.path) : "/dashboard";
  if (!isRememberableCompanyPath(relativePath)) {
    return "/dashboard";
  }

  const pathname = relativePath.split("?")[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  const [root, entityId] = segments;
  if (root === "issues" && entityId) {
    const identifierMatch = /^([A-Za-z]+)-\d+$/.exec(entityId);
    if (
      identifierMatch &&
      normalizeCompanyPrefix(identifierMatch[1] ?? "") !== normalizeCompanyPrefix(params.companyPrefix)
    ) {
      return "/dashboard";
    }
  }

  return relativePath;
}
