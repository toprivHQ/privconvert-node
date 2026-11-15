// Offline tests: no network, no API key needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { createRequire } from "node:module";
import * as pc from "../dist/esm/index.js";

const VECTOR_KEY = "pjk_testvector_do_not_use_0000000000000000000";
const VECTOR_TS = 1760000000;
const VECTOR_BODY = Buffer.from(
  '{"event":"job.finished","event_id":"evt_00000000000000000000000000000000","id":"job_000000000000000000000000","status":"finished","tool":"txt-to-pdf"}',
);
const VECTOR_SIG = "t=1760000000,v1=609fa0d5493200864ae983137780d6fa6cfd7946953052fcaf4f6d4b8792803f";

test("webhook: published test vector", () => {
  assert.equal(pc.verifyWebhook(VECTOR_KEY, VECTOR_SIG, VECTOR_BODY, { now: VECTOR_TS }), true);
});

test("webhook: rejects tampering, wrong key, replay, malformed, strings", () => {
  const v = (k, s, b, now = VECTOR_TS) => pc.verifyWebhook(k, s, b, { now });
  assert.equal(v(VECTOR_KEY, VECTOR_SIG, Buffer.concat([VECTOR_BODY, Buffer.from(" ")])), false);
  assert.equal(v(VECTOR_KEY + "x", VECTOR_SIG, VECTOR_BODY), false);
  assert.equal(v(VECTOR_KEY, VECTOR_SIG, VECTOR_BODY, VECTOR_TS + 301), false);
  for (const s of ["", "t=1,v1=zz", "v1=abc", null, "t=1760000000,v1=" + "0".repeat(63)]) {
    assert.equal(v(VECTOR_KEY, s, VECTOR_BODY), false);
  }
  assert.equal(v(VECTOR_KEY, VECTOR_SIG, VECTOR_BODY.toString()), false);
  assert.throws(() => pc.verifyWebhook(VECTOR_KEY, "bad", VECTOR_BODY, { throwOnError: true }), pc.WebhookVerificationError);
});

test("client: key handling and https enforcement", () => {
  const saved = process.env.PRIVCONVERT_API_KEY;
  delete process.env.PRIVCONVERT_API_KEY;
  assert.throws(() => new pc.PrivConvert(), pc.PrivConvertError);
  if (saved !== undefined) process.env.PRIVCONVERT_API_KEY = saved;
  assert.throws(() => new pc.PrivConvert({ apiKey: "pk_live_x", baseUrl: "http://example.com/api" }), pc.PrivConvertError);
  new pc.PrivConvert({ apiKey: "pk_live_x", baseUrl: "http://127.0.0.1:9/api" });
  const c = new pc.PrivConvert({ apiKey: "pk_live_supersecret" });
  assert.ok(!inspect(c).includes("supersecret"));
  assert.ok(!JSON.stringify(c).includes("supersecret"));
});

test("client: rejects bad tool ids", async () => {
  const c = new pc.PrivConvert({ apiKey: "pk_live_x" });
  for (const t of ["../me", "a/b", "", "Word To PDF"]) {
    await assert.rejects(c.convert(t, Buffer.from("x")), pc.PrivConvertError);
  }
});

