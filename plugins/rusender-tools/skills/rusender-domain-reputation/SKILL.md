---
name: rusender-domain-reputation
description: Audit the health and deliverability reputation of domains connected to RuSender. Use when a user asks to check RuSender domains, domain reputation, DNS authentication, sending trends, complaints, bounces, domain age, Google Postmaster status, or to build a local domain-reputation dashboard. Excludes all sending-IP, HELO, PTR, FCrDNS, and IP-DNSBL checks.
---

# RuSender domain reputation

Use this skill for a domain-level audit only. It does not test a particular email; use the separate email-testing skill for that workflow.

## Guardrails

- Treat RuSender MCP as the source of truth for the user's domains, senders, campaign volumes, and sending statistics.
- Keep the audit read-only. Do not create, delete, re-verify, change, send, or schedule anything in RuSender.
- Never inspect or report sending IPs. Do not run IP DNSBL, PTR, HELO, FCrDNS, or IP-reputation checks: RuSender infrastructure is shared and can change per message.
- Use MultiRBL only as a best-effort public-report scraper through `scripts/multirbl_lookup.mjs`. It is not an API and its response must never establish that a domain is clean. Apply a per-domain timeout, do not retry aggressively, and mark unavailable or incomplete checks as `unknown`.
- Mark an unavailable integration as `unknown`, never as a failure. Do not call Google Postmaster `not_connected` unless an explicit connector-health check establishes it. Google Postmaster is optional and has traffic thresholds.
- Keep API keys, OAuth tokens, recipient data, and raw campaign content out of snapshots and the dashboard.
- Never ask an end user to create a Google Cloud project or OAuth client. The plugin distributor configures one product-owned Desktop OAuth client; the end user only approves read-only Google Postmaster access.
- Detect the language of the user's request before collecting data. Use that language for the generated dashboard, recommendations, status explanations, and final response. Raw protocol values such as DNS records remain unchanged.
- Do not depend on OS-specific DNS or registration executables. Never require `dig`, `whois`, `host`, `nslookup`, PowerShell DNS cmdlets, or `curl`, and do not use DNS-over-HTTPS. Use the bundled `scripts/domain_probe.mjs`, which performs direct DNS and registry WHOIS protocol queries with Node.js built-ins.

## Hosts and tool names

The skill runs unchanged in Codex and Claude Code. RuSender MCP tools are referred to below by their bare names (`public_domains_list`, `public_external_mails_list`, ...); the host prefixes them itself (`mcp__rusender__public_domains_list` in Claude Code, the server-qualified name in Codex). Write files with whatever file-writing tool the host provides (`apply_patch` in Codex, `Write`/`Edit` in Claude Code). All scripts are plain Node.js 20+ and need no host features. Local data lives in `$RUSENDER_DELIVERABILITY_DIR`, else in `~/.codex/data/rusender-deliverability` when it already exists, else in `~/.rusender-deliverability`; both hosts share it, so history and the Postmaster token carry over.

## Workflow

1. Call `public_domains_list` and use only domains returned for the current account. If the user names a domain, resolve it from this list; do not accept an unrelated domain.
2. For each selected domain, collect its RuSender verification status and DNS-record warnings from the domain response. Take the DKIM selector from `dnsRecords.dkim.host` (the label before `._domainkey.`) and the expected SPF/DKIM/DMARC values from `dnsRecords.*.data`; compare them with what the public probe observes. Use `public_domains_get_by_id` only when the list response lacks needed read-only fields.
3. Collect sending signals separately:
   - campaign volume and campaign-domain performance with `public_campaigns_get_stats_by_domains`;
   - SMTP and transactional-mail history with `public_external_mails_list` for the audit period (`dateFrom`/`dateTo`, `limit` 100, follow `hasMore`). Save each page verbatim to a temporary JSON file and run

     ```bash
     node scripts/aggregate_mails.mjs page1.json page2.json --domain <domain> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
     ```

     It returns totals, a per-day series and a mailbox-provider breakdown (Mail.ru, Яндекс, Gmail, Outlook, Rambler, iCloud, other) and drops recipients, subjects and ids. Put its `external_mail` object into the snapshot; never copy raw pages there. Pass `public_campaigns_get_stats_by_domains` responses to the same command to get the campaign provider breakdown. Delete the temporary files afterwards;
   - transactional-key trends with `public_external_mail_key_stats`, where available.
   `public_external_mail_keys_*` covers transactional keys and does not enumerate SMTP keys. A `keyId` returned by `public_external_mails_list` can therefore be an SMTP key and must not be called historical or missing. Keep SMTP and transactional metrics separate; keep unknown and zero distinct.
4. Run public domain checks with `node scripts/domain_probe.mjs <domain> --dkim-selector <selector>`: SPF, DKIM selector(s) known to RuSender, DMARC policy, BIMI, MTA-STS, TLS-RPT, DNSSEC, MX, and registry dates. The script uses direct DNS and registry WHOIS protocols, not OS utilities or DNS-over-HTTPS. Record its raw observations, source, and timestamp. If network access is unavailable, mark only the affected checks `unknown`; do not fall back to platform-specific commands.
   - Run `node scripts/multirbl_lookup.mjs <domain>` once when blacklist signals are requested. It queries MultiRBL's domain/URI list report and emits raw hits, failures, and its report URL.
   - Treat no hits, a partial response, a timeout, or a policy error as no conclusion. Do not add a finding in those cases; leave the Spamhaus external-check link visible.
   - When the scraper returns hits, assess their list names, categories, comments, and result colors. Add only relevant confirmed signals to `blacklist.findings` and to the ordinary findings list. Explain that the observation came from MultiRBL and name the underlying list; do not call it an IP or sending-IP finding.
