import { describe, expect, it } from "vitest";
import {
  extractUnprefixedIssueUuid,
  findCompanyForUnprefixedIssuePath,
} from "./company-page-memory";

const companies = [
  { id: "luchi", issuePrefix: "LUCHI" },
  { id: "com-owner", issuePrefix: "COM" },
];

describe("findCompanyForUnprefixedIssuePath", () => {
  it("resolves the owning company from an unprefixed issue path by identifier prefix", () => {
    expect(
      findCompanyForUnprefixedIssuePath({ companies, pathname: "/issues/COM-171" }),
    ).toEqual({ id: "com-owner", issuePrefix: "COM" });
  });

  it("matches the prefix case-insensitively", () => {
    expect(
      findCompanyForUnprefixedIssuePath({ companies, pathname: "/issues/com-171" }),
    ).toEqual({ id: "com-owner", issuePrefix: "COM" });
  });

  it("returns null for non-issue paths so callers apply their own fallback", () => {
    expect(
      findCompanyForUnprefixedIssuePath({ companies, pathname: "/agents/all" }),
    ).toBeNull();
  });

  it("returns null when no company owns the issue prefix", () => {
    expect(
      findCompanyForUnprefixedIssuePath({ companies, pathname: "/issues/ZZZ-9" }),
    ).toBeNull();
  });

  it("ignores trailing segments and hashes on the issue path", () => {
    expect(
      findCompanyForUnprefixedIssuePath({
        companies,
        pathname: "/issues/COM-171/subtasks",
      }),
    ).toEqual({ id: "com-owner", issuePrefix: "COM" });
  });

  it("does not match UUID deep links (handled via issue lookup instead)", () => {
    expect(
      findCompanyForUnprefixedIssuePath({
        companies,
        pathname: "/issues/43f48d75-d669-42b6-bfb6-70e2b61be8ac",
      }),
    ).toBeNull();
  });
});

describe("extractUnprefixedIssueUuid", () => {
  const uuid = "43f48d75-d669-42b6-bfb6-70e2b61be8ac";

  it("extracts the UUID from a Discord-style `/issues/<uuid>` deep link", () => {
    expect(extractUnprefixedIssueUuid(`/issues/${uuid}`)).toBe(uuid);
  });

  it("matches with a trailing slash, query, or hash", () => {
    expect(extractUnprefixedIssueUuid(`/issues/${uuid}/`)).toBe(uuid);
    expect(extractUnprefixedIssueUuid(`/issues/${uuid}?foo=1`)).toBe(uuid);
    expect(extractUnprefixedIssueUuid(`/issues/${uuid}#comment-1`)).toBe(uuid);
  });

  it("returns null for identifier deep links (those resolve by prefix)", () => {
    expect(extractUnprefixedIssueUuid("/issues/COM-171")).toBeNull();
  });

  it("returns null for non-issue and list paths", () => {
    expect(extractUnprefixedIssueUuid("/issues")).toBeNull();
    expect(extractUnprefixedIssueUuid(`/agents/${uuid}`)).toBeNull();
  });
});
