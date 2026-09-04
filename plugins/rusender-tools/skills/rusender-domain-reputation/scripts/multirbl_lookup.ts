#!/usr/bin/env node

/** Fetch MultiRBL domain/URI-list signals as best-effort JSON. */

import {parse} from 'node-html-parser';

const BASE_URL = 'https://multirbl.valli.org';
const FORM_URL = `${BASE_URL}/index.php`;
const LOOKUP_URL = `${BASE_URL}/json-lookup.php`;
const REPORT_URL = `${BASE_URL}/dnsbl-lookup/`;
const USER_AGENT = 'RuSender-domain-reputation/1.0 (+local best-effort check)';

type JsonObject = Record<string, unknown>;

interface ReportRow {
  rid: string;
  list_id: string;
  name: string;
  zone: string;
}

interface CheckedRow extends ReportRow {
  status: 'listed' | 'not_listed' | 'failed';
  color?: string;
  comments?: unknown;
  a_records?: unknown;
  txt_records?: unknown;
  error?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function postForm(
  url: string,
  data: Record<string, string>,
  timeoutSeconds: number,
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    },
    body: new URLSearchParams(data),
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!response.ok) throw new Error(`MultiRBL returned HTTP ${response.status}`);
  return await response.text();
}

async function startReport(domain: string, timeoutSeconds: number): Promise<{
  sessionHash: string;
  rows: ReportRow[];
}> {
  const page = await postForm(
    FORM_URL,
    {'fd[t]': 'dnsbl-lookup', 'fd[q]': domain, 'fd[submit]': 'Send'},
    timeoutSeconds,
  );
  const sessionHash = /"asessionHash"\s*:\s*"([a-f0-9]+)"/.exec(page)?.[1] ?? '';
  const root = parse(page);
  const rows = root
    .querySelectorAll('tr')
    .filter(row => (row.getAttribute('id') ?? '').startsWith('DNSBLBlacklistTest_'))
    .flatMap(row => {
      const cells = row.querySelectorAll('td').map(cell => cell.textContent.replace(/\s+/g, ' ').trim());
      if (cells.length < 4) return [];
      return [
        {
          rid: row.getAttribute('id') ?? '',
          list_id: cells[0],
          name: cells[2] || 'Unknown list',
          zone: cells[3] || '',
        },
      ];
    });
  if (!sessionHash || !rows.length) {
    throw new Error('MultiRBL report format changed or did not create a lookup session');
  }
  return {sessionHash, rows};
}

async function checkRow(
  sessionHash: string,
  row: ReportRow,
  domain: string,
  timeoutSeconds: number,
): Promise<CheckedRow> {
  try {
    const raw = await postForm(
      LOOKUP_URL,
      {ash: sessionHash, rid: row.rid, lid: row.list_id, q: domain},
      timeoutSeconds,
    );
    const payload: unknown = JSON.parse(raw);
    if (!isObject(payload)) throw new Error('MultiRBL returned invalid JSON');
    const data = isObject(payload.data) ? payload.data : {};
    if (data.failed) {
      return {
        ...row,
        status: 'failed',
        error: typeof data.failed_msg === 'string' ? data.failed_msg : 'MultiRBL check failed',
      };
    }
    return {
      ...row,
      status: data.listed ? 'listed' : 'not_listed',
      color: typeof payload.result_color === 'string' ? payload.result_color : '',
      comments: data.comments_if_listed ?? [],
      a_records: data.a ?? [],
      txt_records: data.txt ?? [],
    };
  } catch (error) {
    return {...row, status: 'failed', error: errorMessage(error)};
  }
}

interface CliOptions {
  domain: string;
  timeout: number;
  workers: number;
  maxChecks: number;
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
  let domain = '';
  let timeout = 20;
  let workers = 4;
  let maxChecks = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--timeout') {
      timeout = Math.max(1, integer(requireValue(args, index, argument), argument));
      index += 1;
    } else if (argument === '--workers') {
      workers = Math.min(6, Math.max(1, integer(requireValue(args, index, argument), argument)));
      index += 1;
    } else if (argument === '--max-checks') {
      maxChecks = Math.max(0, integer(requireValue(args, index, argument), argument));
      index += 1;
    } else if (!argument.startsWith('-') && !domain) {
      domain = argument.toLowerCase().replace(/\.$/, '');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    throw new Error('domain must be a DNS name');
  }
  return {domain, timeout, workers, maxChecks};
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

  const result: {
    source: string;
    report_url: string;
    domain: string;
    state: 'unknown' | 'hits' | 'no_hits';
    listed: CheckedRow[];
    failures: Array<CheckedRow | {error: string}>;
    checked: number;
  } = {
    source: 'MultiRBL',
    report_url: REPORT_URL,
    domain: options.domain,
    state: 'unknown',
    listed: [],
    failures: [],
    checked: 0,
  };

  let report: {sessionHash: string; rows: ReportRow[]};
  try {
    report = await startReport(options.domain, options.timeout);
  } catch (error) {
    result.failures.push({error: errorMessage(error)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const rows = options.maxChecks > 0 ? report.rows.slice(0, options.maxChecks) : report.rows;
  let cursor = 0;
  await Promise.all(
    Array.from({length: Math.min(options.workers, rows.length)}, async () => {
      while (cursor < rows.length) {
        const row = rows[cursor];
        cursor += 1;
        const checked = await checkRow(report.sessionHash, row, options.domain, options.timeout);
        result.checked += 1;
        if (checked.status === 'listed') result.listed.push(checked);
        else if (checked.status === 'failed') result.failures.push(checked);
      }
    }),
  );
  if (result.listed.length) result.state = 'hits';
  else if (result.checked && !result.failures.length) result.state = 'no_hits';
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
