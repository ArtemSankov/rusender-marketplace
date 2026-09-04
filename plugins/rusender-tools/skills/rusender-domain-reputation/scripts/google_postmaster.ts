#!/usr/bin/env node

/**
 * Connect to Google Postmaster Tools and collect domain-only Gmail signals.
 *
 * The product distributor supplies one Desktop OAuth client. End users only
 * approve the read-only Postmaster traffic scope in their browser.
 */

import {createServer, type Server} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile, rename, chmod, mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir, platform} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

import {
  auth,
  gmailpostmastertools,
  type gmailpostmastertools_v2,
} from '@googleapis/gmailpostmastertools';
import {CodeChallengeMethod} from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/postmaster.traffic.readonly';
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SKILL_DIRECTORY = resolve(SCRIPT_DIRECTORY, '..');
/**
 * Local data directory shared by every host (Codex, Claude Code, ...).
 * Order: RUSENDER_DELIVERABILITY_DIR, then the legacy Codex location if it
 * already holds data, then ~/.rusender-deliverability.
 */
function dataDirectory(): string {
  const fromEnvironment = process.env.RUSENDER_DELIVERABILITY_DIR?.trim();
  if (fromEnvironment) return resolve(fromEnvironment);
  const legacy = join(homedir(), '.codex', 'data', 'rusender-deliverability');
  if (existsSync(legacy)) return legacy;
  return join(homedir(), '.rusender-deliverability');
}
const DEFAULT_TOKEN = join(dataDirectory(), 'google-postmaster-token.json');
const DEFAULT_CLIENT = join(SKILL_DIRECTORY, 'config', 'google-postmaster-oauth.json');

type JsonObject = Record<string, unknown>;
type OAuthClient = InstanceType<typeof auth.OAuth2>;
type OAuthCredentials = Parameters<OAuthClient['setCredentials']>[0];

interface ClientConfig {
  clientId: string;
  clientSecret?: string;
}

interface CliOptions {
  command: 'status' | 'connect' | 'collect';
  clientConfig?: string;
  token: string;
  timeout: number;
  locale: string;
  noBrowser: boolean;
  domain?: string;
  days: number;
}

interface CallbackResult {
  code?: string;
  error?: string;
}

function output(data: JsonObject): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadJson(path: string): Promise<JsonObject> {
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isObject(data)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return data;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function loadClientConfig(path?: string): Promise<ClientConfig | null> {
  const environmentClientId = optionalString(process.env.RUSENDER_GOOGLE_CLIENT_ID);
  if (environmentClientId) {
    return {
      clientId: environmentClientId,
      clientSecret: optionalString(process.env.RUSENDER_GOOGLE_CLIENT_SECRET),
    };
  }

  const candidate = path ? resolve(path) : DEFAULT_CLIENT;
  if (!existsSync(candidate)) return null;

  const data = await loadJson(candidate);
  const source = isObject(data.installed) ? data.installed : data;
  const clientId = optionalString(source.client_id);
  if (!clientId) throw new Error('OAuth client configuration has no client_id');
  return {clientId, clientSecret: optionalString(source.client_secret)};
}

function normalizeCredentials(data: JsonObject): OAuthCredentials {
  const legacyExpiry = optionalNumber(data.expires_at);
  return {
    access_token: optionalString(data.access_token),
    refresh_token: optionalString(data.refresh_token),
    token_type: optionalString(data.token_type),
    scope: optionalString(data.scope),
    expiry_date:
      optionalNumber(data.expiry_date) ??
      (legacyExpiry === undefined ? undefined : legacyExpiry * 1000),
  };
}

function credentialJson(credentials: OAuthCredentials): JsonObject {
  const result: JsonObject = {};
  for (const key of [
    'access_token',
    'refresh_token',
    'token_type',
    'scope',
    'expiry_date',
  ] as const) {
    const value = credentials[key];
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

async function savePrivate(path: string, data: JsonObject): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600});
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function createOAuthClient(
  config: ClientConfig,
  redirectUri?: string,
): OAuthClient {
  return new auth.OAuth2({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri,
  });
}

async function authorizedClient(
  config: ClientConfig,
  tokenPath: string,
): Promise<{client: OAuthClient; credentials: OAuthCredentials}> {
  const stored = normalizeCredentials(await loadJson(tokenPath));
  let credentials: OAuthCredentials = stored;
  const client = createOAuthClient(config);
  client.setCredentials(credentials);
  client.on('tokens', tokens => {
    credentials = {
      ...credentials,
      ...tokens,
      refresh_token: tokens.refresh_token ?? credentials.refresh_token,
    };
    void savePrivate(tokenPath, credentialJson(credentials));
  });
  return {client, credentials};
}

function safeError(error: unknown): string {
  if (!isObject(error)) return error instanceof Error ? error.message : String(error);
  const response = isObject(error.response) ? error.response : undefined;
  const status = response ? response.status : undefined;
  const responseData = response ? response.data : undefined;
  if (status !== undefined || responseData !== undefined) {
    return JSON.stringify({http_status: status, response: responseData});
  }
  return optionalString(error.message) ?? String(error);
}

function callbackPage(ok: boolean, locale: string): string {
  const russian = locale.toLowerCase().startsWith('ru');
  const message = russian
    ? ok
      ? 'Google Postmaster подключён. Можно вернуться к отчёту.'
      : 'Не удалось подключить Google Postmaster. Вернитесь к отчёту для подробностей.'
    : ok
      ? 'Google Postmaster is connected. You can return to the report.'
      : 'Google Postmaster could not be connected. Return to the report for details.';
  return `<!doctype html><meta charset="utf-8"><title>Google Postmaster</title><body style="font:16px system-ui;padding:40px"><h1>${message}</h1></body>`;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a local OAuth callback port');
  }
  return address.port;
}

