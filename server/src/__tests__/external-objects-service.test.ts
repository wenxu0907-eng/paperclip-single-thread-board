import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  activityLog,
  externalObjectMentions,
  externalObjects,
  issueComments,
  issues,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createExternalObjectDetectorRegistry,
  createExternalObjectResolverRegistry,
  externalObjectService,
  type ExternalObjectResolver,
} from "../services/external-objects.js";
import { canonicalizeExternalObjectUrl } from "@paperclipai/shared/external-objects-server";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  createGitHubExternalObjectProvider,
  detectPrWake,
  summarizeCheckRuns,
} from "../services/github-external-object-provider.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external object tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("external object registries", () => {
  it("lets provider detectors claim urls before the generic fallback", async () => {
    const canonical = canonicalizeExternalObjectUrl("https://github.com/acme/app/pull/42");
    if (!canonical) throw new Error("expected canonical url");
    const registry = createExternalObjectDetectorRegistry([
      {
        key: "github",
        detect: ({ urls }) =>
          urls.map((url) => ({
            canonical: url,
            detectorKey: "github",
            providerKey: "github",
            objectType: "pull_request",
            externalId: "acme/app#42",
            confidence: "exact",
          })),
      },
    ]);

    const detections = await registry.detect({
      companyId: "company-1",
      urls: [canonical],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      providerKey: "github",
      objectType: "pull_request",
      externalId: "acme/app#42",
    });
  });

  it("falls back to generic url objects when no provider detector claims a url", async () => {
    const canonical = canonicalizeExternalObjectUrl("https://example.com/path?token=secret#frag");
    if (!canonical) throw new Error("expected canonical url");
    const registry = createExternalObjectDetectorRegistry([]);

    const detections = await registry.detect({
      companyId: "company-1",
      urls: [canonical],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    });

    expect(detections[0]).toMatchObject({
      providerKey: "url",
      objectType: "link",
      externalId: canonical.canonicalIdentityHash,
      displayTitle: "https://example.com/path",
    });
  });

  it("matches resolvers by provider and optional object type", () => {
    const fallbackResolver: ExternalObjectResolver = {
      providerKey: "github",
      resolve: async () => ({
        ok: true,
        snapshot: { statusCategory: "unknown", statusTone: "neutral" },
      }),
    };
    const pullRequestResolver: ExternalObjectResolver = {
      providerKey: "github",
      objectType: "pull_request",
      resolve: async () => ({
        ok: true,
        snapshot: { statusCategory: "open", statusTone: "info" },
      }),
    };
    const registry = createExternalObjectResolverRegistry([pullRequestResolver, fallbackResolver]);

    expect(registry.find({ providerKey: "github", objectType: "pull_request" })).toBe(pullRequestResolver);
    expect(registry.find({ providerKey: "github", objectType: "issue" })).toBe(fallbackResolver);
    expect(registry.find({ providerKey: "linear", objectType: "issue" })).toBeNull();
  });
});

