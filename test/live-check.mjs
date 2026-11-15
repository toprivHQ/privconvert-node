// Live checks against the real API. Needs PRIVCONVERT_API_KEY; spends a few credits.
//   PRIVCONVERT_API_KEY=pk_live_... node test/live-check.mjs [--large]
import { randomBytes } from "node:crypto";
import * as pc from "../dist/esm/index.js";

const c = new pc.PrivConvert();
let ok = true;
const check = (name, cond, extra = "") => {
  ok &&= Boolean(cond);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
};

const me = await c.me();
check("me", "remaining" in me && "tier" in me, `tier=${me.tier} remaining=${me.remaining}`);

const tools = await c.tools("data");
check("tools", tools.some((t) => t.id === "json-to-csv"), `${tools.length} data tools`);

const r = await c.convert("json-to-csv", Buffer.from('[{"a":1,"b":2},{"a":3,"b":4}]'), { filename: "t.json" });
check("convert", r.content.toString().replace(/\r/g, "").startsWith("a,b\n1,2"), `file=${r.filename} left=${r.creditsRemaining}`);

const b = await c.convertBatch("json-to-csv", [Buffer.from('[{"x":1}]'), new Blob(['[{"y":2}]']), Buffer.from("not json")]);
check("batch partial", b.partial && b.failedCount === 1 && b.convertedCount === 2);

const job = await c.submitJob("json-to-csv", Buffer.from('[{"j":9}]'), { filename: "job.json" });
const res = await c.wait(job, { pollIntervalMs: 1000 });
check("async job", res.content.toString().replace(/\r/g, "").startsWith("j\n9"), `id=${job.id}`);
try {
  await c.getJob(job);
  check("job deleted after wait", false);
} catch (e) {
  check("job deleted after wait", e instanceof pc.JobNotFoundError);
}

try {
  await c.convert("json-to-csv", Buffer.from("this is not json at all {"));
  check("error mapping", false);
} catch (e) {
  check("error mapping", e instanceof pc.PrivConvertError && [400, 422].includes(e.status), `${e.name} ${e.status} ${e.message.slice(0, 60)}`);
}

try {
  await new pc.PrivConvert({ apiKey: "pk_live_" + "x".repeat(40) }).me();
  check("bad key", false);
} catch (e) {
  check("bad key", e instanceof pc.AuthenticationError);
}

if (process.argv.includes("--large")) {
  // A stored (uncompressed) single-entry ZIP built by hand, ~95 MB.
  const payload = randomBytes(95 * 1024 * 1024);
  const zip = storedZip("big.bin", payload);
  const out = await c.convert("zip-to-targz", zip, { filename: "big.zip" });
  check("chunked upload", out.content[0] === 0x1f && out.content[1] === 0x8b && out.content.length > 90 * 1024 * 1024,
    `in=${zip.length >> 20}MB out=${out.content.length >> 20}MB`);
}

console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(name, data) {
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const cdOffset = local.length + nameBuf.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}