test("storage: location parsing and missing cloud SDKs", async () => {
  const c = new pc.PrivConvert({ apiKey: "pk_live_x" });
  for (const [src, dst] of [
    ["s3://bkt/", "s3://bkt/a.pdf"],
    ["s3://bkt/dir/", "s3://bkt/a.pdf"],
    ["s3://UPPER/x", "s3://bkt/a.pdf"],
    ["s3://ab/x", "s3://bkt/a.pdf"],
    ["bkt/x", "s3://bkt/a.pdf"],
    ["s3://bkt/a.docx", "ftp://bkt/a.pdf"],
    ["s3://bkt/a.docx", "https://bkt.s3.amazonaws.com/a.pdf"],
    ["s3://bkt/a.docx", "http://acct01.blob.core.windows.net/cc1/a.pdf"],
    ["s3://bkt/a.docx", "https://acct01.blob.core.windows.net.evil.com/cc1/a.pdf"],
    ["s3://bkt/a.docx", "az://acct01/cc1/"],
    ["gs://b/x", "s3://bkt/a.pdf"],
    ["s3://bkt/a.docx?x=1", "s3://bkt/a.pdf"],
  ]) {
    await assert.rejects(c.convertStorage("word-to-pdf", src, dst), pc.StorageError, `${src} -> ${dst}`);
  }
  for (const src of ["s3://bkt/a.docx", "gs://bkt/a.docx", "az://acct01/cc1/a.docx", "https://acct01.blob.core.windows.net/cc1/a.docx"]) {
    await assert.rejects(
      c.convertStorage("word-to-pdf", src, "s3://bkt/a.pdf"),
      (e) => e instanceof pc.StorageError && /npm install @aws-sdk\/client-s3 @google-cloud\/storage/.test(e.message),
      src,
    );
  }
  await assert.rejects(
    c.convertStorage("word-to-pdf", "az://acct01/cc1/a.docx", "az://acct01/cc1/a.pdf", {
      azureClient: { accountName: "other01" },
    }),
    (e) => e instanceof pc.StorageError && /other01/.test(e.message),
  );
});

test("cjs build loads", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../dist/cjs/index.js");
  assert.equal(typeof cjs.PrivConvert, "function");
  assert.equal(typeof cjs.verifyWebhook, "function");
});

test("fake server: convert, retry, quota, concurrency, job key hidden", async () => {
  const calls = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      calls.push({ path: req.url, auth: req.headers.authorization, len: req.headers["content-length"], body: Buffer.concat(chunks) });
      const reply = (status, body, headers = {}) => {
        const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        res.writeHead(status, { ...headers, "Content-Length": data.length });
        res.end(data);
      };
      if (req.url === "/api/convert/busy") {
        if (calls.filter((c) => c.path === req.url).length < 2) {
          return reply(503, { error: { code: "server_busy", message: "busy" } }, { "Retry-After": "0" });
        }
        return reply(200, Buffer.from("OK"));
      }
      if (req.url === "/api/convert/quota") return reply(429, { detail: "quota used" }, { "Retry-After": "86400" });
      if (req.url === "/api/convert/conc") {
        return reply(429, { error: { code: "concurrency_limited", message: "slow" } }, { "Retry-After": "0" });
      }
      if (req.url === "/api/jobs/json-to-csv") return reply(202, { id: "job_abc", key: "pjk_secretkey", status: "processing" });
      return reply(200, Buffer.from("%PDF-1.4"), {
        "Content-Disposition": 'attachment; filename="../x.pdf"',
        "X-Credits-Remaining": "41",
      });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const c = new pc.PrivConvert({ apiKey: "pk_live_test", baseUrl: `http://127.0.0.1:${srv.address().port}/api` });
  try {
    const r = await c.convert("word-to-pdf", Buffer.from("hello"), { filename: 'evil"\r\nX: 1.docx', params: { quality: 80 } });
    assert.equal(r.content.toString(), "%PDF-1.4");
    assert.equal(r.filename, "x.pdf");
    assert.equal(r.creditsRemaining, 41);
    const last = calls.at(-1);
    assert.equal(last.auth, "Bearer pk_live_test");
    assert.ok(last.len && Number(last.len) > 0, "Content-Length must be sent");
    assert.ok(!last.body.includes("\r\nX: 1"), "filename must not inject headers");

    assert.equal((await c.convert("busy", Buffer.from("x"))).content.toString(), "OK");

    const t0 = Date.now();
    await assert.rejects(c.convert("quota", Buffer.from("x")), (e) => e instanceof pc.RateLimitError && e.retryAfter === 86400);
    assert.ok(Date.now() - t0 < 5000, "must not sleep on a long Retry-After");

    await assert.rejects(c.convert("conc", Buffer.from("x")), pc.ConcurrencyLimitError);

    const job = await c.submitJob("json-to-csv", Buffer.from("[]"));
    assert.equal(job.key, "pjk_secretkey");
    assert.ok(!JSON.stringify(job).includes("pjk_secretkey"));
    assert.ok(!inspect(job).includes("pjk_secretkey"));
  } finally {
    srv.close();
  }
});