describe("GitHub external object provider", () => {
  function githubObject(path: string, objectType: "pull_request" | "issue") {
    const canonical = canonicalizeExternalObjectUrl(`https://github.com/acme/app/${path}`);
    if (!canonical) throw new Error("expected canonical url");
    return {
      id: randomUUID(),
      companyId: "company-1",
      providerKey: "github",
      objectType,
      externalId: `acme/app#${path}`,
      sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
      canonicalIdentityHash: canonical.canonicalIdentityHash,
      displayTitle: "acme/app#42",
      statusKey: null,
      statusLabel: null,
      statusCategory: "unknown",
      statusTone: "neutral",
      liveness: "unknown",
      isTerminal: false,
      data: {},
      remoteVersion: null,
      etag: null,
    } as any;
  }

  function response(body: Record<string, unknown>, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"etag-1"', ...(init.headers ?? {}) },
      ...init,
    });
  }

  it("detects GitHub pull request and issue URLs before the generic fallback", async () => {
    const provider = createGitHubExternalObjectProvider({} as any, { tokenProvider: null });
    const pr = canonicalizeExternalObjectUrl("https://github.com/Acme/App/pull/42?token=secret#discussion");
    const issue = canonicalizeExternalObjectUrl("https://github.com/Acme/App/issues/7");
    const other = canonicalizeExternalObjectUrl("https://example.com/Acme/App/pull/42");
    if (!pr || !issue || !other) throw new Error("expected canonical urls");

    const detections = await provider.detector.detect({
      companyId: "company-1",
      urls: [pr, issue, other],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    });

    expect(detections).toEqual([
      expect.objectContaining({
        providerKey: "github",
        objectType: "pull_request",
        externalId: "acme/app#pull/42",
        displayKey: "GitHub Pull Request",
        iconKey: "github",
        displayTitle: "Acme/App#42",
      }),
      expect.objectContaining({
        providerKey: "github",
        objectType: "issue",
        externalId: "acme/app#issues/7",
        displayKey: "GitHub Issue",
        iconKey: "github",
        displayTitle: "Acme/App#7",
      }),
    ]);
    expect(JSON.stringify(detections)).not.toContain("secret");
  });

  it.each([
    [
      "open",
      { state: "open", draft: false, merged: false, title: "Ship it", updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "open", statusLabel: "Open", statusIconKey: "git-pull-request", statusCategory: "open", statusTone: "info", isTerminal: false },
    ],
    [
      "draft",
      { state: "open", draft: true, merged: false, title: "WIP", updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "draft", statusLabel: "Draft", statusIconKey: "clock", statusCategory: "waiting", statusTone: "warning", isTerminal: false },
    ],
    [
      "closed",
      { state: "closed", draft: false, merged: false, title: "Closed PR", updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "closed", statusLabel: "Closed", statusIconKey: "x-circle", statusCategory: "closed", statusTone: "muted", isTerminal: true },
    ],
    [
      "merged",
      { state: "closed", draft: false, merged: true, title: "Merged PR", updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "merged", statusLabel: "Merged", statusIconKey: "git-merge", statusCategory: "succeeded", statusTone: "success", isTerminal: true },
    ],
  ])("resolves a %s pull request snapshot", async (_name, body, expected) => {
    const fetch = vi.fn(async () => response(body));
    const provider = createGitHubExternalObjectProvider({} as any, { fetch, tokenProvider: null });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "pull_request")!;

    const result = await resolver.resolve({
      companyId: "company-1",
      object: githubObject("pull/42", "pull_request"),
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/pulls/42",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      snapshot: expect.objectContaining({
        ...expected,
        displayKey: "GitHub Pull Request",
        iconKey: "github",
        displayTitle: expect.stringContaining(String(body.title)),
        remoteVersion: "2026-04-24T01:02:03Z",
        etag: '"etag-1"',
        data: expect.objectContaining({
          provider: "github",
          owner: "acme",
          repo: "app",
          number: 42,
        }),
      }),
    });
    expect(JSON.stringify(result)).not.toContain("authorization");
  });

  it.each([
    [
      "open",
      { state: "open", title: "Issue", state_reason: null, updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "open", statusLabel: "Open", statusIconKey: "circle-dot", statusCategory: "open", statusTone: "info", isTerminal: false },
    ],
    [
      "closed",
      { state: "closed", title: "Issue", state_reason: "completed", updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "closed_completed", statusLabel: "Closed: completed", statusIconKey: "circle", statusCategory: "closed", statusTone: "muted", isTerminal: true },
    ],
  ])("resolves a %s issue snapshot", async (_name, body, expected) => {
    const fetch = vi.fn(async () => response(body));
    const provider = createGitHubExternalObjectProvider({} as any, { fetch, tokenProvider: null });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "issue")!;

    const result = await resolver.resolve({
      companyId: "company-1",
      object: githubObject("issues/42", "issue"),
    });

    expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/acme/app/issues/42", expect.any(Object));
    expect(result).toEqual({
      ok: true,
      snapshot: expect.objectContaining({
        ...expected,
        displayKey: "GitHub Issue",
        iconKey: "github",
        data: expect.objectContaining({
          provider: "github",
          owner: "acme",
          repo: "app",
          number: 42,
        }),
      }),
    });
  });

  it("uses a configured token without storing it in the resolved snapshot", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer ghp_secret" }));
      return response({ state: "open", draft: false, merged: false, title: "Private PR" });
    });
    const provider = createGitHubExternalObjectProvider({} as any, {
      fetch,
      tokenProvider: async () => "ghp_secret",
    });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "pull_request")!;

    const result = await resolver.resolve({
      companyId: "company-1",
      object: githubObject("pull/42", "pull_request"),
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
  });

  it.each([
    [
      "auth-required",
      new Response("", { status: 401 }),
      { ok: false, liveness: "auth_required", errorCode: "github_auth_required" },
    ],
    [
      "rate-limit",
      new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) },
      }),
      { ok: false, liveness: "unreachable", errorCode: "github_rate_limited" },
    ],
    [
      "not-found",
      new Response("", { status: 404, headers: { etag: '"missing"' } }),
      { ok: true, snapshot: expect.objectContaining({ displayKey: "GitHub Pull Request", iconKey: "github", statusKey: "not_found", statusIconKey: "archive", statusCategory: "archived", statusTone: "muted" }) },
    ],
  ])("maps %s responses to provider-safe results", async (_name, githubResponse, expected) => {
    const provider = createGitHubExternalObjectProvider({} as any, {
      fetch: async () => githubResponse,
      tokenProvider: null,
    });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "pull_request")!;

    const result = await resolver.resolve({
      companyId: "company-1",
      object: githubObject("pull/42", "pull_request"),
    });

    expect(result).toEqual(expect.objectContaining(expected));
    expect(JSON.stringify(result)).not.toContain("http");
  });
});

