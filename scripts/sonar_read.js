import { setTimeout as sleep } from 'node:timers/promises';

const READ_BUDGET_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export function readOptions(configuration, dependencies) {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  return {
    ...dependencies,
    monotonicNow,
    sleepImpl: dependencies.sleepImpl ?? sleep,
    random: dependencies.random ?? Math.random,
    hostUrl: configuration.hostUrl,
    token: configuration.token,
    deadline: monotonicNow() + READ_BUDGET_MS
  };
}

function remainingBudget(options) {
  const remaining = Math.floor(options.deadline - options.monotonicNow());
  if (remaining <= 0) throw new Error('SonarCloud exceeded the 60-second read budget.');
  return remaining;
}

function retryDelay(response, attempt, options) {
  const backoff = 250 * 2 ** (attempt - 1) + Math.floor(Math.min(1, Math.max(0, options.random())) * 100);
  const value = response?.headers.get('retry-after');
  if (!value) return backoff;
  const milliseconds = /^\d+$/u.test(value.trim())
    ? Number(value) * 1_000 : Date.parse(value) - options.now().getTime();
  return Number.isFinite(milliseconds) ? Math.max(backoff, milliseconds) : backoff;
}

async function request(url, options) {
  const remaining = remainingBudget(options);
  try {
    const response = await options.fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(Math.min(30_000, remaining))
    });
    remainingBudget(options);
    if (!response.ok) return { response };
    const body = await response.text();
    remainingBudget(options);
    return { response, body };
  } catch (error) {
    remainingBudget(options);
    if (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name)) return { networkFailure: true };
    throw new Error('SonarCloud read failed before a valid response.', { cause: error });
  }
}

function parseObject(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('SonarCloud returned invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SonarCloud returned an invalid JSON object.');
  }
  return parsed;
}

export async function sonarGet(endpoint, parameters, options) {
  const url = new URL(endpoint, options.hostUrl);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await request(url, options);
    if (result.response?.ok) return parseObject(result.body);
    const status = result.response?.status;
    if (!result.networkFailure && !RETRY_STATUSES.has(status)) {
      throw new Error(`SonarCloud read failed with HTTP ${status}.`);
    }
    await result.response?.body?.cancel();
    if (attempt === MAX_ATTEMPTS) throw new Error('SonarCloud read failed after 3 attempts.');
    const delay = retryDelay(result.response, attempt, options);
    if (delay >= remainingBudget(options)) throw new Error('SonarCloud retry would exceed the 60-second read budget.');
    await options.sleepImpl(delay);
  }
}
