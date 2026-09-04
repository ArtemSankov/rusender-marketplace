#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// plugins/rusender-domain-reputation/skills/rusender-domain-reputation/scripts/domain_probe.ts
import { randomBytes } from "node:crypto";
import { getServers } from "node:dns";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import { createConnection } from "node:net";
import { domainToASCII } from "node:url";
var TYPE_CODES = { MX: 15, TXT: 16, DS: 43 };
var PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
function utcNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function encodeName(name) {
  const labels = name.replace(/\.$/, "").split(".");
  const parts = [];
  for (const label of labels) {
    const encoded = Buffer.from(label, "ascii");
    if (encoded.length < 1 || encoded.length > 63) throw new Error("invalid DNS label");
    parts.push(Buffer.from([encoded.length]), encoded);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function readName(packet, initialOffset, seen = /* @__PURE__ */ new Set()) {
  const labels = [];
  let offset = initialOffset;
  let nextOffset = offset;
  let jumped = false;
  while (true) {
    if (offset >= packet.length) throw new Error("truncated DNS name");
    const length = packet[offset];
    if ((length & 192) === 192) {
      if (offset + 1 >= packet.length) throw new Error("truncated DNS pointer");
      const pointer = (length & 63) << 8 | packet[offset + 1];
      if (seen.has(pointer)) throw new Error("DNS compression loop");
      seen.add(pointer);
      if (!jumped) {
        nextOffset = offset + 2;
        jumped = true;
      }
      const [suffix] = readName(packet, pointer, seen);
      if (suffix) labels.push(suffix);
      break;
    }
    if (length === 0) {
      offset += 1;
      if (!jumped) nextOffset = offset;
      break;
    }
    offset += 1;
    const end = offset + length;
    if (end > packet.length) throw new Error("truncated DNS label");
    labels.push(packet.subarray(offset, end).toString("ascii"));
    offset = end;
  }
  return [labels.join("."), nextOffset];
}
function makeQuery(name, recordType) {
  const id = randomBytes(2).readUInt16BE(0);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(256, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  const questionTail = Buffer.alloc(4);
  questionTail.writeUInt16BE(TYPE_CODES[recordType], 0);
  questionTail.writeUInt16BE(1, 2);
  const opt = Buffer.alloc(11);
  opt[0] = 0;
  opt.writeUInt16BE(41, 1);
  opt.writeUInt16BE(1232, 3);
  opt.writeUInt32BE(0, 5);
  opt.writeUInt16BE(0, 9);
  return { id, packet: Buffer.concat([header, encodeName(name), questionTail, opt]) };
}
function resolverAddress(value) {
  const plain = value.split("%", 1)[0];
  if (isIP(plain)) return { address: plain, port: 53 };
  const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(value);
  if (bracketed && isIP(bracketed[1])) {
    return { address: bracketed[1], port: Number(bracketed[2]) };
  }
  const ipv4Port = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(value);
  if (ipv4Port && isIP(ipv4Port[1])) {
    return { address: ipv4Port[1], port: Number(ipv4Port[2]) };
  }
  return null;
}
async function exchangeUdp(resolver, query, timeoutMs) {
  const target = resolverAddress(resolver);
  if (!target) throw new Error("resolver must be an IP address");
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createSocket(isIP(target.address) === 6 ? "udp6" : "udp4");
    let settled = false;
    const finish = (error, packet) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) rejectPromise(error);
      else resolvePromise(packet ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => finish(new Error("DNS request timed out")), timeoutMs);
    socket.once("error", (error) => finish(error));
    socket.once("message", (packet) => finish(void 0, packet));
    socket.send(query, target.port, target.address, (error) => {
      if (error) finish(error);
    });
  });
}
async function exchangeTcp(resolver, query, timeoutMs) {
  const target = resolverAddress(resolver);
  if (!target) throw new Error("resolver must be an IP address");
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host: target.address, port: target.port, family: isIP(target.address) });
    const chunks = [];
    let received = 0;
    let expected;
    let settled = false;
    const finish = (error, packet) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(packet ?? Buffer.alloc(0));
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("DNS TCP request timed out")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([length, query]));
    });
    socket.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      received += buffer.length;
      const combined = Buffer.concat(chunks, received);
      if (expected === void 0 && combined.length >= 2) expected = combined.readUInt16BE(0);
      if (expected !== void 0 && combined.length >= expected + 2) {
        finish(void 0, combined.subarray(2, expected + 2));
      }
    });
    socket.once("end", () => {
      if (!settled) finish(new Error("truncated DNS TCP response"));
    });
  });
}
function parseDns(packet, queryId, recordType) {
  if (packet.length < 12) throw new Error("truncated DNS header");
  const responseId = packet.readUInt16BE(0);
  const flags = packet.readUInt16BE(2);
  const questionCount = packet.readUInt16BE(4);
  const answerCount = packet.readUInt16BE(6);
  if (responseId !== queryId) throw new Error("mismatched DNS response ID");
  let offset = 12;
  for (let index = 0; index < questionCount; index += 1) {
    [, offset] = readName(packet, offset);
    offset += 4;
  }
  const records = [];
  for (let index = 0; index < answerCount; index += 1) {
    [, offset] = readName(packet, offset);
    if (offset + 10 > packet.length) throw new Error("truncated DNS record");
    const rrType = packet.readUInt16BE(offset);
    const length = packet.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    const end = dataOffset + length;
    if (end > packet.length) throw new Error("truncated DNS record data");
    if (rrType === TYPE_CODES[recordType]) {
      if (recordType === "TXT") {
        const chunks = [];
        let cursor = dataOffset;
        while (cursor < end) {
          const size = packet[cursor];
          cursor += 1;
          if (cursor + size > end) throw new Error("truncated DNS TXT string");
          chunks.push(packet.subarray(cursor, cursor + size).toString("utf8"));
          cursor += size;
        }
        records.push(chunks.join(""));
      } else if (recordType === "MX") {
        if (length < 3) throw new Error("truncated DNS MX record");
        const preference = packet.readUInt16BE(dataOffset);
        const [host] = readName(packet, dataOffset + 2);
        records.push(`${preference} ${host}.`);
      } else {
        if (length < 4) throw new Error("truncated DNS DS record");
        const keyTag = packet.readUInt16BE(dataOffset);
        const algorithm = packet[dataOffset + 2];
        const digestType = packet[dataOffset + 3];
        const digest = packet.subarray(dataOffset + 4, end).toString("hex").toUpperCase();
        records.push(`${keyTag} ${algorithm} ${digestType} ${digest}`);
      }
    }
    offset = end;
  }
  return { rcode: flags & 15, truncated: Boolean(flags & 512), records };
}
function systemResolvers() {
  const resolvers = [];
  for (const resolver of [...getServers(), ...PUBLIC_RESOLVERS]) {
    if (resolverAddress(resolver) && !resolvers.includes(resolver)) resolvers.push(resolver);
  }
  return resolvers;
}
async function dnsQuery(name, recordType, timeoutMs, resolvers) {
  const errors = [];
  for (const resolver of resolvers) {
    const checkedAt = utcNow();
    try {
      const query = makeQuery(name, recordType);
      let packet = await exchangeUdp(resolver, query.packet, timeoutMs);
      let parsed = parseDns(packet, query.id, recordType);
      if (parsed.truncated) {
        packet = await exchangeTcp(resolver, query.packet, timeoutMs);
        parsed = parseDns(packet, query.id, recordType);
      }
      if (parsed.rcode === 0 || parsed.rcode === 3) {
        return {
          state: parsed.records.length ? "present" : "absent",
          records: parsed.records,
          source: "DNS",
          resolver,
          checked_at: checkedAt,
          rcode: parsed.rcode
        };
      }
      errors.push(`${resolver}: DNS rcode ${parsed.rcode}`);
    } catch (error) {
      errors.push(`${resolver}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    state: "unknown",
    records: [],
    source: "DNS",
    checked_at: utcNow(),
    error: errors.join("; ")
  };
}
function txtMatches(record, prefix) {
  const normalized = record.trim().toLowerCase();
  if (prefix === "v=dkim1") {
    const tags = normalized.split(";").map((tag) => tag.trim());
    const hasKey = tags.some((tag) => /^p=/.test(tag));
    const versionTag = tags.find((tag) => /^v=/.test(tag));
    return hasKey && (!versionTag || versionTag === "v=dkim1");
  }
  return normalized.startsWith(prefix.toLowerCase());
}
function filterTxt(result, prefix) {
  if (result.state === "unknown") return result;
  const sourceRecords = Array.isArray(result.records) ? result.records : [];
  const records = sourceRecords.filter(
    (record) => typeof record === "string" && txtMatches(record, prefix)
  );
  return { ...result, records, state: records.length ? "present" : "absent" };
}
async function whoisRequest(server, query, timeoutMs) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host: server, port: 43 });
    const chunks = [];
    let received = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(Buffer.concat(chunks, received).toString("utf8"));
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("WHOIS request timed out")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${query}\r
`));
    socket.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = 1e6 - received;
      if (remaining <= 0) return finish();
      chunks.push(buffer.subarray(0, remaining));
      received += Math.min(buffer.length, remaining);
      if (received >= 1e6) finish();
    });
    socket.once("end", () => finish());
  });
}
function fieldLines(text) {
  const fields = /* @__PURE__ */ new Map();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!key || !value) continue;
    fields.set(key, [...fields.get(key) ?? [], value]);
  }
  return fields;
}
function first(fields, keys) {
  for (const key of keys) {
    const value = fields.get(key)?.[0];
    if (value) return value;
  }
  return null;
}
async function registrationQuery(domain, timeoutMs) {
  const checkedAt = utcNow();
  try {
    const tld = domain.split(".").at(-1) ?? "";
    const ianaFields = fieldLines(await whoisRequest("whois.iana.org", tld, timeoutMs));
    const server = first(ianaFields, ["refer", "whois"]);
    if (!server) throw new Error("IANA did not return a registry WHOIS server");
    const registryFields = fieldLines(await whoisRequest(server, domain, timeoutMs));
    return {
      state: "present",
      created: first(registryFields, [
        "created",
        "creation date",
        "created on",
        "registration time",
        "registered on"
      ]),
      expires: first(registryFields, [
        "paid-till",
        "registry expiry date",
        "expiration date",
        "expiry date",
        "expires on"
      ]),
      registrar: first(registryFields, ["registrar", "sponsoring registrar"]),
      source: `WHOIS protocol via ${server}`,
      checked_at: checkedAt
    };
  } catch (error) {
    return {
      state: "unknown",
      source: "registry WHOIS protocol",
      checked_at: checkedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
function requireValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function parseCli(args) {
  let domain = "";
  const selectors = [];
  const resolvers = [];
  let timeoutMs = 4e3;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dkim-selector") {
      selectors.push(requireValue(args, index, argument));
      index += 1;
    } else if (argument === "--resolver") {
      resolvers.push(requireValue(args, index, argument));
      index += 1;
    } else if (argument === "--timeout") {
      const value = Number(requireValue(args, index, argument));
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout must be positive");
      timeoutMs = value * 1e3;
      index += 1;
    } else if (!argument.startsWith("-") && !domain) {
      domain = argument;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!domain) throw new Error("Domain required");
  const asciiDomain = domainToASCII(domain.trim().replace(/\.$/, "")).toLowerCase();
  if (!asciiDomain || !asciiDomain.includes(".")) throw new Error("Invalid domain");
  return { domain: asciiDomain, selectors, resolvers, timeoutMs };
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
  const requests = [
    ["spf", options.domain, "TXT", "v=spf1"],
    ["dmarc", `_dmarc.${options.domain}`, "TXT", "v=dmarc1"],
    ["bimi", `default._bimi.${options.domain}`, "TXT", "v=bimi1"],
    ["mta_sts", `_mta-sts.${options.domain}`, "TXT", "v=stsv1"],
    ["tls_rpt", `_smtp._tls.${options.domain}`, "TXT", "v=tlsrptv1"],
    ["mx", options.domain, "MX"],
    ["dnssec", options.domain, "DS"],
    ...options.selectors.map(
      (selector) => [`dkim:${selector}`, `${selector}._domainkey.${options.domain}`, "TXT", "v=dkim1"]
    )
  ];
  const resolvers = options.resolvers.length ? options.resolvers : systemResolvers();
  const entries = await Promise.all(
    requests.map(async ([key, name, recordType, prefix]) => {
      const result2 = await dnsQuery(name, recordType, options.timeoutMs, resolvers);
      return [key, prefix ? filterTxt(result2, prefix) : result2];
    })
  );
  const result = {
    domain: options.domain,
    checked_at: utcNow(),
    checks: Object.fromEntries(entries),
    registration: await registrationQuery(options.domain, options.timeoutMs)
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
}
await main();
