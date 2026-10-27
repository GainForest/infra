import { mock } from "node:test";

export type LogLine = Record<string, unknown> & { level: string; event: string };

/** Collect the runner's JSON log lines instead of printing them. Restored by `mock.restoreAll()`. */
export function captureLogs(): LogLine[] {
  const lines: LogLine[] = [];
  const collect = (line: unknown) => {
    lines.push(JSON.parse(String(line)) as LogLine);
  };
  mock.method(console, "log", collect);
  mock.method(console, "error", collect);
  return lines;
}

export type FetchCall = { url: string; init: RequestInit | undefined };

/** Replace the global fetch. Restored by `mock.restoreAll()`. No request leaves the process. */
export function stubFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url: url.toString(), init });
    return handler(url, init);
  });
  return calls;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A GraphQL page of ac.audio nodes, as the indexer answers it. */
export const indexerPage = (nodes: unknown[]) =>
  json({
    data: {
      appGainforestAcAudio: {
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: nodes.map((node) => ({ node })),
      },
    },
  });

/**
 * The indexer lists one record for `key`, owned by `ownerDid`, whose DID document
 * names a PDS that serves it with the given originalCid. `onRequest` sees each host asked.
 */
export function stubRecordWorld(world: { key: string; ownerDid: string; originalCid: string; onRequest?: (host: string) => void }): { uri: string } {
  const uri = `at://${world.ownerDid}/app.gainforest.ac.audio/3krecord`;
  const accessUri = `https://www.gainforest.app/api/audiomoth/recordings?key=${encodeURIComponent(world.key)}`;
  stubFetch((url) => {
    world.onRequest?.(url.host);
    if (url.host === "indexer.test") {
      return indexerPage([{ uri, did: world.ownerDid, cid: "bafyindexer", accessUri, originalCid: world.originalCid }]);
    }
    if (url.host === "plc.directory") {
      return json({
        id: world.ownerDid,
        service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }],
      });
    }
    return json({ uri, cid: "bafypds", value: { originalCid: world.originalCid } });
  });
  return { uri };
}
