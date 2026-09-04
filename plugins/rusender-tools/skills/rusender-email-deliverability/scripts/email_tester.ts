#!/usr/bin/env node

/** Reserve an Email Spam Tester inbox and collect its report safely. */

import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

const DEFAULT_BASE_URL = 'https://email-spam-tester.com';
/**
 * Local data directory shared by every host (Codex, Claude Code, ...).
 * Order: RUSENDER_DELIVERABILITY_DIR, then the legacy Codex location if it
 * already holds data, then ~/.rusender-deliverability.
 */
function dataDirectory(): string {
  const fromEnvironment = process.env.RUSENDER_DELIVERABILITY_DIR?.trim();
  const base = fromEnvironment
    ? resolve(fromEnvironment)
    : existsSync(join(homedir(), '.codex', 'data', 'rusender-email-deliverability'))
      ? join(homedir(), '.codex', 'data')
      : join(homedir(), '.rusender-deliverability');
  return join(base, 'rusender-email-deliverability');
}
const DEFAULT_DATA_DIRECTORY = dataDirectory();

type JsonObject = Record<string, unknown>;

interface Session {
  test_id: string;
  slug: string;
  address: string;
  locale: string;
  created_at: string;
  expires_at: string;
}

interface CliOptions {
  command: 'reserve' | 'status' | 'collect' | 'discard';
  testId?: string;
  locale: string;
  dataDirectory: string;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
  requestTimeoutSeconds: number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(`Email Spam Tester returned HTTP ${status}`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function output(value: JsonObject): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return JSON.stringify({http_status: error.status, response: error.payload});
  }
  return error instanceof Error ? error.message : String(error);
}

function baseUrl(): string {
  return (process.env.RUSENDER_EMAIL_TESTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function fetchJson(
  path: string,
  requestTimeoutSeconds: number,
  init?: RequestInit,
): Promise<JsonObject> {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {Accept: 'application/json', ...(init?.headers ?? {})},
    signal: AbortSignal.timeout(requestTimeoutSeconds * 1000),
  });
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {message: text};
    }
  }
  if (!response.ok) throw new ApiError(response.status, payload);
  if (!isObject(payload)) throw new Error('Email Spam Tester returned a non-object JSON response');
  return payload;
}

async function writePrivateAtomic(path: string, value: JsonObject): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function validateTestId(testId: string): string {
  if (!/^[a-f0-9-]{20,64}$/i.test(testId)) throw new Error('Invalid local test_id');
  return testId;
}

function sessionPath(dataDirectory: string, testId: string): string {
  return join(dataDirectory, 'sessions', `${validateTestId(testId)}.json`);
}

async function readSession(dataDirectory: string, testId: string): Promise<Session> {
  const value: unknown = JSON.parse(await readFile(sessionPath(dataDirectory, testId), 'utf8'));
  if (
    !isObject(value) ||
    typeof value.test_id !== 'string' ||
    typeof value.slug !== 'string' ||
    typeof value.address !== 'string' ||
    typeof value.locale !== 'string' ||
    typeof value.created_at !== 'string' ||
    typeof value.expires_at !== 'string'
  ) {
    throw new Error('Invalid local tester session');
  }
  return value as unknown as Session;
}

async function reserve(options: CliOptions): Promise<void> {
  const response = await fetchJson(
    `/api/v1/inbox?lang=${encodeURIComponent(options.locale)}`,
    options.requestTimeoutSeconds,
    {method: 'POST'},
  );
  const address = typeof response.address === 'string' ? response.address : '';
  const slug = typeof response.slug === 'string' ? response.slug : '';
  const expiresAt = typeof response.expires_at === 'string' ? response.expires_at : '';
  if (!address || !slug || !expiresAt) throw new Error('Invalid inbox reservation response');
  const testId = randomUUID();
  const session: Session = {
    test_id: testId,
    slug,
    address,
    locale: options.locale,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  };
  await writePrivateAtomic(sessionPath(options.dataDirectory, testId), session as unknown as JsonObject);
  output({
    state: 'reserved',
    source: 'Email Spam Tester API v1',
    test_id: testId,
    address,
    expires_at: expiresAt,
  });
}

function cleanStatus(testId: string, response: JsonObject): JsonObject {
  const analysisStatus = response.analysis_status;
  return {
    state:
      analysisStatus === 'checks_ready'
        ? 'ready'
        : analysisStatus === 'failed'
          ? 'failed'
          : 'pending',
    source: 'Email Spam Tester API v1',
    checked_at: new Date().toISOString(),
    test_id: testId,
    analysis_status: analysisStatus ?? null,
    ai_status: response.ai_status ?? null,
    checks_done: response.checks_done ?? null,
    checks_total: response.checks_total ?? null,
  };
}

async function status(options: CliOptions): Promise<void> {
  const testId = options.testId ?? '';
  const session = await readSession(options.dataDirectory, testId);
  try {
    const response = await fetchJson(
      `/api/v1/tests/${encodeURIComponent(session.slug)}/status`,
      options.requestTimeoutSeconds,
    );
    output(cleanStatus(testId, response));
  } catch (error) {
    if (error instanceof ApiError && error.status === 410) {
      output({state: 'expired', source: 'Email Spam Tester API v1', test_id: testId});
      return;
    }
    output({state: 'unknown', source: 'Email Spam Tester API v1', test_id: testId, error: errorMessage(error)});
  }
}

