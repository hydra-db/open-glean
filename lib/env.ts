/**
 * Environment validation, checked once at boot.
 *
 * Without this check, a misconfigured deployment reports healthy, passes any
 * smoke test that does not authenticate, and fails deep inside a request.
 *
 * `checkEnv` is pure, so tests can call it. `reportEnv` runs it and logs.
 *
 * An error marks something that will not work. A warning marks something that
 * will behave in a surprising way. Neither throws at import time, because
 * crashing a running deployment over a warning is worse than the
 * misconfiguration.
 */

export interface EnvReport {
  errors: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function isHttps(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

export function checkEnv(env: Env = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const secret = env.OPEN_GLEAN_SESSION_SECRET;
  if (env.NODE_ENV === "production") {
    if (!secret) {
      errors.push(
        "OPEN_GLEAN_SESSION_SECRET is required in production. It encrypts the key session cookie and signs the browser subject; without it, both are unusable.",
      );
    } else if (secret.length < 16) {
      errors.push("OPEN_GLEAN_SESSION_SECRET must be at least 16 characters.");
    }
  }

  const hydraBase = env.HYDRA_BASE_URL?.trim();
  if (hydraBase && !isHttps(hydraBase)) {
    errors.push(
      `HYDRA_BASE_URL must be a valid https URL (got "${hydraBase}"). The API key travels in an Authorization header.`,
    );
  }

  const mongoUri = env.MONGODB_URI?.trim();
  if (mongoUri?.startsWith("https://") && !env.MONGODB_PROXY_KEY?.trim()) {
    warnings.push(
      "MONGODB_URI looks like a Lambda proxy endpoint but MONGODB_PROXY_KEY is not set, so the app will try to connect directly and fail. Note the Lambda reads the same secret as PROXY_KEY — the two names must hold the same value.",
    );
  }

  const llmKey = env.OPENROUTER_API_KEY?.trim();
  const llmModel = env.OPEN_GLEAN_LLM_MODEL?.trim();
  if (llmKey && !llmModel) {
    warnings.push(
      "OPENROUTER_API_KEY is set but OPEN_GLEAN_LLM_MODEL is not. Search will work and answer synthesis will not, which reads as the app being half broken.",
    );
  }

  if (env.OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL === "true") {
    warnings.push(
      "OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL is on. Plaintext http is permitted to private addresses for local models. Do not set this in a deployment that reaches the internet.",
    );
  }

  return { errors, warnings };
}

/** Run the checks and log them. Called once, from the root layout. */
export function reportEnv(): EnvReport {
  const report = checkEnv();
  for (const w of report.warnings) console.warn(`[env] ${w}`);
  for (const e of report.errors) console.error(`[env] ${e}`);
  return report;
}
