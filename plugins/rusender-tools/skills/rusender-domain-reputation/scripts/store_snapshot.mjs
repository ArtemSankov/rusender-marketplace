#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// plugins/rusender-domain-reputation/skills/rusender-domain-reputation/scripts/store_snapshot.ts
import { randomBytes } from "node:crypto";
import { readFile, mkdir, chmod, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
function dataDirectory() {
  const fromEnvironment = process.env.RUSENDER_DELIVERABILITY_DIR?.trim();
  if (fromEnvironment) return resolve(fromEnvironment);
  const legacy = join(homedir(), ".codex", "data", "rusender-deliverability");
  if (existsSync(legacy)) return legacy;
  return join(homedir(), ".rusender-deliverability");
}
var DEFAULT_DATA_DIRECTORY = dataDirectory();
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseCli(args) {
  let snapshot = "";
  let dataDirectory2 = DEFAULT_DATA_DIRECTORY;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--data-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--data-dir requires a value");
      dataDirectory2 = resolve(value);
      index += 1;
    } else if (!argument.startsWith("-") && !snapshot) {
      snapshot = resolve(argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!snapshot) throw new Error("Snapshot JSON path required");
  return { snapshot, dataDirectory: dataDirectory2 };
}
function fileTimestamp(generatedAt) {
  const date = new Date(generatedAt);
  const value = Number.isNaN(date.getTime()) ? /* @__PURE__ */ new Date() : date;
  return value.toISOString().replace(/[:.]/g, "-");
}
async function writePrivateAtomic(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 384, flag: "wx" });
  await chmod(temporary, 384);
  await rename(temporary, path);
  await chmod(path, 384);
}
async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 2;
    return;
  }
  const value = JSON.parse(await readFile(options.snapshot, "utf8"));
  if (!isObject(value)) throw new Error("Snapshot must be a JSON object");
  const payload = value;
  const generatedAt = typeof payload.generated_at === "string" && payload.generated_at ? payload.generated_at : (/* @__PURE__ */ new Date()).toISOString();
  payload.generated_at = generatedAt;
  const contents = `${JSON.stringify(payload, null, 2)}
`;
  const historyDirectory = join(options.dataDirectory, "history");
  const historyPath = join(
    historyDirectory,
    `${fileTimestamp(generatedAt)}-${randomBytes(4).toString("hex")}.json`
  );
  const latestPath = join(options.dataDirectory, "latest.json");
  await writePrivateAtomic(historyPath, contents);
  await writePrivateAtomic(latestPath, contents);
  process.stdout.write(`${resolve(historyPath)}
`);
}
await main();
