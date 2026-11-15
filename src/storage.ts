import { StorageError } from "./errors.js";

/** The largest file any plan accepts. Checked before the object is read. */
export const MAX_OBJECT_BYTES = 500 * 1024 * 1024;

const S3_RE = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+)$/;

/** Anything with the `send` method of an AWS SDK v3 `S3Client`. */
export interface S3ClientLike {
  send(command: unknown): Promise<any>;
}

export interface Location {
  bucket: string;
  key: string;
}

export function parseLocation(url: string): Location {
  const s = String(url ?? "");
  if (/^(gs|az|azure|https?):\/\//.test(s)) throw new StorageError("Only s3:// locations are supported for now.");
  const m = S3_RE.exec(s);
  if (!m || m[2].endsWith("/")) throw new StorageError("Expected a location like s3://bucket/path/to/file.");
  return { bucket: m[1], key: m[2] };
}

export const show = (l: Location) => `s3://${l.bucket}/${l.key}`;

interface S3Module {
  S3Client: new (config?: object) => S3ClientLike;
  GetObjectCommand: new (input: object) => unknown;
  PutObjectCommand: new (input: object) => unknown;
  HeadObjectCommand: new (input: object) => unknown;
}

// Kept in a variable so TypeScript does not need the AWS SDK installed to build.
const S3_PACKAGE = "@aws-sdk/client-s3";

export async function loadS3(): Promise<S3Module> {
  try {
    return (await import(S3_PACKAGE)) as S3Module;
  } catch {
    throw new StorageError("S3 support needs the AWS SDK: npm install @aws-sdk/client-s3");
  }
}

function providerError(action: string, loc: Location, e: unknown): StorageError {
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const code = err?.Code || err?.name || undefined;
  return new StorageError(`Could not ${action} ${show(loc)}: ${code ?? "unknown error"}`, { code });
}

export async function exists(mod: S3Module, client: S3ClientLike, loc: Location): Promise<boolean> {
  try {
    await client.send(new mod.HeadObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
    return true;
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return false;
    throw providerError("check", loc, e);
  }
}

export async function readObject(mod: S3Module, client: S3ClientLike, loc: Location): Promise<Uint8Array> {
  let resp: { Body?: { transformToByteArray(): Promise<Uint8Array>; destroy?: () => void }; ContentLength?: number };
  try {
    resp = await client.send(new mod.GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
  } catch (e) {
    throw providerError("read", loc, e);
  }
  const tooBig = () => new StorageError(`${show(loc)} is larger than ${MAX_OBJECT_BYTES / (1024 * 1024)} MB.`);
  if (!resp.Body) throw new StorageError(`${show(loc)} returned no content.`);
  if (resp.ContentLength !== undefined && resp.ContentLength > MAX_OBJECT_BYTES) {
    resp.Body.destroy?.();
    throw tooBig();
  }
  const data = await resp.Body.transformToByteArray();
  if (data.byteLength > MAX_OBJECT_BYTES) throw tooBig();
  return data;
}

export async function writeObject(
  mod: S3Module,
  client: S3ClientLike,
  loc: Location,
  data: Uint8Array,
  contentType: string | null,
  opts: { overwrite: boolean; uploadParams?: Record<string, unknown> },
): Promise<void> {
  const input: Record<string, unknown> = { ...(opts.uploadParams ?? {}) };
  if (contentType && input.ContentType === undefined) input.ContentType = contentType;
  if (!opts.overwrite) input.IfNoneMatch = "*";
  Object.assign(input, { Bucket: loc.bucket, Key: loc.key, Body: data });
  try {
    await client.send(new mod.PutObjectCommand(input));
  } catch (e) {
    throw providerError("write", loc, e);
  }
}
