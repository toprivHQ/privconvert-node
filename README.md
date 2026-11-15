# PrivConvert for Node.js

Official Node.js client for the [PrivConvert API](https://privconvert.com/developers/): file conversion for your app with zero data retention. Every file is processed in memory on our side and never written to disk.

- No runtime dependencies (cloud storage support uses the cloud SDKs only if you install them)
- Node.js 18.17+, ESM and CommonJS, TypeScript types included
- Large files (above 90 MB) are uploaded in parts automatically
- Async jobs, webhook signature verification and typed errors included

## Install

```bash
npm install github:toprivHQ/privconvert-node#v0.3.0
```

The package is not on the npm registry yet. Until it is, install it straight from this repository. Always pin a release tag (`#v0.3.0`) rather than the main branch, so you get exactly the reviewed code. The install compiles the TypeScript source with the exact compiler version locked in `package-lock.json`; there are no `preinstall` or `postinstall` scripts.

## Quick start

Create a key on your [account page](https://privconvert.com/account/#apikeys) (new accounts can start a free trial of 25 conversions) and set it as an environment variable:

```bash
export PRIVCONVERT_API_KEY=pk_live_...
```

```js
import { PrivConvert } from "privconvert";

const pc = new PrivConvert();

const result = await pc.convert("word-to-pdf", "contract.docx");
await result.save("contract.pdf");
console.log(result.creditsRemaining);
```

`file` can be a path, a `file:` URL, a `Buffer` / `Uint8Array`, or a `Blob`. Form fields go in `params`:

```js
await pc.convert("compress-image", "photo.png", { params: { quality: 70 } });
await pc.convert("resize-image", imageBuffer, { filename: "in.jpg", params: { width: 800 } });
```

The tool id is the same slug as on the site. List them with `pc.tools()` or `pc.tools("document")`.

## Many files at once

Up to 20 files in one request, returned as a ZIP. A batch costs one slot of your per-minute rate limit.

```js
const zip = await pc.convertBatch("png-to-jpg", ["a.png", "b.png", "c.png"]);
await zip.save("converted.zip");
if (zip.partial) console.log(`${zip.failedCount} files were skipped, see PRIVCONVERT-ERRORS.txt in the ZIP`);
```

## Files in cloud storage

Convert a file in Amazon S3, Google Cloud Storage or Azure Blob Storage and write the result back:

```js
await pc.convertStorage("word-to-pdf", "s3://my-bucket/input.docx", "s3://my-bucket/output.pdf");
await pc.convertStorage("word-to-pdf", "gs://my-bucket/input.docx", "gs://my-bucket/output.pdf");
await pc.convertStorage("word-to-pdf", "az://myaccount/my-container/input.docx", "az://myaccount/my-container/output.pdf");
```

The cloud is picked from the address. Azure also accepts the blob URL from the portal (`https://myaccount.blob.core.windows.net/my-container/input.docx`). Source and destination can be in different clouds.

The file moves between your storage and PrivConvert from wherever this code runs, using your own credentials. Your credentials are never sent to PrivConvert, and we never get access to your storage. Run it in the same region as the bucket and the transfer is fast and cheap.

**Credentials.** Each cloud's standard sign-in is used: for S3 the default AWS SDK chain (environment, profile or IAM role), for Google Application Default Credentials, for Azure `AZURE_STORAGE_CONNECTION_STRING` or `DefaultAzureCredential` (managed identity, environment, Azure CLI). To control it yourself, pass `s3Client`, `gcsClient` (a `Storage`) or `azureClient` (a `BlobServiceClient`).

**Libraries.** The cloud SDKs you already use are picked up automatically. If one is missing, this installs all of them:

```bash
npm install @aws-sdk/client-s3 @google-cloud/storage @azure/storage-blob @azure/identity
```

**Cloudflare R2, Backblaze B2 and other S3-compatible storage.** Use an `s3://` address and an S3 client pointed at the provider.

### Cloudflare R2

Convert files in an R2 bucket and write the result back to R2. Create an R2 API token with read and write access to the bucket, and use your Cloudflare account ID in the endpoint:

```js
import { S3Client } from "@aws-sdk/client-s3";
import { PrivConvert } from "privconvert";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const pc = new PrivConvert();
await pc.convertStorage("word-to-pdf", "s3://my-bucket/contracts/input.docx", "s3://my-bucket/contracts/output.pdf", {
  s3Client: r2,
  overwrite: false,
});
```

The file goes from R2 to PrivConvert and back from wherever this code runs. Your R2 keys stay with you.

### Backblaze B2

```js
import { S3Client } from "@aws-sdk/client-s3";

const b2 = new S3Client({ endpoint: "https://s3.us-east-005.backblazeb2.com", region: "us-east-005" });
await pc.convertStorage("word-to-pdf", "s3://my-bucket/input.docx", "s3://my-bucket/output.pdf", { s3Client: b2 });
```

### Options

```js
await pc.convertStorage("word-to-pdf", "gs://in-bucket/contract.docx", "s3://out-bucket/contract.pdf", {
  uploadParams: { ServerSideEncryption: "aws:kms" }, // passed to the destination's upload call
  overwrite: false, // leave an existing file alone, before any credit is spent
});
```

Storage problems throw `StorageError`, with the provider's code in `code` (for example `NoSuchKey`, `NotFound`, `BlobNotFound` or `AccessDenied`).

## Async jobs

```js
const job = await pc.submitJob("pptx-to-pdf", "deck.pptx");
// job.key is returned once. Keep it if you need to download later or verify webhooks.
const result = await pc.wait(job); // polls, downloads, then deletes the stored result
await result.save("deck.pdf");
```

With a webhook instead of polling:

```js
const job = await pc.submitJob("pptx-to-pdf", "deck.pptx", { webhookUrl: "https://example.com/hooks/privconvert" });
await saveSomewhere(job.id, job.key);
// later, when the webhook arrives:
const result = await pc.downloadJob(job);
```

## Verifying webhooks

Pass the raw request bytes, not parsed JSON. With Express:

```js
import express from "express";
import { verifyWebhook } from "privconvert";

app.post("/hooks/privconvert", express.raw({ type: "application/json" }), async (req, res) => {
  const event = JSON.parse(req.body);
  const jobKey = await loadJobKey(event.id);
  if (!verifyWebhook(jobKey, req.get("X-PrivConvert-Signature"), req.body)) return res.sendStatus(400);
  res.sendStatus(200);
});
```

Deliveries older than 5 minutes are rejected as replays (`{ toleranceS }` to change it).

## Errors

Every error is a `PrivConvertError` with `status`, `code`, `message` and `retryAfter`:

| Class | When |
| --- | --- |
| `AuthenticationError` | Missing or invalid key (401) |
| `BadRequestError` | Bad request or unreadable input (400) |
| `FileTooLargeError` | Above your plan's size limit (413) |
| `UnsupportedTypeError` | Wrong input type for the tool (415) |
| `ConversionFailedError` | File read but could not be converted (422) |
| `RateLimitError` | Per-minute rate or monthly quota exceeded (429) |
| `ConcurrencyLimitError` | Too many conversions at once (429) |
| `ServerError` | Problem on our side (5xx) |
| `StorageError` | Reading from or writing to your cloud storage failed |

Short 429, 502, 503 and 504 responses are retried automatically (`maxRetries: 2`), honouring `Retry-After`. A long `Retry-After`, which means the monthly quota is used up, throws at once instead of sleeping.

## Usage and limits

```js
await pc.me();
// { tier: 'growth', quota: 25000, used: 1234, remaining: 23766, rpm: 120, ... }
```

## Security notes

- The key is read from `PRIVCONVERT_API_KEY` or passed explicitly, and never appears in `console.log`, `util.inspect` or `JSON.stringify` output.
- Requests go over HTTPS only. A plain `http://` base URL is refused.
- This package writes nothing to disk except where you call `result.save()`.
- `convertStorage` keeps the file in memory between your storage and the API. Your cloud credentials stay with you.

## Links

- [API documentation](https://privconvert.com/docs/)
- [Pricing and free trial](https://privconvert.com/developers/)
- Support: contact@topriv.com

MIT License
