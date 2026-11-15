import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivConvertError, STATUS_BY_CODE, StorageError, errorFor } from "./errors.js";
import { exists, loadS3, parseLocation, readObject, show, writeObject, type S3ClientLike } from "./storage.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://privconvert.com/api";

// A single POST accepts up to 100 MB; above this the file goes through the
// chunked upload flow. Parts stay well below the 95 MB per-part ceiling so a
// slow link never holds one request open long enough to time out at the edge.
const DIRECT_LIMIT = 90 * 1024 * 1024;
const CHUNK_SIZE = 20 * 1024 * 1024;

// A Retry-After longer than this means the monthly quota is used up, not a
// momentary limit, so the call fails instead of sleeping.
const MAX_RETRY_WAIT_S = 60;

const TOOL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A file path, a `file:` URL, raw bytes, or a Blob/File. */
export type FileInput = string | URL | Uint8Array | ArrayBuffer | Blob;

export type Params = Record<string, string | number | boolean | object | null | undefined>;

export interface ClientOptions {
  /** Defaults to the PRIVCONVERT_API_KEY environment variable. */
  apiKey?: string;
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 300000. */
  timeoutMs?: number;
  /** Retries on 429/502/503/504 with a short Retry-After. Default 2. */
  maxRetries?: number;
}

export interface Job {
  id: string;
  /** Returned exactly once by the server: store it to download the result and verify webhooks. */
  key: string;
  status: string;
}

export interface JobStatus {
  id: string;
  status: "processing" | "finished" | "failed" | string;
  tool?: string;
  created_at?: number;
  output?: { filename: string; mime: string };
  expires_at?: number;
  error?: { code: string; message: string };
  [k: string]: unknown;
}

export interface Usage {
  tier: string;
  quota: number;
  used: number;
  remaining: number;
  rpm: number;
  max_file_mb: number;
  concurrency: number;
  month_resets_in_s: number;
}

export interface Tool {
  id: string;
  name: string;
  category: string;
  input: string;
  output: string;
  endpoint: string;
  params: { name: string; type: string; default?: unknown }[];
}

/** A converted file, held in memory. */
export class Result {
  constructor(
    readonly content: Buffer,
    readonly filename: string | null,
    readonly contentType: string | null,
    readonly headers: Headers,
  ) {}

  private int(name: string): number | null {
    const v = this.headers.get(name);
    return v && /^\d+$/.test(v) ? parseInt(v, 10) : null;
  }

  get creditsRemaining(): number | null {
    return this.int("x-credits-remaining");
  }
  get convertedCount(): number | null {
    return this.int("x-converted-count");
  }
  get failedCount(): number {
    return this.int("x-failed-count") ?? 0;
  }
  get partial(): boolean {
    return this.headers.has("x-partial-success");
  }
  get sanitizeReport(): Record<string, unknown> | null {
    const v = this.headers.get("x-sanitize-report");
    if (!v) return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }

  /** Write the result to `path`. */
  async save(path: string): Promise<string> {
    await writeFile(path, this.content);
    return path;
  }
}

type FormPart = [name: string, value: string] | [name: string, value: Blob, filename: string];

interface RequestOpts {
  form?: FormPart[];
  headers?: Record<string, string>;
  auth?: boolean;
  job?: boolean;
}

/**
 * Client for the PrivConvert API. Files are read into memory and never
 * written to disk by this package; only `Result.save` writes, and only where
 * you tell it to.
 */
export class PrivConvert {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  #key: string;

