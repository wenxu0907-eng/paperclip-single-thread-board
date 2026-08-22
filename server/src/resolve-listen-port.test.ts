import { describe, expect, it, vi } from "vitest";
import { resolveListenPort } from "./resolve-listen-port.js";

const noDelay = () => Promise.resolve();

describe("resolveListenPort", () => {
  it("binds the requested port immediately when it is free in strict mode", async () => {
    const probe = vi.fn(async () => true);
    const detect = vi.fn(async () => 9999);

    const port = await resolveListenPort(3100, {
      host: "127.0.0.1",
      allowFallback: false,
      probe,
      detect,
      delay: noDelay,
    });

    expect(port).toBe(3100);
    expect(detect).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retries the requested port and binds it once it frees up", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const port = await resolveListenPort(3100, {
      host: "127.0.0.1",
      allowFallback: false,
      retries: 5,
      probe,
      delay: noDelay,
    });

    expect(port).toBe(3100);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("fails loudly instead of drifting when the port stays busy in strict mode", async () => {
    const probe = vi.fn(async () => false);
    const detect = vi.fn(async () => 3101);

    await expect(
      resolveListenPort(3100, {
        host: "127.0.0.1",
        allowFallback: false,
        retries: 3,
        probe,
        detect,
        delay: noDelay,
      }),
    ).rejects.toThrow(/still in use after 3 attempts/);

    expect(detect).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("drifts to the next free port only when fallback is explicitly allowed", async () => {
    const probe = vi.fn(async () => false);
    const detect = vi.fn(async () => 3101);

    const port = await resolveListenPort(3100, {
      host: "127.0.0.1",
      allowFallback: true,
      probe,
      detect,
      delay: noDelay,
    });

    expect(port).toBe(3101);
    expect(detect).toHaveBeenCalledWith(3100);
    expect(probe).not.toHaveBeenCalled();
  });

  it("treats an ephemeral port as a fallback request", async () => {
    const detect = vi.fn(async () => 54321);

    const port = await resolveListenPort(0, {
      host: "127.0.0.1",
      allowFallback: false,
      detect,
      delay: noDelay,
    });

    expect(port).toBe(54321);
    expect(detect).toHaveBeenCalledWith(0);
  });
});
