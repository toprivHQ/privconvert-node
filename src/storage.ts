import { StorageError } from "./errors.js";

/** The largest file any plan accepts. Checked before the object is read. */
export const MAX_OBJECT_BYTES = 500 * 1024 * 1024;
const MB = MAX_OBJECT_BYTES / (1024 * 1024);

const CLOUD_INSTALL = "npm install @aws-sdk/client-s3 @google-cloud/storage @azure/storage-blob @azure/identity";

const BUCKET = "([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])";
const S3_RE = new RegExp(`^s3://${BUCKET}/(.+)$`);
const GS_RE = new RegExp(`^gs://${BUCKET}/(.+)$`);
const ACCOUNT = "([a-z0-9]{3,24})";
const CONTAINER = "([a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?)";
const AZ_RE = new RegExp(`^az://${ACCOUNT}/${CONTAINER}/(.+)$`);
const AZ_HTTPS_RE = new RegExp(`^https://${ACCOUNT}\\.blob\\.core\\.windows\\.net/${CONTAINER}/(.+)$`);

/** Anything with the `send` method of an AWS SDK v3 `S3Client`. */
export interface S3ClientLike {
  send(command: unknown): Promise<any>;
}

export interface Location {
  provider: "s3" | "gcs" | "azure";
  /** S3 / GCS bucket, or Azure container. */
  bucket: string;
  key: string;
  /** Azure storage account. */
  account?: string;
}