describe("summarizeCheckRuns (COM-336 Phase 1)", () => {
  it("returns none when there are no check runs", () => {
    expect(summarizeCheckRuns({ total_count: 0, check_runs: [] })).toEqual({ state: "none", total: 0 });
    expect(summarizeCheckRuns(null)).toEqual({ state: "none", total: 0 });
  });

  it("returns success only when every run completed successfully", () => {
    expect(
      summarizeCheckRuns({
        check_runs: [
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "neutral" },
          { status: "completed", conclusion: "skipped" },
        ],
      }),
    ).toEqual({ state: "success", total: 3 });
  });

  it("returns pending when any run is not yet completed and none failed", () => {
    expect(
      summarizeCheckRuns({
        check_runs: [
          { status: "completed", conclusion: "success" },
          { status: "in_progress", conclusion: null },
        ],
      }),
    ).toEqual({ state: "pending", total: 2 });
  });

  it("returns failure when any completed run did not succeed, even if others are still running", () => {
    expect(
      summarizeCheckRuns({
        check_runs: [
          { status: "completed", conclusion: "failure" },
          { status: "in_progress", conclusion: null },
        ],
      }),
    ).toEqual({ state: "failure", total: 2 });
    expect(
      summarizeCheckRuns({ check_runs: [{ status: "completed", conclusion: "timed_out" }] }),
    ).toEqual({ state: "failure", total: 1 });
  });

  it("accepts a bare array of check runs", () => {
    expect(summarizeCheckRuns([{ status: "completed", conclusion: "success" }])).toEqual({ state: "success", total: 1 });
  });
});

