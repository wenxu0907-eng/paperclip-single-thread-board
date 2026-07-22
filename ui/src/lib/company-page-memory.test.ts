import { describe, expect, it } from "vitest";
import { findCompanyForUnprefixedIssuePath } from "./company-page-memory";

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
});
