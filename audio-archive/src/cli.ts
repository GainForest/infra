import { constants as osConstants } from "node:os";
import { copyOneCommand, parseArgs, runCommand, USAGE } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { errorFields } from "./errors.ts";
import { acquireLock } from "./lock.ts";
import { log } from "./log.ts";
import { openBucket } from "./storage.ts";

async function main(argv: string[], signal: AbortSignal): Promise<number> {
  const command = parseArgs(argv);
  if (typeof command === "string") {
    console.error(`${command}\n\n${USAGE}`);
    return 2;
  }
  const config = loadConfig();
  const source = openBucket(config.source);
  const archive = openBucket(config.archive);

  // A dry run only reads, so it has nothing to protect and must not make a real run wait.
  const dryRun = command.name === "run" && command.dryRun;
  const release = dryRun ? async () => {} : await acquireLock(config.lockPort);
  if (!release) {
    log("warn", "already_running", { lockPort: config.lockPort });
    return 0;
  }
  try {
    return command.name === "run"
      ? await runCommand(config, source, archive, command, signal)
      : await copyOneCommand(config, source, archive, command.source, command.force, signal);
  } finally {
    await release();
  }
}

// SIGTERM is what launchd sends on stop. Aborting lets an in-flight multipart
// upload be cancelled before the process exits instead of being left to bill.
// Handlers are one-shot: a second signal falls back to the default and quits at once.
const shutdown = new AbortController();
let interruptedBy: NodeJS.Signals | undefined;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.once(name, () => {
    interruptedBy = name;
    log("warn", "signal_received", { signal: name, note: "Aborting the transfer in progress; send the signal again to quit immediately." });
    shutdown.abort();
  });
}

// Set exitCode rather than calling process.exit(), which would cut off the
// abort request of a failed upload that is still on its way to S3.
const exitCodeFor = (code: number) => (interruptedBy ? 128 + osConstants.signals[interruptedBy] : code);
main(process.argv.slice(2), shutdown.signal).then(
  (code) => {
    process.exitCode = exitCodeFor(code);
  },
  (error) => {
    log(interruptedBy ? "warn" : "error", interruptedBy ? "run_interrupted" : "fatal", errorFields(error));
    process.exitCode = exitCodeFor(1);
  },
);
