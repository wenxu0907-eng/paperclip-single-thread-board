import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL, models } from "./index.js";

describe("codex local adapter metadata", () => {
  it("advertises Codex-capable OpenAI models without forcing an account-specific default", () => {
    const modelIds = models.map((model) => model.id);

    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("");
    expect(modelIds.slice(0, 4)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6",
    ]);
    expect(modelIds).not.toContain("gpt-5.3-codex");
  });
});