function sanitizeReport(testId: string, report: JsonObject): JsonObject {
  return {
    state: 'ready',
    source: 'Email Spam Tester API v1',
    checked_at: new Date().toISOString(),
    test_id: testId,
    report_url: report.report_url ?? null,
    generated_by: report.generated_by ?? null,
    analysis_status: report.analysis_status ?? null,
    ai_status: report.ai_status ?? null,
    score_compat: report.score_compat ?? null,
    score_ours: report.score_ours ?? null,
    subscores: report.subscores ?? null,
    scoring_version: report.scoring_version ?? null,
    complete: report.complete ?? false,
    errored_checks: report.errored_checks ?? [],
    ai_verdict: report.ai_verdict ?? null,
    ai_confidence: report.ai_confidence ?? null,
    received_at: report.received_at ?? null,
    checks_ready_at: report.checks_ready_at ?? null,
    message: report.message ?? null,
    panel: report.panel ?? [],
    checks: report.checks ?? [],
    fixes: report.fixes ?? [],
    translating: report.translating ?? false,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function collect(options: CliOptions): Promise<void> {
  const testId = options.testId ?? '';
  const session = await readSession(options.dataDirectory, testId);
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastStatus: JsonObject | null = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetchJson(
        `/api/v1/tests/${encodeURIComponent(session.slug)}/status`,
        options.requestTimeoutSeconds,
      );
      lastStatus = cleanStatus(testId, response);
      const analysisStatus = response.analysis_status;
      if (analysisStatus === 'failed') {
        output({...lastStatus, state: 'failed'});
        return;
      }
      if (analysisStatus === 'checks_ready') {
        const report = await fetchJson(
          `/api/v1/tests/${encodeURIComponent(session.slug)}`,
          options.requestTimeoutSeconds,
        );
        output(sanitizeReport(testId, report));
        return;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        output({state: 'expired', source: 'Email Spam Tester API v1', test_id: testId});
        return;
      }
      if (error instanceof ApiError && error.status === 429) {
        output({
          state: 'unavailable',
          source: 'Email Spam Tester API v1',
          test_id: testId,
          error: errorMessage(error),
        });
        return;
      }
      output({state: 'unknown', source: 'Email Spam Tester API v1', test_id: testId, error: errorMessage(error)});
      return;
    }
    await sleep(options.pollIntervalSeconds * 1000);
  }
  output({
    ...(lastStatus ?? {
      source: 'Email Spam Tester API v1',
      checked_at: new Date().toISOString(),
      test_id: testId,
    }),
    state: 'pending',
    reason: 'timeout',
  });
}

async function discard(options: CliOptions): Promise<void> {
  const testId = options.testId ?? '';
  const path = sessionPath(options.dataDirectory, testId);
  if (existsSync(path)) await unlink(path);
  output({state: 'discarded', test_id: testId});
}

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function integer(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseCli(args: string[]): CliOptions {
  let command: CliOptions['command'] | undefined;
  let testId: string | undefined;
  let locale = 'en';
  let dataDirectory = DEFAULT_DATA_DIRECTORY;
  let timeoutSeconds = 300;
  let pollIntervalSeconds = 3;
  let requestTimeoutSeconds = 20;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (['reserve', 'status', 'collect', 'discard'].includes(argument)) {
      if (command) throw new Error('Only one command may be specified');
      command = argument as CliOptions['command'];
    } else if (argument === '--locale') {
      locale = requireValue(args, index, argument);
      index += 1;
    } else if (argument === '--data-dir') {
      dataDirectory = resolve(requireValue(args, index, argument));
      index += 1;
    } else if (argument === '--timeout') {
      timeoutSeconds = Math.max(1, integer(requireValue(args, index, argument), argument));
      index += 1;
    } else if (argument === '--poll-interval') {
      pollIntervalSeconds = Math.max(1, integer(requireValue(args, index, argument), argument));
      index += 1;
    } else if (argument === '--request-timeout') {
      requestTimeoutSeconds = Math.max(1, integer(requireValue(args, index, argument), argument));
      index += 1;
    } else if (!argument.startsWith('-') && command && command !== 'reserve' && !testId) {
      testId = validateTestId(argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!command) throw new Error('Command required: reserve, status, collect, or discard');
  if (command !== 'reserve' && !testId) throw new Error(`${command} requires a test_id`);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale)) throw new Error('Invalid locale');
  return {
    command,
    testId,
    locale,
    dataDirectory,
    timeoutSeconds,
    pollIntervalSeconds,
    requestTimeoutSeconds,
  };
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    if (options.command === 'reserve') await reserve(options);
    else if (options.command === 'status') await status(options);
    else if (options.command === 'collect') await collect(options);
    else await discard(options);
  } catch (error) {
    const state =
      error instanceof ApiError && error.status === 429
        ? 'unavailable'
        : error instanceof ApiError && error.status === 410
          ? 'expired'
          : 'unknown';
    output({state, source: 'Email Spam Tester API v1', error: errorMessage(error)});
  }
}

await main();