  constructor(opts: ClientOptions = {}) {
    const key = (opts.apiKey ?? process.env.PRIVCONVERT_API_KEY ?? "").trim();
    if (!key) throw new PrivConvertError("No API key. Pass { apiKey } or set PRIVCONVERT_API_KEY.");
    if (/[\s\x00-\x1f\x7f]/.test(key)) throw new PrivConvertError("The API key contains invalid characters.");
    this.#key = key;
    this.baseUrl = checkBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? 2));
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `PrivConvert { baseUrl: '${this.baseUrl}' }`;
  }

  // ── conversions ──────────────────────────────────────────────────────

  /**
   * Convert one file. Files above 90 MB are uploaded in parts automatically.
   * `params` are sent as form fields, e.g. `{ quality: 80 }`.
   */
  async convert(tool: string, file: FileInput, opts: { filename?: string; params?: Params } = {}): Promise<Result> {
    const t = checkTool(tool);
    const { name, blob } = await readInput(file, opts.filename);
    if (blob.size > DIRECT_LIMIT) return this.convertChunked(t, name, blob, opts.params ?? {});
    const form: FormPart[] = [...formParams(opts.params ?? {}), ["file", blob, name]];
    return this.requestFile("POST", `/convert/${t}`, { form });
  }

  /**
   * Run one tool over up to 20 files; the result is a ZIP. Check
   * `result.failedCount` / `result.partial`: a batch where some files failed
   * still succeeds with the files that converted.
   */
  async convertBatch(tool: string, files: FileInput[], opts: { params?: Params } = {}): Promise<Result> {
    const t = checkTool(tool);
    if (!files.length) throw new PrivConvertError("convertBatch needs at least one file.");
    if (files.length > 20) throw new PrivConvertError("convertBatch takes at most 20 files per request.");
    const form: FormPart[] = [["tool", t], ...formParams(opts.params ?? {})];
    for (let i = 0; i < files.length; i++) {
      const { name, blob } = await readInput(files[i]);
      form.push(["files", blob, name === "file" ? `file${i + 1}` : name]);
    }
    return this.requestFile("POST", "/convert-batch", { form });
  }

  /**
   * Convert a file in cloud storage and write the result back to storage.
   *
   * `source` and `destination` are `s3://bucket/key` locations. The file moves
   * between your bucket and PrivConvert from wherever this code runs, using your
   * own AWS credentials (the default AWS SDK chain, or `s3Client`). Your
   * credentials are never sent to PrivConvert. Needs `@aws-sdk/client-s3`.
   *
   * `uploadParams` go to `PutObject`, e.g. `{ ServerSideEncryption: "aws:kms" }`.
   * With `overwrite: false` an existing destination is left untouched and a
   * `StorageError` is thrown before any credit is spent.
   */
  async convertStorage(
    tool: string,
    source: string,
    destination: string,
    opts: { params?: Params; s3Client?: S3ClientLike; overwrite?: boolean; uploadParams?: Record<string, unknown> } = {},
  ): Promise<Result> {
    const t = checkTool(tool);
    const src = parseLocation(source);
    const dst = parseLocation(destination);
    const overwrite = opts.overwrite ?? true;
    const mod = await loadS3();
    const client = opts.s3Client ?? new mod.S3Client({});
    if (!overwrite && (await exists(mod, client, dst))) {
      throw new StorageError(`${show(dst)} already exists.`, { code: "DestinationExists" });
    }
    const data = await readObject(mod, client, src);
    const result = await this.convert(t, data, { filename: basename(src.key), params: opts.params });
    await writeObject(mod, client, dst, result.content, result.contentType, { overwrite, uploadParams: opts.uploadParams });
    return result;
  }

  // ── async jobs ───────────────────────────────────────────────────────

  /** Submit an async job. Returns at once with the job id and one-time key. */
  async submitJob(
    tool: string,
    file: FileInput,
    opts: { filename?: string; webhookUrl?: string; params?: Params } = {},
  ): Promise<Job> {
    const t = checkTool(tool);
    const { name, blob } = await readInput(file, opts.filename);
    const form: FormPart[] = formParams(opts.params ?? {});
    if (opts.webhookUrl) {
      if (!String(opts.webhookUrl).startsWith("https://")) throw new PrivConvertError("webhookUrl must be an https:// URL.");
      form.push(["webhook_url", String(opts.webhookUrl)]);
    }
    form.push(["file", blob, name]);
    const body = await this.requestJson<Record<string, unknown>>("POST", `/jobs/${t}`, { form });
    if (typeof body.id !== "string" || typeof body.key !== "string") {
      throw new PrivConvertError("Unexpected response when submitting the job.");
    }
    const job = { id: body.id, status: String(body.status ?? "processing") } as Job;
    Object.defineProperty(job, "key", { value: body.key, enumerable: false });
    return job;
  }

  async getJob(job: string | Job): Promise<JobStatus> {
    return this.requestJson<JobStatus>("GET", `/jobs/${checkJobId(job)}`, { job: true });
  }

  async downloadJob(job: Job): Promise<Result> {
    return this.requestFile("GET", `/jobs/${checkJobId(job)}/download`, { headers: { "X-Job-Key": job.key }, job: true });
  }

  async deleteJob(job: string | Job): Promise<void> {
    await this.request("DELETE", `/jobs/${checkJobId(job)}`, { job: true });
  }

  /**
   * Poll until the job finishes, then download the result. Throws the same
   * error a synchronous call would have thrown if the job failed. With
   * `deleteAfter` (default) the stored result is wiped right after download.
   */
  async wait(
    job: Job,
    opts: { pollIntervalMs?: number; timeoutMs?: number; deleteAfter?: boolean } = {},
  ): Promise<Result> {
    const deadline = Date.now() + (opts.timeoutMs ?? 1_800_000);
    let interval = Math.max(500, opts.pollIntervalMs ?? 2000);
    for (;;) {
      const st = await this.getJob(job);
      if (st.status === "finished") break;
      if (st.status === "failed") {
        const code = st.error?.code;
        throw errorFor(STATUS_BY_CODE[code ?? ""] ?? 422, st.error?.message ?? "The conversion failed.", code, undefined);
      }
      if (Date.now() + interval > deadline) throw new PrivConvertError(`Job ${job.id} did not finish in time.`);
      await sleep(interval);
      interval = Math.min(interval * 1.5, 10_000);
    }
    const result = await this.downloadJob(job);
    if (opts.deleteAfter ?? true) {
      await this.deleteJob(job).catch(() => undefined);
    }
    return result;
  }

  // ── account & catalog ────────────────────────────────────────────────

  /** Your plan, monthly quota and current usage. */
  async me(): Promise<Usage> {
    return this.requestJson<Usage>("GET", "/me");
  }

  /** The public catalog of every tool, optionally filtered by category. */
  async tools(category?: string): Promise<Tool[]> {
    const q = category ? `?category=${encodeURIComponent(category)}` : "";
    const body = await this.requestJson<{ tools?: Tool[] }>("GET", `/tools${q}`, { auth: false });
    return body.tools ?? [];
  }

  // ── internals ────────────────────────────────────────────────────────

  private async convertChunked(tool: string, name: string, blob: Blob, params: Params): Promise<Result> {
    const total = Math.ceil(blob.size / CHUNK_SIZE);
    const init = await this.requestJson<{ upload_id?: string }>("POST", "/upload-init", {
      form: [
        ["total_size", String(blob.size)],
        ["total_chunks", String(total)],
        ["filename", name],
        ["tool", tool],
      ],
    });
    const uploadId = init.upload_id;
    if (!uploadId) throw new PrivConvertError("The server did not return an upload id.");
    for (let i = 0; i < total; i++) {
      await this.requestJson("POST", "/upload-chunk", {
        form: [
          ["upload_id", uploadId],
          ["chunk_index", String(i)],
          ["file", blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), "chunk"],
        ],
      });
    }
    return this.requestFile("POST", "/convert-chunked", { form: [["upload_id", uploadId], ...formParams(params)] });
  }

  private async requestFile(method: string, path: string, opts: RequestOpts): Promise<Result> {
    const res = await this.request(method, path, opts);
    const buf = Buffer.from(await res.arrayBuffer());
    return new Result(buf, filenameFrom(res.headers.get("content-disposition") ?? ""), res.headers.get("content-type"), res.headers);
  }

  private async requestJson<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    const text = await res.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new PrivConvertError("The server returned a response that is not JSON.", { status: res.status });
    }
  }

  private async request(method: string, path: string, opts: RequestOpts = {}): Promise<Response> {
    const headers: Record<string, string> = { "User-Agent": `privconvert-node/${VERSION}`, Accept: "*/*", ...opts.headers };
    if (opts.auth !== false) headers.Authorization = `Bearer ${this.#key}`;
    for (let attempt = 0; ; attempt++) {
      let body: FormData | undefined;
      if (opts.form) {
        body = new FormData();
        for (const p of opts.form) {
          if (p.length === 3) body.append(p[0], p[1], safeName(p[2]));
          else body.append(p[0], p[1]);
        }
      }
      let res: Response;
      try {
        res = await fetch(this.baseUrl + path, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new PrivConvertError(`Could not reach PrivConvert: ${reason}`);
      }
      if (res.ok) return res;
      const raw = await res.text().catch(() => "");
      const { message, code } = parseError(raw, res.status);
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const retryable = [429, 502, 503, 504].includes(res.status);
      const wait = retryAfter ?? Math.min(2 * 2 ** attempt, 20);
      if (retryable && attempt < this.maxRetries && wait <= MAX_RETRY_WAIT_S) {
        await sleep(wait * 1000);
        continue;
      }
      throw errorFor(res.status, message, code, retryAfter, opts.job ?? false);
    }
  }
}

function checkBaseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(String(url).replace(/\/+$/, ""));
  } catch {
    throw new PrivConvertError("baseUrl is not a valid URL.");
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    return u.toString().replace(/\/+$/, "");
  }
  throw new PrivConvertError("baseUrl must use https:// so the API key is never sent in clear text.");
}

function checkTool(tool: string): string {
  const t = String(tool ?? "").trim().toLowerCase();
  if (!TOOL_RE.test(t)) throw new PrivConvertError(`Invalid tool id: ${JSON.stringify(tool)}`);
  return t;
}

function checkJobId(job: string | Job): string {
  const id = typeof job === "string" ? job : job?.id;
  if (!id || !JOB_ID_RE.test(id)) throw new PrivConvertError("Invalid job id.");
  return id;
}

async function readInput(file: FileInput, filename?: string): Promise<{ name: string; blob: Blob }> {
  if (typeof file === "string" || file instanceof URL) {
    const path = file instanceof URL ? fileURLToPath(file) : file;
    const data = await readFile(path);
    return { name: filename || basename(path) || "file", blob: new Blob([data]) };
  }
  if (file instanceof Blob) {
    const own = (file as Blob & { name?: unknown }).name;
    return { name: filename || (typeof own === "string" && own) || "file", blob: file };
  }
  if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
    return { name: filename || "file", blob: new Blob([file as BlobPart]) };
  }
  throw new PrivConvertError("file must be a path, a file: URL, bytes, or a Blob.");
}

function formParams(params: Params): FormPart[] {
  const out: FormPart[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    out.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  }
  return out;
}

function safeName(s: string): string {
  return s.replace(/[\r\n"\\]/g, "_").slice(0, 255) || "file";
}

function parseError(raw: string, status: number): { message: string; code?: string } {
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === "object") {
      if (body.error && typeof body.error === "object") {
        return { message: String(body.error.message ?? `HTTP ${status}`), code: body.error.code };
      }
      if (typeof body.detail === "string") return { message: body.detail, code: body.code };
      if (body.detail && typeof body.detail === "object") {
        return { message: String(body.detail.message ?? `HTTP ${status}`), code: body.detail.code };
      }
    }
  } catch {
    /* not JSON */
  }
  return { message: `HTTP ${status}` };
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function filenameFrom(cd: string): string | null {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return basename(decodeURIComponent(star[1]));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? basename(plain[1]) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
