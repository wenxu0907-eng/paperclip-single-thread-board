import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSecretService = vi.hoisted(() => ({
  resolveSecretValue: vi.fn(),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

import {
  createPluginSecretsHandler,
  PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
} from "../services/plugin-secrets-handler.js";

function createBindingDb(rows: Array<Record<string, unknown>>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(rows)),
      })),
    })),
  };
}

describe("createPluginSecretsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed for plugin secret resolution without company scope", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "77777777-7777-4777-8777-777777777777" }),
    ).rejects.toThrow(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
  });

  it("still rejects malformed secret refs before the feature-disable guard", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });

  it("resolves a secret ref through the bound company-scoped plugin config", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const companyId = "22222222-2222-4222-8222-222222222222";
    const secretRef = "77777777-7777-4777-8777-777777777777";
    mockSecretService.resolveSecretValue.mockResolvedValue("discord-token");
    const handler = createPluginSecretsHandler({
      db: createBindingDb([{ configPath: "discordBotTokenRef" }]) as never,
      pluginId,
    });

    await expect(
      handler.resolve({ secretRef, companyId }),
    ).resolves.toBe("discord-token");

    expect(mockSecretService.resolveSecretValue).toHaveBeenCalledWith(
      companyId,
      secretRef,
      "latest",
      {
        consumerType: "plugin",
        consumerId: pluginId,
        configPath: "discordBotTokenRef",
        actorType: "plugin",
        actorId: pluginId,
        pluginId,
      },
    );
  });

  it("rejects secret refs that are not bound to the plugin config", async () => {
    const handler = createPluginSecretsHandler({
      db: createBindingDb([]) as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({
        secretRef: "77777777-7777-4777-8777-777777777777",
        companyId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow(/not bound/i);
    expect(mockSecretService.resolveSecretValue).not.toHaveBeenCalled();
  });
});