describe("detectPrWake (COM-336 Phase 1)", () => {
  it("fires ci_green on a real not-green -> green transition", () => {
    expect(detectPrWake({ checksState: "pending" }, { checksState: "success" })).toBe("ci_green");
    expect(detectPrWake({ checksState: "failure" }, { checksState: "success" })).toBe("ci_green");
    expect(detectPrWake({ checksState: "none" }, { checksState: "success" })).toBe("ci_green");
  });

  it("does not fire ci_green on first capture (unknown prior checks)", () => {
    expect(detectPrWake(null, { checksState: "success" })).toBeNull();
    expect(detectPrWake({}, { checksState: "success" })).toBeNull();
  });

  it("does not fire ci_green when already green", () => {
    expect(detectPrWake({ checksState: "success" }, { checksState: "success" })).toBeNull();
  });

  it("fires pr_mergeable on a known not-mergeable -> mergeable transition", () => {
    expect(detectPrWake({ mergeable: false }, { mergeable: true })).toBe("pr_mergeable");
  });

  it("does not fire pr_mergeable when prior mergeability was unknown (still computing)", () => {
    expect(detectPrWake(null, { mergeable: true })).toBeNull();
    expect(detectPrWake({ mergeable: null }, { mergeable: true })).toBeNull();
  });

  it("never fires for terminal or draft PRs", () => {
    expect(detectPrWake({ checksState: "pending" }, { checksState: "success", merged: true })).toBeNull();
    expect(detectPrWake({ checksState: "pending" }, { checksState: "success", state: "closed" })).toBeNull();
    expect(detectPrWake({ mergeable: false }, { mergeable: true, draft: true })).toBeNull();
  });

  it("prefers ci_green when both transitions happen at once", () => {
    expect(
      detectPrWake({ checksState: "pending", mergeable: false }, { checksState: "success", mergeable: true }),
    ).toBe("ci_green");
  });
});

describe("GitHub PR provider captures mergeable + check rollup (COM-336 Phase 1)", () => {
  function jsonResponse(body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"etag-1"' },
    });
  }

  function githubPrObject() {
    const canonical = canonicalizeExternalObjectUrl("https://github.com/acme/app/pull/42");
    if (!canonical) throw new Error("expected canonical url");
    return {
      id: randomUUID(),
      companyId: "company-1",
      providerKey: "github",
      objectType: "pull_request",
      externalId: "acme/app#pull/42",
      sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
      canonicalIdentityHash: canonical.canonicalIdentityHash,
      displayTitle: "acme/app#42",
      statusKey: null,
      statusLabel: null,
      statusCategory: "unknown",
      statusTone: "neutral",
      liveness: "unknown",
      isTerminal: false,
      data: {},
      remoteVersion: null,
      etag: null,
    } as any;
  }

  it("stores mergeable + checksState from the PR body and a second check-runs fetch", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("/check-runs")) {
        return jsonResponse({ check_runs: [{ status: "completed", conclusion: "success" }] });
      }
      return jsonResponse({
        state: "open",
        draft: false,
        merged: false,
        title: "Ship it",
        mergeable: true,
        mergeable_state: "clean",
        head: { ref: "feature", sha: "abc123" },
        updated_at: "2026-04-24T01:02:03Z",
      });
    });
    const provider = createGitHubExternalObjectProvider({} as any, { fetch, tokenProvider: null });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "pull_request")!;

    const result = await resolver.resolve({ companyId: "company-1", object: githubPrObject() });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/commits/abc123/check-runs",
      expect.any(Object),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshot.data).toEqual(
      expect.objectContaining({ mergeable: true, mergeableState: "clean", checksState: "success", checksTotal: 1 }),
    );
  });

  it("does not fetch check runs when the PR body has no head sha, and resolves without checks", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ state: "open", draft: false, merged: false, title: "No sha", updated_at: "2026-04-24T01:02:03Z" }),
    );
    const provider = createGitHubExternalObjectProvider({} as any, { fetch, tokenProvider: null });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "pull_request")!;

    const result = await resolver.resolve({ companyId: "company-1", object: githubPrObject() });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshot.data).not.toHaveProperty("checksState");
  });

  it("resolves the PR even when the check-runs fetch fails", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("/check-runs")) throw new Error("network down");
      return jsonResponse({
        state: "open",
        draft: false,
        merged: false,
        title: "Ship it",
        mergeable: true,
        head: { ref: "feature", sha: "abc123" },
        updated_at: "2026-04-24T01:02:03Z",
      });
    });
    const provider = createGitHubExternalObjectProvider({} as any, { fetch, tokenProvider: null });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "pull_request")!;

    const result = await resolver.resolve({ companyId: "company-1", object: githubPrObject() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshot.data).toEqual(expect.objectContaining({ mergeable: true }));
    expect(result.snapshot.data).not.toHaveProperty("checksState");
  });
});

