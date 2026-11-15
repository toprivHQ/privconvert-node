# PrivConvert for Node.js

Official Node.js client for the [PrivConvert API](https://privconvert.com/developers/): file conversion for your app with zero data retention. Every file is processed in memory on our side and never written to disk.

- No runtime dependencies
- Node.js 18.17+, ESM and CommonJS, TypeScript types included
- Large files (above 90 MB) are uploaded in parts automatically
- Async jobs, webhook signature verification and typed errors included

## Install

```bash
npm install github:toprivHQ/privconvert-node
```

The package is not on the npm registry yet. Until it is, install it straight from this repository; it builds itself on install.

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

## Links

- [API documentation](https://privconvert.com/docs/)
- [Pricing and free trial](https://privconvert.com/developers/)
- Support: contact@topriv.com

MIT License