function openBrowser(url: string): void {
  const system = platform();
  const command = system === 'darwin' ? 'open' : system === 'win32' ? 'cmd' : 'xdg-open';
  const args = system === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {detached: true, stdio: 'ignore', windowsHide: true});
  child.once('error', () => undefined);
  child.unref();
}

async function connect(
  config: ClientConfig,
  tokenPath: string,
  timeoutSeconds: number,
  locale: string,
  noBrowser: boolean,
): Promise<void> {
  const state = randomBytes(24).toString('base64url');
  let settleCallback: ((result: CallbackResult) => void) | undefined;
  const callback = new Promise<CallbackResult>(resolvePromise => {
    settleCallback = resolvePromise;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const receivedState = requestUrl.searchParams.get('state') ?? '';
    let result: CallbackResult;
    if (receivedState !== state) {
      result = {error: 'state_mismatch'};
    } else if (requestUrl.searchParams.has('error')) {
      result = {error: requestUrl.searchParams.get('error') ?? 'authorization_failed'};
    } else {
      const code = requestUrl.searchParams.get('code') ?? '';
      result = code ? {code} : {error: 'authorization_code_missing'};
    }
    const ok = Boolean(result.code);
    const body = callbackPage(ok, locale);
    response.writeHead(ok ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    response.end(body);
    settleCallback?.(result);
    settleCallback = undefined;
  });

  const port = await listen(server);
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = createOAuthClient(config, redirectUri);
  const {codeVerifier, codeChallenge} = await client.generateCodeVerifierAsync();
  const authorizationUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  output({state: 'pending', authorization_url: authorizationUrl, expires_in: timeoutSeconds});
  if (!noBrowser) openBrowser(authorizationUrl);

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      callback,
      new Promise<CallbackResult>((_, rejectPromise) => {
        timer = setTimeout(
          () => rejectPromise(new Error('OAuth authorization timed out')),
          timeoutSeconds * 1000,
        );
      }),
    ]);
    if (result.error) throw new Error(`OAuth authorization failed: ${result.error}`);
    const tokenResponse = await client.getToken({
      code: result.code ?? '',
      codeVerifier,
      redirect_uri: redirectUri,
    });
    const credentials = tokenResponse.tokens;
    if (!credentials.refresh_token) {
      throw new Error('Google did not return a refresh token; reconnect and approve access');
    }
    await savePrivate(tokenPath, credentialJson(credentials));
    output({
      state: 'connected',
      scope: credentials.scope ?? SCOPE,
      token_path: resolve(tokenPath),
    });
  } finally {
    if (timer) clearTimeout(timer);
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
}

function metricDefinitions(): gmailpostmastertools_v2.Schema$MetricDefinition[] {
  return [
    {name: 'spam_rate', baseMetric: {standardMetric: 'SPAM_RATE'}},
    {
      name: 'spf_success_rate',
      baseMetric: {standardMetric: 'AUTH_SUCCESS_RATE'},
      filter: 'auth_type = "spf"',
    },
    {
      name: 'dkim_success_rate',
      baseMetric: {standardMetric: 'AUTH_SUCCESS_RATE'},
      filter: 'auth_type = "dkim"',
    },
    {
      name: 'dmarc_success_rate',
      baseMetric: {standardMetric: 'AUTH_SUCCESS_RATE'},
      filter: 'auth_type = "dmarc"',
    },
    {
      name: 'inbound_tls_rate',
      baseMetric: {standardMetric: 'TLS_ENCRYPTION_RATE'},
      filter: 'traffic_direction = "inbound"',
    },
    {name: 'delivery_error_rate', baseMetric: {standardMetric: 'DELIVERY_ERROR_RATE'}},
  ];
}

