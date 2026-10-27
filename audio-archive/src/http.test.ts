import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchLimited } from "./http.ts";

// These talk to a throwaway server on 127.0.0.1 with the real fetch: what is
// being checked (redirects refused, bodies cut off, deadlines) is behaviour of
// the real client that a stubbed fetch cannot show.
let server: http.Server;
let base: string;
let bigClosed: Promise<void>;

before(async () => {
  let markClosed = () => {};
  bigClosed = new Promise<void>((resolve) => (markClosed = resolve));
  server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/elsewhere" }).end();
    } else if (req.url === "/endless") {
      res.writeHead(200);
      res.on("close", markClosed);
      const write = () => {
        if (!res.destroyed) res.write(Buffer.alloc(32 * 1024), () => setImmediate(write));
      };
      write();
    } else if (req.url === "/announces-too-much") {
      res.writeHead(200, { "content-length": String(50 * 1024 * 1024) });
      res.write("only the start");
    } else if (req.url === "/stalls") {
      res.writeHead(200);
      res.write("only the start");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test("returns the status and body of a normal answer", async () => {
  assert.deepEqual(await fetchLimited(`${base}/ok`, { maxBytes: 1024, timeoutMs: 5_000 }), { status: 200, body: '{"ok":true}' });
});

test("refuses to follow a redirect", async () => {
  await assert.rejects(fetchLimited(`${base}/redirect`, { maxBytes: 1024, timeoutMs: 5_000 }), /Request to 127\.0\.0\.1:\d+ failed: .*redirect/);
});

test("stops reading, and drops the connection, once a body passes the cap", async () => {
  await assert.rejects(fetchLimited(`${base}/endless`, { maxBytes: 100_000, timeoutMs: 5_000 }), /larger than the 100000 byte limit/);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server was still being read from")), 2_000);
    void bigClosed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
});

test("rejects a response that announces more than the cap without waiting for the body", async () => {
  await assert.rejects(fetchLimited(`${base}/announces-too-much`, { maxBytes: 1024, timeoutMs: 5_000 }), /larger than the 1024 byte limit/);
});

test("gives up on a body that stalls once the deadline passes", async () => {
  await assert.rejects(fetchLimited(`${base}/stalls`, { maxBytes: 1024, timeoutMs: 200 }), /Request to 127\.0\.0\.1:\d+ failed/);
});