describeEmbeddedPostgres("externalObjectService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-objects-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(plugins);
    await db.delete(companies);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssue(companyId = randomUUID()) {
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      boardOnlyOnParents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `PAP-${companyId.replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      title: "External refs",
      description: "Track https://github.com/acme/app/pull/42?token=secret#discussion twice https://github.com/acme/app/pull/42.",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("syncs sanitized, deduped mentions without storing secret-bearing urls", async () => {
    const { companyId, issueId } = await createIssue();
    const svc = externalObjectService(db);

    await svc.syncIssue(issueId);

    const [objectRows, mentionRows] = await Promise.all([
      db.select().from(externalObjects),
      db.select().from(externalObjectMentions),
    ]);
    expect(objectRows).toHaveLength(1);
    expect(objectRows[0]).toMatchObject({
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: "acme/app#pull/42",
      sanitizedCanonicalUrl: "https://github.com/acme/app/pull/42",
      liveness: "unknown",
      statusCategory: "unknown",
    });
    expect(JSON.stringify(objectRows[0])).not.toContain("secret");
    expect(mentionRows).toHaveLength(1);
    expect(mentionRows[0]).toMatchObject({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "description",
      sanitizedDisplayUrl: "https://github.com/acme/app/pull/42",
      matchedTextRedacted: "https://github.com/acme/app/pull/42",
    });
  });

  it("no-ops detection and summaries when external objects are disabled", async () => {
    const { issueId } = await createIssue();
    const svc = externalObjectService(db, { enabled: false });

    await svc.syncIssue(issueId);

    const [objectRows, mentionRows, summary] = await Promise.all([
      db.select().from(externalObjects),
      db.select().from(externalObjectMentions),
      svc.getIssueSummary(issueId),
    ]);
    expect(objectRows).toHaveLength(0);
    expect(mentionRows).toHaveLength(0);
    expect(summary).toMatchObject({
      total: 0,
      byStatusCategory: {},
      byLiveness: {},
      highestSeverity: "neutral",
      objects: [],
    });
  });

  it("preserves last-known status when resolver reports auth and unreachable failures", async () => {
    const { companyId, issueId } = await createIssue();
    const resolver: ExternalObjectResolver = {
      providerKey: "url",
      objectType: "link",
      resolve: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          snapshot: {
            statusCategory: "open",
            statusTone: "info",
            statusKey: "open",
            statusLabel: "Open",
            ttlSeconds: 1,
          },
        })
        .mockResolvedValueOnce({
          ok: false,
          liveness: "auth_required",
          errorCode: "auth_required",
          errorMessage: "token=secret failed for https://github.com/acme/app/pull/42?token=secret",
          retryAfterSeconds: 60,
        })
        .mockResolvedValueOnce({
          ok: false,
          liveness: "unreachable",
          errorCode: "network",
          errorMessage: "GET https://github.com/acme/app/pull/42 failed",
          retryAfterSeconds: 60,
        }),
    };
    const svc = externalObjectService(db, { resolvers: [resolver], github: false });
    await svc.syncIssue(issueId);
    const object = await db.select().from(externalObjects).then((rows) => rows[0]!);

    await svc.refreshObject(object.id, { companyId, force: true });
    await svc.refreshObject(object.id, { companyId, force: true });

    const authFailure = await db.select().from(externalObjects).then((rows) => rows[0]!);
    expect(authFailure.lastErrorMessage).toContain("token=[redacted]");
    expect(authFailure.lastErrorMessage).not.toContain("secret");

    await svc.refreshObject(object.id, { companyId, force: true });

    const updated = await db.select().from(externalObjects).then((rows) => rows[0]!);
    expect(updated.statusCategory).toBe("open");
    expect(updated.statusLabel).toBe("Open");
    expect(updated.liveness).toBe("unreachable");
    expect(updated.lastErrorMessage).toContain("[redacted-url]");
    expect(updated.lastErrorMessage).not.toContain("secret");
  });

  it("schedules newly detected objects for automatic refresh", async () => {
    const { companyId, issueId } = await createIssue();
    const resolve = vi.fn(async () => ({
      ok: true as const,
      snapshot: {
        statusCategory: "open" as const,
        statusTone: "info" as const,
        statusKey: "open",
        statusLabel: "Open",
        ttlSeconds: 300,
      },
    }));
    const resolver: ExternalObjectResolver = {
      providerKey: "url",
      objectType: "link",
      resolve,
    };
    const svc = externalObjectService(db, { resolvers: [resolver], github: false });
    await svc.syncIssue(issueId);
    const object = await db.select().from(externalObjects).then((rows) => rows[0]!);

    expect(object.nextRefreshAt).toBeInstanceOf(Date);

    const refreshed = await svc.refreshDueObjects(companyId, 50, new Date(Date.now() + 1_000));

    expect(refreshed).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("removes comment mentions when a synced comment is hard-deleted", async () => {
    const { companyId, issueId } = await createIssue();
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "local-board",
      body: "See https://github.com/acme/app/issues/88",
    });
    const svc = externalObjectService(db, { github: false });

    await svc.syncComment(commentId);
    expect(await db.select().from(externalObjectMentions)).toHaveLength(1);

    await db.delete(issueComments).where(eq(issueComments.id, commentId));
    await svc.syncComment(commentId);

    expect(await db.select().from(externalObjectMentions)).toHaveLength(0);
  });

  it("skips terminal objects when refreshing due objects", async () => {
    const { companyId, issueId } = await createIssue();
    const resolve = vi.fn(async () => ({
      ok: true as const,
      snapshot: {
        statusCategory: "closed" as const,
        statusTone: "muted" as const,
        statusKey: "closed",
        statusLabel: "Closed",
        isTerminal: true,
        ttlSeconds: 1,
      },
    }));
    const resolver: ExternalObjectResolver = {
      providerKey: "url",
      objectType: "link",
      resolve,
    };
    const svc = externalObjectService(db, { resolvers: [resolver], github: false });
    await svc.syncIssue(issueId);
    const object = await db.select().from(externalObjects).then((rows) => rows[0]!);

    await svc.refreshObject(object.id, { companyId, force: true });
    await db
      .update(externalObjects)
      .set({ nextRefreshAt: new Date(0) })
      .where(eq(externalObjects.id, object.id));

    const refreshed = await svc.refreshDueObjects(companyId);

    expect(refreshed).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("refreshes due objects across all companies in one sweep (Phase 2)", async () => {
    const a = await createIssue();
    const b = await createIssue();
    const resolve = vi.fn(async () => ({
      ok: true as const,
      snapshot: {
        statusCategory: "open" as const,
        statusTone: "info" as const,
        statusKey: "open",
        statusLabel: "Open",
        ttlSeconds: 300,
      },
    }));
    const resolver: ExternalObjectResolver = {
      providerKey: "url",
      objectType: "link",
      resolve,
    };
    const svc = externalObjectService(db, { resolvers: [resolver], github: false });
    await svc.syncIssue(a.issueId);
    await svc.syncIssue(b.issueId);
    expect(resolve).not.toHaveBeenCalled();

    const refreshed = await svc.refreshDueObjectsAcrossCompanies(100, new Date(Date.now() + 1_000));

    // One object per company refreshed, without the caller supplying any companyId.
    expect(refreshed).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(2);
    const refreshedCompanies = new Set(
      (await db.select().from(externalObjects)).map((row) => row.companyId),
    );
    expect(refreshedCompanies).toEqual(new Set([a.companyId, b.companyId]));
  });

  it("no-ops the cross-company sweep when external objects are disabled", async () => {
    const { issueId } = await createIssue();
    const resolve = vi.fn(async () => ({
      ok: true as const,
      snapshot: {
        statusCategory: "open" as const,
        statusTone: "info" as const,
        statusKey: "open",
        statusLabel: "Open",
        ttlSeconds: 300,
      },
    }));
    const resolver: ExternalObjectResolver = { providerKey: "url", objectType: "link", resolve };
    const svc = externalObjectService(db, { resolvers: [resolver], github: false, enabled: false });
    await svc.syncIssue(issueId);

    const refreshed = await svc.refreshDueObjectsAcrossCompanies(100, new Date(Date.now() + 1_000));

    expect(refreshed).toEqual([]);
  });

  it("keeps external object identities company-scoped for duplicate urls", async () => {
    const first = await createIssue();
    const second = await createIssue();
    const svc = externalObjectService(db);

    await svc.syncIssue(first.issueId);
    await svc.syncIssue(second.issueId);

    const objectRows = await db.select().from(externalObjects);
    expect(objectRows).toHaveLength(2);
    expect(new Set(objectRows.map((row) => row.companyId))).toEqual(new Set([first.companyId, second.companyId]));
    expect(new Set(objectRows.map((row) => row.canonicalIdentityHash)).size).toBe(1);
  });

  it("uses a mock plugin provider to detect and resolve non-GitHub objects", async () => {
    const { companyId, issueId } = await createIssue();
    await db
      .update(issues)
      .set({
        description: "Track https://mock.example/tickets/123?secret=drop",
      })
      .where(eq(issues.id, issueId));

    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.mock-object-provider",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Mock Object Provider",
      description: "Detects mock tracker tickets",
      author: "Paperclip",
      categories: ["connector"],
      capabilities: ["external.objects.detect", "external.objects.read"],
      entrypoints: { worker: "dist/worker.js" },
      objectReferences: [
        {
          providerKey: "mocktracker",
          displayName: "Mock Tracker",
          objectTypes: ["ticket"],
          urlPatterns: ["https://mock.example/tickets/:id"],
        },
      ],
    };
    const [plugin] = await db.insert(plugins).values({
      pluginKey: manifest.id,
      packageName: "@paperclip/mock-object-provider",
      version: manifest.version,
      apiVersion: 1,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "ready",
      installOrder: 1,
    }).returning();

    const workerManager = {
      call: vi.fn(async (pluginId: string, method: string, params: any) => {
        expect(pluginId).toBe(plugin!.id);
        if (method === "detectExternalObjects") {
          return {
            detections: params.urls.map((url: any) => ({
              urlIdentityHash: url.canonicalIdentityHash,
              providerKey: "mocktracker",
              objectType: "ticket",
              externalId: "MOCK-123",
              displayKey: "Mock Ticket",
              iconKey: "circle-dot",
              displayTitle: "Mock ticket 123",
              confidence: "exact",
            })),
          };
        }
        if (method === "resolveExternalObject") {
          return {
            ok: true,
            snapshot: {
              displayKey: "Mock Ticket",
              iconKey: "circle-dot",
              displayTitle: `Resolved ${params.externalId}`,
              statusKey: "ready",
              statusLabel: "Ready",
              statusIconKey: "check-circle",
              statusCategory: "succeeded",
              statusTone: "success",
              ttlSeconds: 300,
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      }),
    } as unknown as PluginWorkerManager;

    const svc = externalObjectService(db, { pluginWorkerManager: workerManager });
    await svc.syncIssue(issueId);

    const object = await db.select().from(externalObjects).then((rows) => rows[0]!);
    expect(object).toMatchObject({
      companyId,
      providerKey: "mocktracker",
      objectType: "ticket",
      externalId: "MOCK-123",
      displayKey: "Mock Ticket",
      iconKey: "circle-dot",
      pluginId: plugin!.id,
      sanitizedCanonicalUrl: "https://mock.example/tickets/123",
    });
    expect(JSON.stringify(object)).not.toContain("secret");

    const refreshed = await svc.refreshObject(object.id, { companyId, force: true });
    expect(refreshed.object).toMatchObject({
      displayKey: "Mock Ticket",
      iconKey: "circle-dot",
      displayTitle: "Resolved MOCK-123",
      statusIconKey: "check-circle",
      statusCategory: "succeeded",
      statusTone: "success",
      liveness: "fresh",
    });
  });
});
