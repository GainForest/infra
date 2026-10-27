import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { createPdsClient } from "./pds.ts";
import { json, stubFetch } from "./testing/stubs.ts";

const OWNER = "did:plc:abcdefghijklmnopqrstuvwx";
const HOSTS = ["pds.example.com"];
const URI = `at://${OWNER}/app.gainforest.ac.audio/3krecord`;
const RECORD = { uri: URI, cid: "bafypds", value: { name: "x.wav", originalCid: "bafkreiabc" } };

const didDoc = (serviceEndpoint: unknown, id = OWNER) => ({
  id,
  service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint }],
});

/** plc.directory answers with a DID document naming `endpoint`; any other host serves the record. */
function stubPds(endpoint: unknown = "https://pds.example.com") {
  return stubFetch((url) => (url.host === "plc.directory" ? json(didDoc(endpoint)) : json(RECORD)));
}

/** A response whose body is `chunks` of `size` bytes, counting how much is pulled and whether it was cancelled. */
function oversized(chunks: number, size = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent += 1;
      state.pulled += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, response: new Response(body, { status: 200 }) };
}

afterEach(() => mock.restoreAll());

test("reads a record from the PDS that the owner's DID document names", async () => {
  const calls = stubPds();

  const result = await createPdsClient(HOSTS).getRecord(URI, OWNER);

  assert.deepEqual(result, { value: RECORD.value, cid: "bafypds" });
  assert.equal(calls[0]!.url, `https://plc.directory/${OWNER}`);
  const recordUrl = new URL(calls[1]!.url);
  assert.equal(recordUrl.origin, "https://pds.example.com");
  assert.equal(recordUrl.pathname, "/xrpc/com.atproto.repo.getRecord");
  assert.deepEqual(Object.fromEntries(recordUrl.searchParams), { repo: OWNER, collection: "app.gainforest.ac.audio", rkey: "3krecord" });
  assert.deepEqual(
    calls.map((call) => call.init?.redirect),
    ["error", "error"],
    "every request must refuse redirects",
  );
});

test("looks each DID up once per client", async () => {
  const calls = stubPds();
  const client = createPdsClient(HOSTS);
  await client.getRecord(URI, OWNER);
  await client.getRecord(`at://${OWNER}/app.gainforest.ac.audio/3kother`, OWNER);
  assert.equal(calls.filter((call) => call.url.startsWith("https://plc.directory/")).length, 1);
});

test("a DID lookup that keeps failing is retried once, and asked again for the next record", async () => {
  const calls = stubFetch(() => json({}, 503));
  const client = createPdsClient(HOSTS);
  await assert.rejects(client.getRecord(URI, OWNER), /answered HTTP 503/);
  await assert.rejects(client.getRecord(`at://${OWNER}/app.gainforest.ac.audio/3kother`, OWNER), /answered HTTP 503/);
  assert.equal(calls.length, 4, "each record should try the DID twice; a failure must not be cached");
});

test("one failed DID lookup does not cost the record its value", async () => {
  let plcCalls = 0;
  stubFetch((url) => {
    if (url.host !== "plc.directory") return json(RECORD);
    plcCalls += 1;
    return plcCalls === 1 ? json({}, 503) : json(didDoc("https://pds.example.com"));
  });
  const result = await createPdsClient(HOSTS).getRecord(URI, OWNER);
  assert.deepEqual(result.value, RECORD.value);
});

test("a did:web on the allowlist is resolved from its own host", async () => {
  const did = "did:web:pds.example.com";
  const calls = stubFetch((url) =>
    url.pathname === "/.well-known/did.json" ? json(didDoc("https://pds.example.com", did)) : json(RECORD),
  );
  await createPdsClient(HOSTS).getRecord(`at://${did}/app.gainforest.ac.audio/3krecord`, did);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/.well-known/did.json", "/xrpc/com.atproto.repo.getRecord"],
  );
});

for (const did of [
  "did:web:localhost",
  "did:web:127.0.0.1",
  "did:web:example.com%3A8443",
  "did:web:example.com:user:alice",
  "did:web:intranet.local",
  "did:web:db.internal",
  "did:web:[::1]",
  "did:plc:tooshort",
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
]) {
  test(`${did} is refused before any request is made`, async () => {
    const calls = stubPds();

    await assert.rejects(createPdsClient(HOSTS).getRecord(`at://${did}/app.gainforest.ac.audio/3krecord`, did), /not a did:plc or a did:web|not in AUDIO_ARCHIVE_PDS_HOSTS/);

    assert.equal(calls.length, 0);
  });
}

