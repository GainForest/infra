import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { chooseRecord, createRecordFetcher, loadRecordLinks, type FetchedRecord, type RecordCandidate } from "./records.ts";
import { captureLogs, json, stubFetch } from "./testing/stubs.ts";

const UPLOADER = "did:plc:abcdefghijklmnopqrstuvwx";
const ORG = "did:plc:oooooooooooooooooooooooo";
const STRANGER = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz";
const INDEXER = "https://indexer.test/graphql";

const keyFor = (file: string) => `audiomoth/${UPLOADER}/0123456789abcdef/${file}`;
const accessUriFor = (key: string) => `https://www.gainforest.app/api/audiomoth/recordings?key=${encodeURIComponent(key)}`;
const uriFor = (did: string, rkey: string) => `at://${did}/app.gainforest.ac.audio/${rkey}`;

const node = (rkey: string, did: string, key: string, extra: Record<string, unknown> = {}) => ({
  uri: uriFor(did, rkey),
  did,
  cid: `bafy${rkey}`,
  accessUri: accessUriFor(key),
  ...extra,
});

const page = (nodes: unknown[], next: string | null) =>
  json({ data: { appGainforestAcAudio: { pageInfo: { hasNextPage: next !== null, endCursor: next }, edges: nodes.map((n) => ({ node: n })) } } });

const queryOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as { query: string; variables: { after: string | null } };

afterEach(() => mock.restoreAll());

test("pages through the indexer by cursor", async () => {
  const calls = stubFetch((_url, init) =>
    queryOf(init).variables.after === null
      ? page([node("3ka", UPLOADER, keyFor("a.wav"))], "cursor-1")
      : page([node("3kb", UPLOADER, keyFor("b.wav"))], null),
  );

  const links = await loadRecordLinks(INDEXER);

  assert.deepEqual([...links.keys()].sort(), [keyFor("a.wav"), keyFor("b.wav")]);
  assert.deepEqual(
    calls.map((call) => queryOf(call.init).variables.after),
    [null, "cursor-1"],
  );
  assert.ok(calls.every((call) => call.init?.redirect === "error"));
});

test("keeps every record that claims a file, earliest-indexed first, without repeats", async () => {
  const key = keyFor("a.wav");
  // Pages come newest-first (3kthird, 3kfirst, then 3ksecond, the earliest), so the
  // earliest-indexed record arrives last and must end up first.
  stubFetch((_url, init) =>
    queryOf(init).variables.after === null
      ? page([node("3kthird", ORG, key, { originalCid: "bafkreiorg" }), node("3kfirst", STRANGER, key)], "next")
      : page([node("3ksecond", UPLOADER, key), node("3kfirst", STRANGER, key)], null),
  );

  const links = await loadRecordLinks(INDEXER);

  assert.deepEqual(
    links.get(key)?.map((candidate) => candidate.uri),
    [uriFor(UPLOADER, "3ksecond"), uriFor(STRANGER, "3kfirst"), uriFor(ORG, "3kthird")],
  );
  assert.equal(links.get(key)?.[2]?.originalCid, "bafkreiorg");
  assert.equal(links.get(key)?.[0]?.ownerDid, UPLOADER);
});

test("a record on a foreign host is still a candidate, but nothing about it verifies", async () => {
  const key = keyFor("a.wav");
  stubFetch(() => page([{ ...node("3kforeign", STRANGER, key), accessUri: `https://evil.example/api/audiomoth/recordings?key=${encodeURIComponent(key)}` }], null));

  const links = await loadRecordLinks(INDEXER);

  // Preview and staging deployments write other hosts into accessUri, so the host cannot be a filter.
  const candidates = links.get(key) ?? [];
  assert.equal(candidates.length, 1);
  const chosen = chooseRecord(candidates.map((candidate) => ({ ...candidate, pdsCid: null, value: null })), { cid: "bafkreiarchived", uploaderDid: UPLOADER });
  assert.equal(chosen?.verified, false);
});

test("ignores records whose accessUri is not an archived original", async () => {
  stubFetch(() =>
    page(
      [
        { uri: uriFor(UPLOADER, "3kother"), did: UPLOADER, cid: "bafy", accessUri: "https://example.com/some.wav" },
        { uri: uriFor(UPLOADER, "3knone"), did: UPLOADER, cid: "bafy", accessUri: null },
      ],
      null,
    ),
  );

  assert.equal((await loadRecordLinks(INDEXER)).size, 0);
});

// What each indexer schema can answer. A rejection comes back as HTTP 400 with
// a JSON error body, which is how Hyperindex reports an unknown field or enum value.
const SCHEMAS = [
  ["lacks originalCid", { originalCid: false, indexedAt: true }, [["indexed_at", true], ["indexed_at", false]]],
  ["lacks the indexed_at sort", { originalCid: true, indexedAt: false }, [["indexed_at", true], ["indexed_at", false], ["createdAt", true]]],
  [
    "lacks both",
    { originalCid: false, indexedAt: false },
    [["indexed_at", true], ["indexed_at", false], ["createdAt", true], ["createdAt", false]],
  ],
] as const;

