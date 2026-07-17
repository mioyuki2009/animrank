export class HttpError extends Error {
  constructor(message, { status = null, retryAfter = null, cause = null } = {}) {
    super(message, { cause });
    this.name = "HttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(attempt, retryAfter) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }

  return Math.min(750 * 2 ** attempt, 8_000);
}

export async function fetchJson(
  url,
  { attempts = 3, timeoutMs = 15_000, ...options } = {},
) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const retryAfter = response.headers.get("retry-after");

      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        const error = new HttpError(
          `${response.status} ${response.statusText} from ${url}: ${body}`,
          { status: response.status, retryAfter },
        );

        if (![429, 500, 502, 503, 504].includes(response.status)) throw error;
        lastError = error;
      } else {
        return await response.json();
      }
    } catch (error) {
      if (error instanceof HttpError && error.status && error.status !== 429 && error.status < 500) {
        throw error;
      }

      lastError =
        error instanceof HttpError
          ? error
          : new HttpError(`Network error while fetching ${url}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < attempts - 1) {
      await delay(retryDelay(attempt, lastError.retryAfter));
    }
  }

  throw lastError;
}
