import type { Config } from "./config.ts";
import { headSource } from "./copy.ts";
import { archivePaths, parseSourceKey, type SourceKey } from "./keys.ts";
import { log } from "./log.ts";
import { copyTargets, runOnce, type RunSummary } from "./run.ts";
import { objectExists, type Bucket } from "./storage.ts";

export const USAGE = `Usage:
  node src/cli.ts run [--dry-run] [--limit N] Copy every original that is not archived yet
                                             --limit N copies at most N files this run (for a test slice)
  node src/cli.ts copy-one <key> [--force]   Copy a single original, e.g. audiomoth/did:plc:.../unassigned/x.wav
                                             Refuses if it is already archived, unless --force`;

export type Command =
  | { name: "run"; dryRun: boolean; limit?: number }
  | { name: "copy-one"; source: SourceKey; force: boolean };

/** What a command needs from the configuration. */
export type CommandConfig = Pick<Config, "indexerUrl" | "pdsHosts" | "minAgeMinutes" | "maxBytesPerSecond">;

/** The command to run, or a message saying what is wrong with the arguments. */
export function parseArgs(argv: string[]): Command | string {
  const [name, ...rest] = argv;
  // `pnpm archive -- --limit 5` may pass the separator through.
  const args = rest.filter((arg) => arg !== "--");
  if (name === "run") return parseRunArgs(args);
  if (name === "copy-one") {
    const unknownFlag = args.find((arg) => arg.startsWith("-") && arg !== "--force");
    if (unknownFlag !== undefined) return `Unknown option "${unknownFlag}" for copy-one.`;
    const keys = args.filter((arg) => !arg.startsWith("-"));
    if (keys.length !== 1) return "copy-one takes exactly one <key>.";
    const source = parseSourceKey(keys[0]!);
    if (!source) return `Not an AudioMoth original key: "${keys[0]}".`;
    return { name, source, force: args.includes("--force") };
  }
  return name === undefined ? "Missing command." : `Unknown command "${name}".`;
}

function parseRunArgs(args: string[]): Command | string {
  const command: Command = { name: "run", dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run") {
      command.dryRun = true;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg === "--limit" ? args[++index] : arg.slice("--limit=".length);
      if (value === undefined || !/^[1-9]\d*$/.test(value)) return `--limit needs a whole number of files, 1 or more (got "${value ?? ""}").`;
      command.limit = Number(value);
    } else {
      return `Unknown argument "${arg}" for run.`;
    }
  }
  return command;
}

function summaryLevel(summary: RunSummary): "info" | "warn" | "error" {
  if (summary.failed > 0) return "error";
  return summary.skippedKeys > 0 || summary.cidMismatches > 0 ? "warn" : "info";
}

/** Copy everything not archived yet. Returns the process exit code. */
export async function runCommand(
  config: CommandConfig,
  source: Bucket,
  archive: Bucket,
  run: { dryRun: boolean; limit?: number },
  signal?: AbortSignal,
): Promise<number> {
  const summary = await runOnce(source, archive, {
    limit: run.limit,
    indexerUrl: config.indexerUrl,
    pdsHosts: config.pdsHosts,
    dryRun: run.dryRun,
    minAgeMs: config.minAgeMinutes * 60_000,
    maxBytesPerSecond: config.maxBytesPerSecond,
    signal,
  });
  log(summaryLevel(summary), "run_complete", { ...summary, interrupted: signal?.aborted ?? false });
  return summary.failed > 0 ? 1 : 0;
}

/** Copy one original, refusing to repeat an archived copy unless `force`. Returns the process exit code. */
export async function copyOneCommand(
  config: CommandConfig,
  source: Bucket,
  archive: Bucket,
  target: SourceKey,
  force: boolean,
  signal?: AbortSignal,
): Promise<number> {
  const etag = await headSource(source, target.key);
  const { manifestKey } = archivePaths(target, etag);
  if (!force && (await objectExists(archive, manifestKey))) {
    console.error(`Already archived: s3://${archive.name}/${manifestKey}\nPass --force to copy it again.`);
    return 1;
  }
  const counts = await copyTargets(source, archive, [{ source: target, etag }], {
    indexerUrl: config.indexerUrl,
    pdsHosts: config.pdsHosts,
    maxBytesPerSecond: config.maxBytesPerSecond,
    signal,
  });
  return counts.copied === 1 ? 0 : 1;
}