for (const [label, schema, expectedAttempts] of SCHEMAS) {
  test(`falls back to a query an indexer that ${label} accepts`, async () => {
    const calls = stubFetch((_url, init) => {
      const { query } = queryOf(init);
      if (query.includes("originalCid") && !schema.originalCid) return json({ errors: [{ message: 'Cannot query field "originalCid"' }] }, 400);
      if (query.includes("indexed_at") && !schema.indexedAt) return json({ errors: [{ message: 'Value "indexed_at" does not exist in enum' }] }, 400);
      return page([node("3ka", UPLOADER, keyFor("a.wav"))], null);
    });

    const links = await loadRecordLinks(INDEXER);

    assert.deepEqual(
      calls.map((call) => {
        const { query } = queryOf(call.init);
        return [/sortBy: (\w+)/.exec(query)![1], query.includes("originalCid")];
      }),
      expectedAttempts,
    );
    assert.equal(links.size, 1);
  });
}

test("says what the indexer objected to when every query is rejected", async () => {
  stubFetch(() => json({ errors: [{ message: "Unknown type AppGainforestAcAudioSortField" }] }, 400));

  await assert.rejects(loadRecordLinks(INDEXER), /rejected every ac\.audio query.*Unknown type AppGainforestAcAudioSortField/);
});

test("an indexer outage is an error, not an empty result", async () => {
  stubFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));

  await assert.rejects(loadRecordLinks(INDEXER), /HTTP 502 with a body that is not JSON/);
});

test("warns and keeps what it has when the indexer has more pages than it will read", async () => {
  const logs = captureLogs();
  let served = 0;
  stubFetch(() => {
    served += 1;
    return page([node(`3k${served}`, UPLOADER, keyFor(`file${served}.wav`))], `cursor-${served}`);
  });

  const links = await loadRecordLinks(INDEXER);

  assert.equal(served, 200);
  assert.equal(links.size, 200);
  const warning = logs.find((line) => line.event === "record_links_truncated");
  assert.equal(warning?.level, "warn");
  assert.equal(warning?.reason, "max_pages");
});

test("warns and keeps what it has when paging passes its deadline", async () => {
  const logs = captureLogs();
  let served = 0;
  stubFetch((_url, init) => {
    served += 1;
    if (served === 1) return page([node("3ka", UPLOADER, keyFor("a.wav"))], "cursor-1");
    // The second page never arrives; only the deadline ends the request.
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  });

  const links = await loadRecordLinks(INDEXER, { deadlineMs: 100 });

  assert.deepEqual([...links.keys()], [keyFor("a.wav")]);
  assert.equal(logs.find((line) => line.event === "record_links_truncated")?.reason, "deadline");
});

// ---- choosing the record that describes an archived file ----

const ARCHIVED = { cid: "bafkreiarchived", uploaderDid: UPLOADER };

const fetched = (rkey: string, did: string, extra: Partial<FetchedRecord> = {}): FetchedRecord => ({
  uri: uriFor(did, rkey),
  ownerDid: did,
  cid: null,
  originalCid: null,
  pdsCid: null,
  value: null,
  ...extra,
});

test("the uploader's own record is verified, even when a stranger's was indexed first", () => {
  const stranger = fetched("3kearly", STRANGER);
  const own = fetched("3kown", UPLOADER);

  const chosen = chooseRecord([stranger, own], ARCHIVED);

  assert.equal(chosen?.record, own);
  assert.equal(chosen?.verified, true);
  assert.equal(chosen?.verifiedBy, "uploaderDid");
  assert.deepEqual(chosen?.otherCandidates, [stranger.uri]);
});

test("an organization's record is verified when its originalCid is the CID of the archived bytes", () => {
  const org = fetched("3korg", ORG, { originalCid: ARCHIVED.cid });

  const chosen = chooseRecord([fetched("3kstranger", STRANGER), org], ARCHIVED);

  assert.equal(chosen?.record, org);
  assert.equal(chosen?.verifiedBy, "originalCid");
});

test("reads originalCid from the PDS value when the indexer's schema lacks it", () => {
  const org = fetched("3korg", ORG, { value: { originalCid: ARCHIVED.cid } });

  assert.equal(chooseRecord([org], ARCHIVED)?.verifiedBy, "originalCid");
});

test("the PDS value is believed over a stale indexer copy of originalCid", () => {
  const org = fetched("3korg", ORG, { originalCid: ARCHIVED.cid, value: { originalCid: "bafkreichangedsince" } });

  const chosen = chooseRecord([org], ARCHIVED);

  assert.equal(chosen?.verified, false);
  assert.equal(chosen?.originalCid, "bafkreichangedsince");
});

