/** Stable errors surfaced by the Hydra SDK path. */

export class HydraWrapperError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    opts: { code: string; status?: number; context?: Record<string, unknown> } = {
      code: "HYDRA_ERROR",
    },
  ) {
    super(message);
    this.name = "HydraWrapperError";
    this.code = opts.code;
    this.status = opts.status;
    this.context = opts.context;
  }
}

export function responseError(status: number, detail: unknown): HydraWrapperError {
  const body = detail as { detail?: unknown; message?: unknown; error?: unknown };
  const raw =
    (typeof body?.detail === "string" && body.detail) ||
    (typeof body?.message === "string" && body.message) ||
    (typeof body?.error === "string" && body.error) ||
    // Deliberately NOT JSON.stringify(detail): error responses often echo the
    // request, so serializing the whole body could put the submitted API key
    // into a message that reaches the client. Prefer a generic string; the
    // detail is still logged server-side by the callers.
    `Hydra request failed (${status}).`;
  return new HydraWrapperError(String(raw), {
    code: "HYDRA_HTTP_ERROR",
    status,
  });
}

/** Translate any thrown SDK/transport error into a stable host error. */
export function translateError(path: string, err: unknown): HydraWrapperError {
  const lookup = err as {
    name?: string;
    code?: string;
    status?: number;
    message?: string;
    body?: unknown;
  };
  if (lookup?.name === "HydraWrapperError") return lookup as HydraWrapperError;
  // Abort first. An aborted request that also carries a status was reported as
  // a server error, so a user cancelling a slow query saw a failure rather
  // than the cancellation they asked for.
  if (lookup?.code === "ABORT_ERR" || lookup?.name === "AbortError") {
    return new HydraWrapperError("The request timed out.", {
      code: "HYDRA_TIMEOUT",
      context: { path },
    });
  }
  if (typeof lookup?.status === "number" && lookup.status >= 400) {
    return responseError(lookup.status, lookup.body ?? lookup.message);
  }
  return new HydraWrapperError(
    lookup?.message ?? "Hydra request failed.",
    { code: "HYDRA_ERROR", context: { path } },
  );
}