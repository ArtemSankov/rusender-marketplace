#!/usr/bin/env node

// plugins/rusender-domain-reputation/skills/rusender-email-deliverability/scripts/store_result.ts
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
function dataDirectory() {
  const fromEnvironment = process.env.RUSENDER_DELIVERABILITY_DIR?.trim();
  const base = fromEnvironment ? resolve(fromEnvironment) : existsSync(join(homedir(), ".codex", "data", "rusender-email-deliverability")) ? join(homedir(), ".codex", "data") : join(homedir(), ".rusender-deliverability");
  return join(base, "rusender-email-deliverability");
}
var DEFAULT_DATA_DIRECTORY = dataDirectory();
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseCli(args) {
  let result = "";
  let dataDirectory2 = DEFAULT_DATA_DIRECTORY;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--data-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--data-dir requires a value");
      dataDirectory2 = resolve(value);
      index += 1;
    } else if (!argument.startsWith("-") && !result) {
      result = resolve(argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!result) throw new Error("Result JSON path required");
  return { result, dataDirectory: dataDirectory2 };
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
function assertNoCapabilities(value) {
  const forbidden = /* @__PURE__ */ new Set([
    "slug",
    "report_url",
    "recipient",
    "raw_source",
    "raw_headers",
    "html",
    "test_address",
    "checker_address",
    "recipient_email",
    "to_email"
  ]);
  const leaky = [/@email-spam-tester\.com/i, /email-spam-tester\.com\/(?:report|tests|r)\//i, /^test-[a-z0-9]{16,}@/i];
  const visit = (item) => {
    if (typeof item === "string") {
      if (leaky.some((pattern) => pattern.test(item))) {
        throw new Error("Result contains the checker address or report link; remove it before storing");
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isObject(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) throw new Error(`Result contains forbidden capability field ${key}`);
      visit(child);
    }
  };
  visit(value);
}
async function main() {
  const options = parseCli(process.argv.slice(2));
  const value = JSON.parse(await readFile(options.result, "utf8"));
  if (!isObject(value)) throw new Error("Result must be a JSON object");
  assertNoCapabilities(value);
  const generatedAt = typeof value.generated_at === "string" && value.generated_at ? value.generated_at : (/* @__PURE__ */ new Date()).toISOString();
  value.generated_at = generatedAt;
  const contents = `${JSON.stringify(value, null, 2)}
`;
  const historyPath = join(
    options.dataDirectory,
    "history",
    `${fileTimestamp(generatedAt)}-${randomBytes(4).toString("hex")}.json`
  );
  const latestPath = join(options.dataDirectory, "latest.json");
  await writePrivateAtomic(historyPath, contents);
  await writePrivateAtomic(latestPath, contents);
  process.stdout.write(`${resolve(historyPath)}
`);
}
try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 2;
}
