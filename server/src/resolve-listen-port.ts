import net from "node:net";

export interface ResolveListenPortOptions {
  host: string;
  allowFallback: boolean;
  retries?: number;
  retryDelayMs?: number;
  probe?: (port: number, host: string) => Promise<boolean>;
  detect?: (port: number) => Promise<number>;
  delay?: (ms: number) => Promise<void>;
  log?: { warn: (msg: string) => void; info: (msg: string) => void };
}

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const probePortBindable = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(err);
    });
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });

export async function resolveListenPort(
  requestedPort: number,
  options: ResolveListenPortOptions,
): Promise<number> {
  const {
    host,
    allowFallback,
    retries = 20,
    retryDelayMs = 500,
    probe = probePortBindable,
    detect,
    delay = defaultDelay,
    log,
  } = options;

  if (allowFallback || requestedPort === 0) {
    if (!detect) {
      throw new Error("resolveListenPort: fallback requested but no detect() provided");
    }
    return detect(requestedPort);
  }

  const attempts = Math.max(1, retries);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await probe(requestedPort, host)) {
      if (attempt > 1) {
        log?.info(
          `Port ${requestedPort} became available after ${attempt} attempt(s); binding requested port`,
        );
      }
      return requestedPort;
    }
    if (attempt < attempts) {
      if (attempt === 1) {
        log?.warn(
          `Requested port ${requestedPort} is busy; retrying (up to ${attempts} attempts, ${retryDelayMs}ms apart) instead of drifting to another port`,
        );
      }
      await delay(retryDelayMs);
    }
  }

  throw new Error(
    `Requested port ${requestedPort} is still in use after ${attempts} attempts (~${Math.round(
      (attempts * retryDelayMs) / 1000,
    )}s). Refusing to drift to a different port because the external entrypoint is pinned to ${requestedPort}. ` +
      "Free the port and let the service restart, or set PAPERCLIP_ALLOW_PORT_FALLBACK=1 to permit binding the next free port.",
  );
}