function dateParts(value: Date): gmailpostmastertools_v2.Schema$Date {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function collect(
  config: ClientConfig,
  tokenPath: string,
  domain: string,
  days: number,
): Promise<void> {
  const {client, credentials} = await authorizedClient(config, tokenPath);
  const api = gmailpostmastertools({version: 'v2', auth: client});
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - Math.max(1, days) + 1);

  const evidence: JsonObject = {
    state: 'connected',
    source: 'Google Postmaster Tools API v2',
    checked_at: new Date().toISOString(),
    scope: credentials.scope ?? SCOPE,
    domain,
    period: {from: isoDate(start), to: isoDate(end)},
    compliance: null,
    metrics: [],
    error: null,
  };

  try {
    const complianceResponse = await api.domains.getComplianceStatus({
      name: `domains/${domain}/complianceStatus`,
    });
    evidence.compliance = complianceResponse.data;

    let pageToken: string | undefined;
    const metrics: gmailpostmastertools_v2.Schema$DomainStat[] = [];
    do {
      const requestBody: gmailpostmastertools_v2.Schema$QueryDomainStatsRequest = {
        parent: `domains/${domain}`,
        timeQuery: {
          dateRanges: {
            dateRanges: [{start: dateParts(start), end: dateParts(end)}],
          },
        },
        metricDefinitions: metricDefinitions(),
        aggregationGranularity: 'DAILY',
        pageSize: 200,
        ...(pageToken ? {pageToken} : {}),
      };
      const response = await api.domains.domainStats.query({
        parent: `domains/${domain}`,
        requestBody,
      });
      metrics.push(...(response.data.domainStats ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    evidence.metrics = metrics;
    evidence.checked_at = new Date().toISOString();
    evidence.data_available = metrics.length > 0 || evidence.compliance !== null;
    evidence.note = evidence.data_available
      ? null
      : 'Google returned no data for this period; traffic may be below Postmaster thresholds.';
  } catch (error) {
    evidence.state = 'unknown';
    evidence.error = safeError(error);
  }
  output(evidence);
}

async function status(config: ClientConfig | null, tokenPath: string): Promise<void> {
  if (!config) {
    output({state: 'unavailable', reason: 'product_oauth_client_not_configured'});
    return;
  }
  if (!existsSync(tokenPath)) {
    output({state: 'not_connected'});
    return;
  }
  try {
    const {client, credentials} = await authorizedClient(config, tokenPath);
    const expiryDate = credentials.expiry_date ?? 0;
    if (!credentials.access_token || expiryDate <= Date.now() + 60_000) {
      await client.getAccessToken();
    }
    output({state: 'connected', scope: credentials.scope ?? SCOPE});
  } catch (error) {
    output({state: 'unknown', error: safeError(error)});
  }
}

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function parseCli(args: string[]): CliOptions {
  let command: CliOptions['command'] | undefined;
  const options: Omit<CliOptions, 'command'> = {
    token: DEFAULT_TOKEN,
    timeout: 300,
    locale: 'en',
    noBrowser: false,
    days: 30,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === 'status' || argument === 'connect' || argument === 'collect') {
      if (command) throw new Error('Only one command may be specified');
      command = argument;
    } else if (argument === '--client-config') {
      options.clientConfig = requireValue(args, index, argument);
      index += 1;
    } else if (argument === '--token') {
      options.token = resolve(requireValue(args, index, argument));
      index += 1;
    } else if (argument === '--timeout') {
      options.timeout = Math.max(30, parseInteger(requireValue(args, index, argument), argument));
      index += 1;
    } else if (argument === '--locale') {
      options.locale = requireValue(args, index, argument);
      index += 1;
    } else if (argument === '--days') {
      options.days = Math.min(120, Math.max(1, parseInteger(requireValue(args, index, argument), argument)));
      index += 1;
    } else if (argument === '--no-browser') {
      options.noBrowser = true;
    } else if (!argument.startsWith('-') && command === 'collect' && !options.domain) {
      options.domain = argument.toLowerCase().replace(/\.$/, '');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!command) throw new Error('Command required: status, connect, or collect');
  if (command === 'collect' && !options.domain) throw new Error('collect requires a domain');
  return {...options, command};
}

function validDomain(domain: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    domain,
  );
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 2;
    return;
  }

  let config: ClientConfig | null;
  try {
    config = await loadClientConfig(options.clientConfig);
  } catch (error) {
    output({state: 'unavailable', reason: 'invalid_product_oauth_client', error: safeError(error)});
    return;
  }

  if (options.command === 'status') {
    await status(config, options.token);
    return;
  }
  if (!config) {
    output({state: 'unavailable', reason: 'product_oauth_client_not_configured'});
    return;
  }
  if (options.command === 'connect') {
    try {
      await connect(config, options.token, options.timeout, options.locale, options.noBrowser);
    } catch (error) {
      output({state: 'unknown', error: safeError(error)});
    }
    return;
  }

  const domain = options.domain ?? '';
  if (!validDomain(domain)) {
    process.stderr.write('domain must be a DNS name\n');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(options.token)) {
    output({state: 'not_connected'});
    return;
  }
  await collect(config, options.token, domain, options.days);
}

await main();
