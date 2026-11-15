export { PrivConvert, Result, DEFAULT_BASE_URL } from "./client.js";
export type { ClientOptions, FileInput, Params, Job, JobStatus, Usage, Tool } from "./client.js";
export {
  PrivConvertError,
  AuthenticationError,
  BadRequestError,
  FileTooLargeError,
  UnsupportedTypeError,
  ConversionFailedError,
  RateLimitError,
  ConcurrencyLimitError,
  ServerError,
  JobNotFoundError,
  JobExpiredError,
} from "./errors.js";
export { verifyWebhook, WebhookVerificationError } from "./webhooks.js";
export type { VerifyOptions } from "./webhooks.js";
export { VERSION } from "./version.js";
