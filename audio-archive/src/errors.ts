/** HTTP status carried by an AWS SDK error (`$metadata.httpStatusCode`), if any. */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) return undefined;
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

/**
 * Log fields that make a failure diagnosable. AWS SDK errors often carry a
 * vague message ("UnknownError"), so the error name and HTTP status matter.
 */
export function errorFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = { error: String(error) };
  if (error instanceof Error) {
    fields.errorName = error.name;
    const code = codeOf(error) ?? codeOf(error.cause);
    if (code) fields.errorCode = code;
    if (error.cause !== undefined) fields.cause = String(error.cause);
  }
  const status = httpStatusOf(error) ?? httpStatusOf(error instanceof Error ? error.cause : undefined);
  if (status !== undefined) fields.httpStatusCode = status;
  return fields;
}

/** The message plus its cause's message, e.g. "fetch failed (unexpected redirect)". */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

/** A Node/system error code such as ECONNRESET, if any. */
function codeOf(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}