5. Resolve Google Postmaster explicitly before finalizing the audit:
   - Read `references/google-postmaster.md`, then run `node scripts/google_postmaster.mjs status`. Never infer connection status from RuSender.
   - If connected, run `node scripts/google_postmaster.mjs collect <domain> --days 30` for each matching RuSender domain. Use only spam rate, SPF/DKIM/DMARC success, inbound TLS rate, delivery-error rate, and compliance results. Never retain or display IP-level data.
   - If not connected, offer to connect Google in the language of the request and wait for an explicit choice. On acceptance, run `node scripts/google_postmaster.mjs connect --locale <locale>`, give the user its authorization URL, and resume after authorization. Explain that Google may return no metrics below its traffic thresholds.
   - If status is `unavailable` with `product_oauth_client_not_configured`, report a product-configuration blocker to the plugin distributor. Do not instruct the marketing user to create credentials.
   - If the connector otherwise fails, ask whether to finish without Postmaster or retry. Do not silently finish with `Not checked`.
   - If the user explicitly declines, record `postmaster.state` as `declined` with a localized summary. Use `unknown` only for a failed or genuinely inconclusive connector check, never as a substitute for asking.
6. Derive risks from evidence. Prefer explicit explanations over a single opaque score. Start from `external_mail.assessment` returned by `scripts/aggregate_mails.mjs`: its `sending_state` is a floor for the domain state, and every signal graded `attention` or `critical` becomes a finding with its value, sample size and threshold quoted, plus a concrete action (clean hard-bounced addresses, pause or slow the affected provider, warm up volume, check list sources for the provider with abnormal complaints). The series and provider breakdown exist to feed this grading, not only the charts. The script applies these thresholds; use the same ones for campaign totals the script did not see: complaint rate above 0.1 % of delivered is `attention`, above 0.3 % is `critical` (Gmail and Яндекс limits); hard-bounce rate above 2 % is `attention`, above 5 % is `critical`; DMARC `p=none` is `attention`; more than one SPF record, SPF with `+all`, or more than 10 DNS lookups is `critical`; SPF using `ptr` is `attention`; a domain younger than 30 days sending more than 1 000 messages a day is `attention`; a provider whose bounce or complaint rate is at least twice the account average deserves its own finding. Below 100 attempted messages, say explicitly that rates are not statistically meaningful and do not raise sending findings above `attention`.
   Collect every check that ended in `unknown`, `unavailable`, `declined` or was skipped into the top-level `unverified` list with the domain, check name and reason.
7. Build an evidence-first snapshot matching `references/snapshot-contract.md` and store it with:

   ```bash
   node scripts/store_snapshot.mjs snapshot.json
   ```

   This writes an immutable snapshot to `<data dir>/history/` and atomically updates `latest.json`. Use `--data-dir <path>` only when a different local storage directory is required. Do not place secrets in snapshots.
8. Create the dashboard from `references/dashboard-template.html`: copy it, replace the JSON inside `<script id="audit-data">` with values from the snapshot, and write this audit's prose (summary, findings, actions, every `data-fill` element) in the user's request language. Keep the CSS tokens, section order and render script; you may add sections or columns when the evidence needs them, and remove a section only when its gap is listed in the "what could not be verified" block. Save the HTML with the host's file-writing tool, open or otherwise verify it renders without script errors, resolve its absolute path, and return a clickable Markdown file link using that absolute path. Never return only a relative path or plain unlinked filename.

## Dashboard requirements

The template fixes the skeleton of a one-page report: a portfolio summary (stat tiles), one section per domain with authentication table, a blacklist summary, registration, Postmaster status, sending tiles, a per-day stacked bar chart, a provider table, findings and recommended actions, and a closing "what could not be verified" block fed from `unverified`.

The blacklist card sits in the domain section next to registration, not in the closing block: fill `blacklist.state` (`unknown` when the scraper reported no hits, `critical` or `attention` only for assessed hits), `blacklist.label` with how many lists answered and the reminder that no hits is not proof of a clean domain, and `blacklist.check_url` with the Spamhaus lookup for that domain (`https://check.spamhaus.org/results/?query=<domain>`) so the reader can double-check by hand. Keep the link visible even when the scraper found nothing. Charts are inline SVG and the page works offline. Adapt wording, density and the number of findings to the actual data; do not invent numbers that the snapshot does not contain, and do not drop the "what could not be verified" block even when it is empty.

Use these labels:

- `healthy` — no material finding in the data collected;
- `attention` — an actionable warning or an incomplete signal;
- `critical` — an authentication/compliance failure or a sustained adverse sending signal;
- `unknown` — insufficient data; do not convert it to a negative score.

The values above are stable machine states, not required display text. Translate their visible presentation into the user's language.

## Recommendations

Make recommendations specific and reversible where possible. For DNS fixes, show the affected record and route the user to the RuSender domain dashboard URL returned by MCP when available. Do not claim that a DNS change has propagated until a subsequent audit observes it.

Read `references/snapshot-contract.md` before generating a dashboard or adding a new collector. Read `references/google-postmaster.md` before any Postmaster action. Start the dashboard from `references/dashboard-template.html`.

## Maintenance

`scripts/*.ts` are the sources; the committed `scripts/*.mjs` bundles are what end users run. Build tooling lives at the repository root (above `plugins/`): run `npm install && npm run typecheck && npm run build` there after editing a source and commit the rebuilt `.mjs` files. `node_modules/` and `skills/*/config/` are ignored by git. All script paths in this file are relative to this skill directory; resolve them from the directory that contains `SKILL.md`.
