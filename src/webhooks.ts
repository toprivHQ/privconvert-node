import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SIG_RE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

export class WebhookVerificationError extends Error {}

export interface VerifyOptions {
  /** Maximum age of a delivery in seconds. Default 300. */
  toleranceS?: number;
  /** Override the current time (unix seconds), for tests. */
  now?: number;
  /** Throw WebhookVerificationError instead of returning false. */
  throwOnError?: boolean;
}

/**
 * Check an `X-PrivConvert-Signature` header against the raw request body.
 * `rawBody` must be the exact bytes received, not re-serialized JSON.
 * `jobKey` is the one-time `key` returned when the job was submitted.
 */
export function verifyWebhook(
  jobKey: string,
  signature: string | null | undefined,
  rawBody: Uint8Array,
  opts: VerifyOptions = {},
): boolean {
  const fail = (reason: string): boolean => {
    if (opts.throwOnError) throw new WebhookVerificationError(reason);
    return false;
  };
  if (!jobKey || typeof jobKey !== "string") return fail("missing job key");
  if (!signature || typeof signature !== "string") return fail("missing signature header");
  if (!(rawBody instanceof Uint8Array)) return fail("rawBody must be a Buffer or Uint8Array, not a string or object");
  const m = SIG_RE.exec(signature.trim());
  if (!m) return fail("malformed signature header");
  const ts = parseInt(m[1], 10);
  const now = opts.now ?? Date.now() / 1000;
  if (Math.abs(now - ts) > (opts.toleranceS ?? 300)) return fail("timestamp outside tolerance");
  const sigKey = createHash("sha256").update("pc-webhook-sig-v1|" + jobKey).digest();
  const expected = createHmac("sha256", sigKey).update(`${ts}.`).update(rawBody).digest();
  const given = Buffer.from(m[2], "hex");
  if (given.length !== expected.length || !timingSafeEqual(expected, given)) return fail("signature mismatch");
  return true;
}
