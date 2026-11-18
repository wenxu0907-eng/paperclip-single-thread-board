import { describe, expect, it } from "vitest";

import { contentDispositionHeader } from "../http/content-disposition.js";

describe("contentDispositionHeader", () => {
  it("keeps ASCII filenames verbatim in the fallback", () => {
    const header = contentDispositionHeader("attachment", "report.pdf");
    expect(header).toBe("attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf");
  });

  it("percent-encodes CJK filenames without emitting non-latin1 bytes", () => {
    const header = contentDispositionHeader("attachment", "报告.pdf");
    // ASCII fallback replaces non-ASCII with underscores; filename* carries UTF-8.
    expect(header).toBe("attachment; filename=\"__.pdf\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
    // The header value must be latin1-safe so Node's setHeader never throws ERR_INVALID_CHAR.
    expect(/^[\x00-\xff]*$/.test(header)).toBe(true);
  });

  it("handles emoji filenames", () => {
    const header = contentDispositionHeader("inline", "🎉party.png");
    expect(/^[\x00-\xff]*$/.test(header)).toBe(true);
    expect(header).toContain("filename*=UTF-8''");
  });

  it("percent-encodes the narrow no-break space (U+202F) macOS uses in screenshots", () => {
    const header = contentDispositionHeader("inline", "Screenshot 3 PM.png");
    expect(/^[\x00-\xff]*$/.test(header)).toBe(true);
    expect(header).toContain("%E2%80%AF");
  });

  it("strips quotes and path separators from the ASCII fallback", () => {
    const header = contentDispositionHeader("attachment", "a/b\\c\"d.txt");
    expect(header.startsWith("attachment; filename=\"a_b_c_d.txt\"")).toBe(true);
  });

  it("falls back to the provided name for empty/nullish filenames", () => {
    expect(contentDispositionHeader("inline", null, "asset")).toBe(
      "inline; filename=\"asset\"; filename*=UTF-8''asset",
    );
    expect(contentDispositionHeader("attachment", "   ", "workspace-file")).toBe(
      "attachment; filename=\"workspace-file\"; filename*=UTF-8''workspace-file",
    );
  });

  it("coerces unknown disposition types to attachment", () => {
    expect(contentDispositionHeader("bogus", "x.txt")).toMatch(/^attachment;/);
  });
});