for (const [endpoint, reason] of [
  ["http://pds.example.com", /must use https/],
  ["https://127.0.0.1", /not in AUDIO_ARCHIVE_PDS_HOSTS/],
  ["https://2130706433", /not in AUDIO_ARCHIVE_PDS_HOSTS/],
  ["https://169.254.169.254", /not in AUDIO_ARCHIVE_PDS_HOSTS/],
  ["https://10.0.0.5", /not in AUDIO_ARCHIVE_PDS_HOSTS/],
  ["https://[::1]", /not in AUDIO_ARCHIVE_PDS_HOSTS/],
  ["https://localhost", /not in AUDIO_ARCHIVE_PDS_HOSTS/],
  ["https://pds.internal", /not in AUDIO_ARCHIVE_PDS_HOSTS/],
  ["https://printer.local", /not in AUDIO_ARCHIVE_PDS_HOSTS/],
  ["https://pds.example.com:8443", /must not name a port/],
  ["https://user:hunter2@pds.example.com", /must not contain credentials/],
  ["https://pds.example.com/some/prefix", /bare origin/],
  ["https://pds.example.com/?next=http://169.254.169.254", /bare origin/],
  ["not a url", /not a URL/],
] as const) {
  test(`a PDS endpoint of ${endpoint} is refused and the record is never requested`, async () => {
    const calls = stubPds(endpoint);

    await assert.rejects(createPdsClient(HOSTS).getRecord(URI, OWNER), (error: Error) => {
      assert.match(error.message, reason);
      assert.doesNotMatch(error.message, /hunter2/, "credentials from the endpoint were echoed");
      return true;
    });

    assert.equal(calls.length, 1, "only the DID document should have been requested");
  });
}

test("a record outside the repo the indexer attributes it to is refused before any request", async () => {
  const calls = stubPds();

  await assert.rejects(
    createPdsClient(HOSTS).getRecord(`at://did:plc:zzzzzzzzzzzzzzzzzzzzzzzz/app.gainforest.ac.audio/3krecord`, OWNER),
    /not in the indexed owner/,
  );

  assert.equal(calls.length, 0);
});

test("a DID document that describes a different DID is refused", async () => {
  const calls = stubFetch(() => json(didDoc("https://pds.example.com", "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz")));

  await assert.rejects(createPdsClient(HOSTS).getRecord(URI, OWNER), /describes a different DID/);

  assert.equal(calls.length, 1);
});

test("an oversized DID document is refused while it is still being read", async () => {
  const big = oversized(100);
  stubFetch(() => big.response);

  await assert.rejects(createPdsClient(HOSTS).getRecord(URI, OWNER), /larger than the \d+ byte limit/);

  assert.ok(big.state.cancelled, "the download was not cancelled");
  assert.ok(big.state.pulled < 1024 * 1024, `read ${big.state.pulled} bytes of a document that should have been cut off`);
});

test("an oversized record is refused while it is still being read", async () => {
  const big = oversized(100);
  stubFetch((url) => (url.host === "plc.directory" ? json(didDoc("https://pds.example.com")) : big.response));

  await assert.rejects(createPdsClient(HOSTS).getRecord(URI, OWNER), /larger than the \d+ byte limit/);

  assert.ok(big.state.cancelled, "the download was not cancelled");
  assert.ok(big.state.pulled < 1024 * 1024, `read ${big.state.pulled} bytes of a record that should have been cut off`);
});

test("says why a PDS would not return the record", async () => {
  stubFetch((url) => (url.host === "plc.directory" ? json(didDoc("https://pds.example.com")) : json({ error: "RecordNotFound" }, 400)));

  await assert.rejects(createPdsClient(HOSTS).getRecord(URI, OWNER), /getRecord answered HTTP 400 \(RecordNotFound\)/);
});

test("a PDS host that is not on the allowlist is refused before any record request", async () => {
  const calls = stubPds("https://pds.other.org");
  await assert.rejects(createPdsClient(HOSTS).getRecord(URI, OWNER), /pds\.other\.org is not in AUDIO_ARCHIVE_PDS_HOSTS/);
  assert.deepEqual(calls.map((call) => new URL(call.url).host), ["plc.directory"]);
});
