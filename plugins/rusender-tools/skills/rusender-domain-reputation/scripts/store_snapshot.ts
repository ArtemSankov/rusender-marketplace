#!/usr/bin/env node

/** Persist one raw RuSender domain-audit snapshot. */

import {randomBytes} from 'node:crypto';
import {readFile, mkdir, chmod, rename, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

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
const DEFAULT_DATA_DIRECTORY = dataDirectory();

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCli(args: string[]): {snapshot: string; dataDirectory: string} {
  let snapshot = '';
  let dataDirectory = DEFAULT_DATA_DIRECTORY;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--data-dir') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--data-dir requires a value');
      dataDirectory = resolve(value);
      index += 1;
    } else if (!argument.startsWith('-') && !snapshot) {
      snapshot = resolve(argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!snapshot) throw new Error('Snapshot JSON path required');
  return {snapshot, dataDirectory};
}

function fileTimestamp(generatedAt: string): string {
  const date = new Date(generatedAt);
  const value = Number.isNaN(date.getTime()) ? new Date() : date;
  return value.toISOString().replace(/[:.]/g, '-');
}

async function writePrivateAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, contents, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function main(): Promise<void> {
  let options: {snapshot: string; dataDirectory: string};
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  const value: unknown = JSON.parse(await readFile(options.snapshot, 'utf8'));
  if (!isObject(value)) throw new Error('Snapshot must be a JSON object');
  const payload = value;
  const generatedAt =
    typeof payload.generated_at === 'string' && payload.generated_at
      ? payload.generated_at
      : new Date().toISOString();
  payload.generated_at = generatedAt;
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  const historyDirectory = join(options.dataDirectory, 'history');
  const historyPath = join(
    historyDirectory,
    `${fileTimestamp(generatedAt)}-${randomBytes(4).toString('hex')}.json`,
  );
  const latestPath = join(options.dataDirectory, 'latest.json');
  await writePrivateAtomic(historyPath, contents);
  await writePrivateAtomic(latestPath, contents);
  process.stdout.write(`${resolve(historyPath)}\n`);
}

await main();
