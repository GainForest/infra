import { connect, createServer } from "node:net";
import { log } from "./log.ts";

export type ReleaseLock = () => Promise<void>;

/** What the lock holder says to anyone who connects; anything else on the port is a different program. */
const BANNER = "gainforest-audio-archive\n";
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Hold a loopback TCP port as a mutex. The kernel owns the lock, so it is freed
 * when this process exits however it exits (even SIGKILL). A pid lockfile
 * cannot offer that: a stale file needs guessing whether its pid is still ours.
 *
 * Resolves to a function that releases the lock, or null when another archive
 * run holds the port. Rejects when some other program is using the port, so a
 * port clash fails loudly every hour instead of looking like a busy run. The
 * listener is unref'd, so it never keeps the process alive on its own.
 */
export function acquireLock(port: number): Promise<ReleaseLock | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end(BANNER));
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") return reject(error);
      heldByArchive(port).then(
        (ours) =>
          ours
            ? resolve(null)
            : reject(new Error(`Port ${port} is in use by another program, not an archive run. Set AUDIO_ARCHIVE_LOCK_PORT to a free port.`)),
        reject,
      );
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.unref();
      // A listening socket holds the lock whether or not it can accept; an
      // accept failure is worth a log line, not a crash.
      server.removeAllListeners("error");
      server.on("error", (error) => log("warn", "lock_listener_error", { error: String(error) }));
      resolve(() => new Promise((released) => server.close(() => released())));
    });
  });
}

/** Whether the program on `port` answers with the archive's banner. */
function heldByArchive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let received = "";
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (ours: boolean) => {
      socket.destroy();
      resolve(ours);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.on("data", (chunk) => {
      received += String(chunk);
      if (received.length >= BANNER.length) finish(received.startsWith(BANNER));
    });
    socket.on("end", () => finish(received === BANNER));
    socket.on("error", () => finish(false));
  });
}