test("after a re-upload, the uploader's record for these bytes wins over their record for the old ones", () => {
  const oldVersion = fetched("3kold", UPLOADER, { originalCid: "bafkreiolderversion" });
  const newVersion = fetched("3knew", UPLOADER, { originalCid: ARCHIVED.cid });

  const chosen = chooseRecord([oldVersion, newVersion], ARCHIVED);

  assert.equal(chosen?.record, newVersion);
  assert.equal(chosen?.verifiedBy, "uploaderDid");
});

test("a stranger's matching CID does not outrank the uploader's own record", () => {
  const stranger = fetched("3kstranger", STRANGER, { originalCid: ARCHIVED.cid });
  const own = fetched("3kown", UPLOADER);

  assert.equal(chooseRecord([stranger, own], ARCHIVED)?.record, own);
});

test("when nothing can be verified the earliest-indexed record is kept, marked unverified, with the rest listed", () => {
  const records = [fetched("3k1", STRANGER), fetched("3k2", ORG), fetched("3k3", STRANGER)];

  const chosen = chooseRecord(records, ARCHIVED);

  assert.equal(chosen?.record, records[0]);
  assert.equal(chosen?.verified, false);
  assert.equal(chosen?.verifiedBy, undefined);
  assert.deepEqual(chosen?.otherCandidates, [records[1]!.uri, records[2]!.uri]);
});

test("no candidates, no record", () => {
  assert.equal(chooseRecord([], ARCHIVED), null);
});

test("lists at most twenty other candidates, so a flood of claims cannot bloat a manifest", () => {
  const flood = Array.from({ length: 30 }, (_, index) => fetched(`3k${index}`, STRANGER));

  assert.equal(chooseRecord(flood, ARCHIVED)?.otherCandidates.length, 20);
});

// ---- fetching candidate values ----

const candidate = (rkey: string, did = UPLOADER): RecordCandidate => ({ uri: uriFor(did, rkey), ownerDid: did, cid: "bafyindexer", originalCid: null });

test("fetches each candidate's value and keeps the CID the PDS reported", async () => {
  stubFetch((url) =>
    url.host === "plc.directory"
      ? json({ id: UPLOADER, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }] })
      : json({ uri: "ignored", cid: "bafypdscid", value: { name: "a.wav" } }),
  );

  const [record] = await createRecordFetcher(["pds.example.com"])([candidate("3ka")], UPLOADER);

  assert.deepEqual(record, { ...candidate("3ka"), pdsCid: "bafypdscid", value: { name: "a.wav" } });
});

test("a record that cannot be read keeps a null value and a warning that says why", async () => {
  const logs = captureLogs();
  stubFetch(() => json({}, 404));

  const [record] = await createRecordFetcher(["pds.example.com"])([candidate("3ka")], UPLOADER);

  assert.equal(record?.value, null);
  assert.equal(record?.pdsCid, null);
  const warning = logs.find((line) => line.event === "record_value_unavailable");
  assert.equal(warning?.level, "warn");
  assert.equal(warning?.uri, uriFor(UPLOADER, "3ka"));
  assert.match(String(warning?.reason), /DID document .* answered HTTP 404/);
});

test("reads at most ten candidates' values per file and says when it stopped", async () => {
  const logs = captureLogs();
  const calls = stubFetch((url) =>
    url.host === "plc.directory"
      ? json({ id: UPLOADER, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }] })
      : json({ cid: "bafypdscid", value: { name: "a.wav" } }),
  );

  const records = await createRecordFetcher(["pds.example.com"])(Array.from({ length: 12 }, (_, index) => candidate(`3k${index}`)), UPLOADER);

  assert.equal(records.length, 12);
  assert.equal(calls.filter((call) => call.url.includes("getRecord")).length, 10);
  assert.deepEqual(records.slice(10).map((record) => record.value), [null, null]);
  assert.ok(logs.some((line) => line.event === "record_candidates_not_fetched"));
});

test("the uploader's own records are read before strangers' when there are more than ten", async () => {
  const calls = stubFetch((url) =>
    url.host === "plc.directory"
      ? json({ id: url.pathname.slice(1), service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }] })
      : json({ cid: "bafypdscid", value: { name: "a.wav" } }),
  );
  const spam = Array.from({ length: 12 }, (_, index) => candidate(`3kspam${index}`, STRANGER));

  const records = await createRecordFetcher(["pds.example.com"])([...spam, candidate("3kmine")], UPLOADER);

  const mine = records.find((record) => record.uri === uriFor(UPLOADER, "3kmine"));
  assert.deepEqual(mine?.value, { name: "a.wav" });
  assert.ok(calls.some((call) => call.url.includes("rkey=3kmine")));
});
