// Starts the GUI server on loopback and returns its link. Shared by the command line
// (server.mjs) and the desktop app, so both get the same guards.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createApp } from "./app.mjs";
import { createCli } from "./cli.mjs";
import { createMonitor } from "./monitor.mjs";

export const HOST = "127.0.0.1";

/**
 * @param {{port?: number, cli?: ReturnType<typeof createCli>, themesDir?: string, pollMs?: number, idleMs?: number}} [options]
 * @returns {Promise<{url: string, origin: string, port: number, close: () => Promise<void>}>}
 */
export function startGui({ port = 0, cli = createCli(), themesDir, pollMs, idleMs } = {}) {
  const key = randomBytes(24).toString("hex"); // goes into the link, becomes a cookie
  const token = randomBytes(24).toString("hex"); // embedded in the page, required on every POST
  let boundPort = port;
  const app = createApp({ cli, monitor: createMonitor({ cli }), key, token, port: () => boundPort, themesDir, pollMs, idleMs });
  const server = createServer(app.handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      boundPort = server.address().port;
      const origin = `http://${HOST}:${boundPort}`;
      resolve({
        url: `${origin}/?key=${key}`,
        origin,
        port: boundPort,
        close: () =>
          new Promise((done) => {
            app.close();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
