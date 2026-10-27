import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { acquireLock } from "./lock.ts";

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A separate process that takes the lock, prints "held" or "refused", then runs `afterwards`. */
function lockHolder(port: number, afterwards: string): ChildProcess {
  const lockModule = new URL("./lock.ts", import.meta.url).href;
  const script = `
    import { acquireLock } from ${JSON.stringify(lockModule)};
    const release = await acquireLock(${port});
    console.log(release ? "held" : "refused");
    ${afterwards}
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
}

async function firstLine(child: ChildProcess): Promise<string> {
  const [chunk] = await once(child.stdout!, "data");
  return String(chunk).trim();
}

test("a second run is refused while the first holds the lock, and may start once it is released", async () => {
  const port = await freePort();

  const release = await acquireLock(port);
  assert.ok(release);
  assert.equal(await acquireLock(port), null);

  await release();
  const again = await acquireLock(port);
  assert.ok(again, "the lock was not freed by release()");
  await again();
});

test("the lock is freed when its holder is killed outright", async () => {
  const port = await freePort();
  const holder = lockHolder(port, "setInterval(() => {}, 1000); // stay alive until killed");
  try {
    assert.equal(await firstLine(holder), "held");
    assert.equal(await acquireLock(port), null);

    holder.kill("SIGKILL");
    await once(holder, "exit");

    const release = await acquireLock(port);
    assert.ok(release, "a killed run left the lock behind");
    await release();
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a held lock never keeps its process alive", async () => {
  const port = await freePort();
  // Nothing else is pending, and the lock is never released: the process must still exit by itself.
  const holder = lockHolder(port, "");
  const exited = once(holder, "exit");
  const timer = setTimeout(() => holder.kill("SIGKILL"), 5_000);

  const [code] = await exited;
  clearTimeout(timer);

  assert.equal(code, 0, "the process had to be killed because the lock kept it running");
});
