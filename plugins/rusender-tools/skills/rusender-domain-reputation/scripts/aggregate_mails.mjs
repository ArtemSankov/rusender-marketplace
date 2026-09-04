#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// plugins/rusender-domain-reputation/skills/rusender-domain-reputation/scripts/aggregate_mails.ts
import { readFile } from "node:fs/promises";
var COUNTERS = [
  "all",
  "delivered",
  "opened",
  "clicked",
  "error",
  "soft_bounced",
  "hard_bounced",
  "complaint",
  "unsubscribed",
  "in_flight"
];
var PROVIDERS = [
  {
    id: "mailru",
    label: "Mail.ru (VK)",
    domains: ["mail.ru", "bk.ru", "list.ru", "inbox.ru", "internet.ru", "vk.com", "mail.ua"]
  },
  {
    id: "yandex",
    label: "\u042F\u043D\u0434\u0435\u043A\u0441",
    domains: ["ya.ru", "narod.ru", "yandex.ru", "yandex.com", "yandex.by", "yandex.kz", "yandex.ua", "yandex.uz"]
  },
  { id: "gmail", label: "Gmail", domains: ["gmail.com", "googlemail.com"] },
  {
    id: "microsoft",
    label: "Outlook / Hotmail",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "hotmail.ru", "live.ru"],
    suffixes: ["outlook.", "hotmail."]
  },
  {
    id: "rambler",
    label: "Rambler",
    domains: ["rambler.ru", "lenta.ru", "autorambler.ru", "myrambler.ru", "ro.ru", "rambler.ua"]
  },
  { id: "apple", label: "iCloud", domains: ["icloud.com", "me.com", "mac.com"] }
];
function emptyCounters() {
  return Object.fromEntries(COUNTERS.map((name) => [name, 0]));
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function emailDomain(value) {
  if (typeof value !== "string") return "";
  const at = value.lastIndexOf("@");
  return (at >= 0 ? value.slice(at + 1) : value).trim().toLowerCase().replace(/\.$/, "");
}
function providerOf(domain) {
  for (const provider of PROVIDERS) {
    if (provider.domains.includes(domain)) return provider;
    if (provider.suffixes?.some((suffix) => domain.startsWith(suffix))) return provider;
  }
  return { id: "other", label: "\u0414\u0440\u0443\u0433\u0438\u0435 / \u043A\u043E\u0440\u043F\u043E\u0440\u0430\u0442\u0438\u0432\u043D\u044B\u0435" };
}
function statusCounter(status) {
  switch (status) {
    case "delivered":
    case "opened":
    case "clicked":
    case "error":
    case "soft_bounced":
    case "hard_bounced":
    case "complaint":
    case "unsubscribed":
      return status;
    case "sending":
    case "pending":
      return "in_flight";
    default:
      return null;
  }
}
var REACHED = ["delivered", "opened", "clicked", "complaint", "unsubscribed"];
function bump(target, counter) {
  target.all += 1;
  target[counter] += 1;
  if (counter !== "delivered" && REACHED.includes(counter)) target.delivered += 1;
}
function rates(counters) {
  const attempted = counters.all - counters.in_flight;
  const ratio = (value, base) => base > 0 ? Number((value / base).toFixed(4)) : null;
  return {
    delivered_rate: ratio(counters.delivered, attempted),
    hard_bounce_rate: ratio(counters.hard_bounced, attempted),
    soft_bounce_rate: ratio(counters.soft_bounced, attempted),
    error_rate: ratio(counters.error, attempted),
    complaint_rate: ratio(counters.complaint, counters.delivered),
    unsubscribe_rate: ratio(counters.unsubscribed, counters.delivered)
  };
}
function addMail(aggregate, item, senderDomain) {
  if (senderDomain && emailDomain(item.fromEmail) !== senderDomain) {
    aggregate.skipped += 1;
    return;
  }
  const counter = statusCounter(item.status);
  if (!counter) {
    const key = typeof item.status === "string" ? item.status : "missing";
    aggregate.unknownStatuses.set(key, (aggregate.unknownStatuses.get(key) ?? 0) + 1);
    return;
  }
  bump(aggregate.totals, counter);
  const created = typeof item.createdAt === "string" ? new Date(item.createdAt) : /* @__PURE__ */ new Date(NaN);
  const day = Number.isNaN(created.getTime()) ? "unknown" : created.toISOString().slice(0, 10);
  const dayCounters = aggregate.daily.get(day) ?? emptyCounters();
  bump(dayCounters, counter);
  aggregate.daily.set(day, dayCounters);
  const recipientDomain = emailDomain(item.recipient ?? item.toEmail ?? item.email);
  const provider = providerOf(recipientDomain);
  const entry = aggregate.providers.get(provider.id) ?? {
    label: provider.label,
    counters: emptyCounters(),
    domains: /* @__PURE__ */ new Map()
  };
  bump(entry.counters, counter);
  if (recipientDomain) entry.domains.set(recipientDomain, (entry.domains.get(recipientDomain) ?? 0) + 1);
  aggregate.providers.set(provider.id, entry);
  if (typeof item.keyId === "number") aggregate.keyIds.add(item.keyId);
  const fromDomain = emailDomain(item.fromEmail);
  if (fromDomain) aggregate.fromDomains.add(fromDomain);
}
var CAMPAIGN_FIELDS = [
  [["sent", "all", "total", "count"], "all"],
  [["delivered"], "delivered"],
  [["opened", "opens"], "opened"],
  [["clicked", "clicks"], "clicked"],
  [["error", "errors", "failed"], "error"],
  [["softBounced", "soft_bounced", "softBounce"], "soft_bounced"],
  [["hardBounced", "hard_bounced", "hardBounce"], "hard_bounced"],
  [["complaint", "complaints", "spam"], "complaint"],
  [["unsubscribed", "unsubscribes"], "unsubscribed"]
];
function addCampaignRow(providers, row) {
  const recipientDomain = emailDomain(row.domain ?? row.recipientDomain ?? row.name);
  if (!recipientDomain) return false;
  const provider = providerOf(recipientDomain);
  const entry = providers.get(provider.id) ?? {
    label: provider.label,
    counters: emptyCounters(),
    domains: /* @__PURE__ */ new Map()
  };
  let matched = false;
  for (const [names, counter] of CAMPAIGN_FIELDS) {
    for (const name of names) {
      const value = row[name];
      if (typeof value === "number" && Number.isFinite(value)) {
        entry.counters[counter] += value;
        matched = true;
        break;
      }
    }
  }
  if (!matched) return false;
  entry.domains.set(recipientDomain, (entry.domains.get(recipientDomain) ?? 0) + entry.counters.all);
  providers.set(provider.id, entry);
  return true;
}
function extractRows(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  for (const key of ["items", "data", "domains", "stats", "result"]) {
    const nested = payload[key];
    if (Array.isArray(nested)) return nested.filter(isObject);
    if (isObject(nested)) {
      const deeper = extractRows(nested);
      if (deeper.length) return deeper;
    }
  }
  return [];
}
function providerRows(providers) {
  return [...providers.entries()].map(([id, entry]) => ({
    provider: id,
    label: entry.label,
    ...entry.counters,
    rates: rates(entry.counters),
    top_domains: id === "other" ? [...entry.domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([domain, count]) => ({ domain, count })) : void 0
  })).sort((a, b) => b.all - a.all);
}
var MIN_SAMPLE = 100;
var MIN_PROVIDER_SAMPLE = 50;
var THRESHOLDS = {
  complaint: { attention: 1e-3, critical: 3e-3 },
  hardBounce: { attention: 0.02, critical: 0.05 },
  softBounce: { attention: 0.05, critical: 0.1 },
  error: { attention: 0.02, critical: 0.05 },
  delivered: { attention: 0.97, critical: 0.9 }
};
var worse = (a, b) => {
  const order = ["unknown", "healthy", "attention", "critical"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
};
function grade(value, limits, higherIsWorse = true) {
  if (value === null) return "unknown";
  if (higherIsWorse) return value >= limits.critical ? "critical" : value >= limits.attention ? "attention" : "healthy";
  return value <= limits.critical ? "critical" : value <= limits.attention ? "attention" : "healthy";
}
function pct(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)} %`;
}
function rateOf(counters, key) {
  const attempted = counters.all - counters.in_flight;
  if (key === "complaint") return counters.delivered > 0 ? counters.complaint / counters.delivered : null;
  return attempted > 0 ? counters[key] / attempted : null;
}
function sum(rows) {
  const total = emptyCounters();
  for (const row of rows) for (const key of COUNTERS) total[key] += row[key];
  return total;
}
function evaluate(aggregate, daily) {
  const signals = [];
  const totals = aggregate.totals;
  const attempted = totals.all - totals.in_flight;
  const sufficient = attempted >= MIN_SAMPLE;
  if (attempted === 0) {
    return {
      sending_state: "unknown",
      sample_sufficient: false,
      signals: [{ id: "no_traffic", state: "unknown", metric: "attempted", value: 0, threshold: `>= ${MIN_SAMPLE}`, scope: "period", detail: "No completed sends in the period; sending reputation cannot be assessed.", weight: 0 }]
    };
  }
  if (!sufficient) {
    signals.push({ id: "low_sample", state: "attention", metric: "attempted", value: attempted, threshold: `>= ${MIN_SAMPLE}`, scope: "period", detail: `Only ${attempted} completed sends; rates below are indicative, not statistically meaningful.`, weight: 0 });
  }
  const overall = [
    ["complaint_rate", "complaint", THRESHOLDS.complaint, true],
    ["hard_bounce_rate", "hard_bounced", THRESHOLDS.hardBounce, true],
    ["soft_bounce_rate", "soft_bounced", THRESHOLDS.softBounce, true],
    ["error_rate", "error", THRESHOLDS.error, true],
    ["delivered_rate", "delivered", THRESHOLDS.delivered, false]
  ];
  for (const [id, key, limits, higherIsWorse] of overall) {
    const value = rateOf(totals, key);
    signals.push({
      id,
      state: grade(value, limits, higherIsWorse),
      metric: id,
      value,
      threshold: higherIsWorse ? `attention >= ${pct(limits.attention)}, critical >= ${pct(limits.critical)}` : `attention <= ${pct(limits.attention)}, critical <= ${pct(limits.critical)}`,
      scope: "period",
      detail: `${id} over the period is ${pct(value)} (${totals[key]} of ${key === "complaint" ? totals.delivered : attempted}).`,
      weight: 1
    });
  }
  const accountHard = rateOf(totals, "hard_bounced") ?? 0;
  const accountComplaint = rateOf(totals, "complaint") ?? 0;
  for (const [id, entry] of aggregate.providers) {
    const c = entry.counters;
    const providerAttempted = c.all - c.in_flight;
    if (providerAttempted < MIN_PROVIDER_SAMPLE) continue;
    const hard = rateOf(c, "hard_bounced");
    const complaint = rateOf(c, "complaint");
    const hardState = grade(hard, THRESHOLDS.hardBounce);
    const complaintState = grade(complaint, THRESHOLDS.complaint);
    const deviates = hard !== null && hard >= Math.max(0.01, accountHard * 2) || complaint !== null && complaint >= Math.max(5e-4, accountComplaint * 2);
    const state2 = deviates ? worse("attention", worse(hardState, complaintState)) : worse(hardState, complaintState);
    if (state2 === "healthy") continue;
    signals.push({
      id: `provider_${id}`,
      state: state2,
      metric: "provider_hard_bounce_rate/complaint_rate",
      value: hard,
      threshold: ">= 2x account average or absolute thresholds",
      scope: entry.label,
      detail: `${entry.label}: hard bounce ${pct(hard)}, complaints ${pct(complaint)} over ${providerAttempted} sends (account: ${pct(accountHard)} / ${pct(accountComplaint)}).`,
      weight: 1
    });
  }
  const series = daily.map((row) => row);
  if (series.length >= 14) {
    const recent = sum(series.slice(-7));
    const previous = sum(series.slice(-14, -7));
    const recentAttempted = recent.all - recent.in_flight;
    const previousAttempted = previous.all - previous.in_flight;
    if (recentAttempted >= MIN_PROVIDER_SAMPLE && previousAttempted >= MIN_PROVIDER_SAMPLE) {
      for (const [id, key] of [["hard_bounce_trend", "hard_bounced"], ["complaint_trend", "complaint"]]) {
        const now = rateOf(recent, key) ?? 0;
        const before = rateOf(previous, key) ?? 0;
        if (now > before * 1.5 && now - before >= (key === "complaint" ? 5e-4 : 5e-3)) {
          signals.push({ id, state: grade(now, key === "complaint" ? THRESHOLDS.complaint : THRESHOLDS.hardBounce) === "critical" ? "critical" : "attention", metric: id, value: now, threshold: "> 1.5x previous 7 days", scope: "last 7 days", detail: `${key} rate rose from ${pct(before)} to ${pct(now)} week over week.`, weight: 1 });
        }
      }
      if (recentAttempted >= previousAttempted * 3 && recentAttempted >= 1e3) {
        signals.push({ id: "volume_spike", state: "attention", metric: "attempted_7d", value: recentAttempted, threshold: ">= 3x previous 7 days", scope: "last 7 days", detail: `Volume jumped from ${previousAttempted} to ${recentAttempted} messages week over week; sudden growth hurts reputation, especially on young domains.`, weight: 1 });
      }
    }
  }
  const badDays = series.filter((day) => {
    const a = day.all - day.in_flight;
    return a >= MIN_PROVIDER_SAMPLE && (day.hard_bounced / a >= THRESHOLDS.hardBounce.critical || day.delivered > 0 && day.complaint / day.delivered >= THRESHOLDS.complaint.critical);
  });
  if (badDays.length) {
    signals.push({ id: "bad_days", state: "attention", metric: "days_over_critical", value: badDays.length, threshold: "any day over critical thresholds", scope: "daily", detail: `Days with critical bounce or complaint levels: ${badDays.map((day) => day.date).join(", ")}.`, weight: 1 });
  }
  let state = "healthy";
  for (const signal of signals) if (signal.weight > 0) state = worse(state, signal.state);
  if (!sufficient && state === "critical") state = "attention";
  return { sending_state: state, sample_sufficient: sufficient, signals };
}
function parseCli(args) {
  const options = { files: [], senderDomain: "" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === "--domain") options.senderDomain = value().toLowerCase();
    else if (argument === "--from") options.from = value();
    else if (argument === "--to") options.to = value();
    else if (!argument.startsWith("-")) options.files.push(argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.files.length) throw new Error("At least one JSON file with MCP output is required");
  return options;
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
  const mails = {
    totals: emptyCounters(),
    daily: /* @__PURE__ */ new Map(),
    providers: /* @__PURE__ */ new Map(),
    keyIds: /* @__PURE__ */ new Set(),
    fromDomains: /* @__PURE__ */ new Set(),
    skipped: 0,
    unknownStatuses: /* @__PURE__ */ new Map()
  };
  const campaignProviders = /* @__PURE__ */ new Map();
  let campaignRows = 0;
  let mailRows = 0;
  for (const file of options.files) {
    const payload = JSON.parse(await readFile(file, "utf8"));
    for (const row of extractRows(payload)) {
      if ("status" in row && ("recipient" in row || "toEmail" in row || "fromEmail" in row)) {
        addMail(mails, row, options.senderDomain);
        mailRows += 1;
      } else if (addCampaignRow(campaignProviders, row)) {
        campaignRows += 1;
      }
    }
  }
  const days = [...mails.daily.keys()].filter((day) => day !== "unknown").sort();
  const dateFrom = options.from ?? days[0] ?? null;
  const dateTo = options.to ?? days.at(-1) ?? null;
  const daily = [];
  if (dateFrom && dateTo) {
    for (let cursor = new Date(dateFrom); cursor <= new Date(dateTo); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const day = cursor.toISOString().slice(0, 10);
      daily.push({ date: day, ...mails.daily.get(day) ?? emptyCounters() });
    }
  }
  const result = {
    source: "scripts/aggregate_mails.mjs over RuSender MCP responses",
    checked_at: (/* @__PURE__ */ new Date()).toISOString(),
    sender_domain: options.senderDomain || null,
    period: { from: dateFrom, to: dateTo },
    external_mail: mailRows > 0 ? {
      rows: mailRows,
      skipped_other_sender_domains: mails.skipped,
      unknown_statuses: Object.fromEntries(mails.unknownStatuses),
      key_ids: [...mails.keyIds].sort((a, b) => a - b),
      from_domains: [...mails.fromDomains].sort(),
      totals: { ...mails.totals, rates: rates(mails.totals) },
      daily,
      undated: mails.daily.get("unknown") ?? null,
      by_provider: providerRows(mails.providers),
      assessment: evaluate(mails, daily)
    } : { state: "unknown", note: "No external-mail rows found in the supplied files." },
    campaigns: campaignRows > 0 ? { rows: campaignRows, by_provider: providerRows(campaignProviders) } : { state: "unknown", note: "No campaign domain-stat rows found in the supplied files." }
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
}
await main();