export function parseLocation(url: string): Location {
  const s = String(url ?? "");
  let loc: Location;
  let m: RegExpExecArray | null;
  if ((m = S3_RE.exec(s))) loc = { provider: "s3", bucket: m[1], key: m[2] };
  else if ((m = GS_RE.exec(s))) loc = { provider: "gcs", bucket: m[1], key: m[2] };
  else if ((m = AZ_RE.exec(s) ?? AZ_HTTPS_RE.exec(s))) loc = { provider: "azure", account: m[1], bucket: m[2], key: m[3] };
  else {
    throw new StorageError(
      "Expected a location like s3://bucket/file, gs://bucket/file, az://account/container/file " +
        "or https://account.blob.core.windows.net/container/file.",
    );
  }
  if (/[/]$|[?#]/.test(loc.key)) throw new StorageError(`${show(loc)} must point to a single file.`);
  return loc;
}

export function show(l: Location): string {
  if (l.provider === "s3") return `s3://${l.bucket}/${l.key}`;
  if (l.provider === "gcs") return `gs://${l.bucket}/${l.key}`;
  return `az://${l.account}/${l.bucket}/${l.key}`;
}

const tooBig = (loc: Location) => new StorageError(`${show(loc)} is larger than ${MB} MB.`);

function checkSize(loc: Location, size: unknown): void {
  if (size !== undefined && size !== null && Number(size) > MAX_OBJECT_BYTES) throw tooBig(loc);
}

function failure(action: string, loc: Location, code: string | undefined): StorageError {
  return new StorageError(`Could not ${action} ${show(loc)}: ${code ?? "unknown error"}`, { code });
}

// Package names are kept in variables so TypeScript does not need the cloud
// SDKs installed to build, and bundlers do not pull them in.
async function load(pkg: string, what: string): Promise<any> {
  try {
    return await import(pkg);
  } catch {
    throw new StorageError(`${what} support needs ${pkg}: ${CLOUD_INSTALL}`);
  }
}

export interface Backend {
  exists(loc: Location): Promise<boolean>;
  read(loc: Location): Promise<Uint8Array>;
  write(loc: Location, data: Uint8Array, contentType: string | null, overwrite: boolean, uploadParams: Record<string, unknown>): Promise<void>;
}

// ── Amazon S3 and S3-compatible storage (Backblaze B2, Cloudflare R2, ...) ──

class S3Backend implements Backend {
  constructor(private mod: any, private c: S3ClientLike) {}

  private code(e: unknown): string | undefined {
    const err = e as { name?: string; Code?: string };
    return err?.Code || err?.name || undefined;
  }

  async exists(loc: Location): Promise<boolean> {
    try {
      await this.c.send(new this.mod.HeadObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
      return true;
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return false;
      throw failure("check", loc, this.code(e));
    }
  }

  async read(loc: Location): Promise<Uint8Array> {
    let resp: { Body?: { transformToByteArray(): Promise<Uint8Array>; destroy?: () => void }; ContentLength?: number };
    try {
      resp = await this.c.send(new this.mod.GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
    } catch (e) {
      throw failure("read", loc, this.code(e));
    }
    if (!resp.Body) throw new StorageError(`${show(loc)} returned no content.`);
    if (resp.ContentLength !== undefined && resp.ContentLength > MAX_OBJECT_BYTES) {
      resp.Body.destroy?.();
      throw tooBig(loc);
    }
    const data = await resp.Body.transformToByteArray();
    if (data.byteLength > MAX_OBJECT_BYTES) throw tooBig(loc);
    return data;
  }

  async write(loc: Location, data: Uint8Array, contentType: string | null, overwrite: boolean, uploadParams: Record<string, unknown>) {
    const input: Record<string, unknown> = { ...uploadParams };
    if (contentType && input.ContentType === undefined) input.ContentType = contentType;
    Object.assign(input, { Bucket: loc.bucket, Key: loc.key, Body: data });
    const put = (extra: Record<string, unknown> = {}) => this.c.send(new this.mod.PutObjectCommand({ ...input, ...extra }));
    try {
      if (overwrite) return void (await put());
      try {
        await put({ IfNoneMatch: "*" });
      } catch (e) {
        const code = this.code(e);
        if (code === "PreconditionFailed" || code === "ConditionalRequestConflict") throw e;
        // Some S3-compatible services (Backblaze B2 among them) reject the
        // condition itself, so fall back to checking just before writing.
        if (await this.exists(loc)) throw new StorageError(`${show(loc)} already exists.`, { code: "DestinationExists" });
        await put();
      }
    } catch (e) {
      if (e instanceof StorageError) throw e;
      throw failure("write", loc, this.code(e));
    }
  }
}

// ── Google Cloud Storage ──

const GCS_CODES: Record<number, string> = { 403: "Forbidden", 404: "NotFound", 412: "PreconditionFailed" };

class GcsBackend implements Backend {
  constructor(private c: any) {}

  private code(e: unknown): string | undefined {
    const status = (e as { code?: unknown })?.code;
    if (typeof status === "number") return GCS_CODES[status] ?? String(status);
    return (e as { name?: string })?.name;
  }

  async exists(loc: Location): Promise<boolean> {
    try {
      const [found] = await this.c.bucket(loc.bucket).file(loc.key).exists();
      return Boolean(found);
    } catch (e) {
      throw failure("check", loc, this.code(e));
    }
  }

  async read(loc: Location): Promise<Uint8Array> {
    let data: Uint8Array;
    try {
      const [meta] = await this.c.bucket(loc.bucket).file(loc.key).getMetadata();
      checkSize(loc, meta?.size);
      // Pinning the generation makes the size check hold for the bytes read.
      [data] = await this.c.bucket(loc.bucket).file(loc.key, { generation: meta?.generation }).download();
    } catch (e) {
      if (e instanceof StorageError) throw e;
      throw failure("read", loc, this.code(e));
    }
    if (data.byteLength > MAX_OBJECT_BYTES) throw tooBig(loc);
    return data;
  }

  async write(loc: Location, data: Uint8Array, contentType: string | null, overwrite: boolean, uploadParams: Record<string, unknown>) {
    const opts: Record<string, unknown> = { resumable: false, contentType: contentType ?? "application/octet-stream", ...uploadParams };
    if (!overwrite) opts.preconditionOpts = { ifGenerationMatch: 0 };
    try {
      await this.c.bucket(loc.bucket).file(loc.key).save(Buffer.from(data.buffer, data.byteOffset, data.byteLength), opts);
    } catch (e) {
      throw failure("write", loc, this.code(e));
    }
  }
}

// ── Azure Blob Storage ──

class AzureBackend implements Backend {
  constructor(private c: any) {}

  private code(e: unknown): string | undefined {
    const err = e as { code?: string; statusCode?: number; name?: string; details?: { errorCode?: string } };
    return err?.details?.errorCode || err?.code || (err?.statusCode ? String(err.statusCode) : err?.name);
  }

  private blob(loc: Location): any {
    const name = this.c?.accountName;
    if (name && loc.account && name !== loc.account) {
      throw new StorageError(`azureClient is for account "${name}", but ${show(loc)} is in "${loc.account}".`);
    }
    return this.c.getContainerClient(loc.bucket).getBlockBlobClient(loc.key);
  }

  async exists(loc: Location): Promise<boolean> {
    const blob = this.blob(loc);
    try {
      return Boolean(await blob.exists());
    } catch (e) {
      throw failure("check", loc, this.code(e));
    }
  }

  async read(loc: Location): Promise<Uint8Array> {
    const blob = this.blob(loc);
    let data: Uint8Array;
    try {
      const props = await blob.getProperties();
      checkSize(loc, props.contentLength);
      // Pinning the ETag makes the size check hold for the bytes read.
      data = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: props.etag } });
    } catch (e) {
      if (e instanceof StorageError) throw e;
      throw failure("read", loc, this.code(e));
    }
    if (data.byteLength > MAX_OBJECT_BYTES) throw tooBig(loc);
    return data;
  }

  async write(loc: Location, data: Uint8Array, contentType: string | null, overwrite: boolean, uploadParams: Record<string, unknown>) {
    const blob = this.blob(loc);
    const opts: Record<string, unknown> = { ...uploadParams };
    if (contentType && opts.blobHTTPHeaders === undefined) opts.blobHTTPHeaders = { blobContentType: contentType };
    if (!overwrite) opts.conditions = { ifNoneMatch: "*" };
    try {
      await blob.upload(data, data.byteLength, opts);
    } catch (e) {
      throw failure("write", loc, this.code(e));
    }
  }
}

export interface StorageClients {
  s3Client?: S3ClientLike;
  gcsClient?: unknown;
  azureClient?: unknown;
}

/** The storage backend for a location, using the given client or the
 * provider's default credential chain. */
export async function backend(loc: Location, clients: StorageClients): Promise<Backend> {
  if (loc.provider === "s3") {
    const mod = await load("@aws-sdk/client-s3", "Amazon S3");
    return new S3Backend(mod, clients.s3Client ?? new mod.S3Client({}));
  }
  if (loc.provider === "gcs") {
    if (clients.gcsClient) return new GcsBackend(clients.gcsClient);
    const mod = await load("@google-cloud/storage", "Google Cloud Storage");
    return new GcsBackend(new mod.Storage());
  }
  if (clients.azureClient) return new AzureBackend(clients.azureClient);
  const mod = await load("@azure/storage-blob", "Azure Blob Storage");
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (conn) return new AzureBackend(mod.BlobServiceClient.fromConnectionString(conn));
  let identity: any;
  try {
    identity = await import(AZURE_IDENTITY);
  } catch {
    throw new StorageError(`Azure sign-in needs @azure/identity, or set AZURE_STORAGE_CONNECTION_STRING: ${CLOUD_INSTALL}`);
  }
  return new AzureBackend(new mod.BlobServiceClient(`https://${loc.account}.blob.core.windows.net`, new identity.DefaultAzureCredential()));
}

const AZURE_IDENTITY = "@azure/identity";
