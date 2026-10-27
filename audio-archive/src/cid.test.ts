import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cidFromSha256 } from "./cid.ts";

test("matches the well-known CID of empty content", () => {
  const digest = createHash("sha256").update(Buffer.alloc(0)).digest();
  assert.equal(cidFromSha256(digest), "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
});
