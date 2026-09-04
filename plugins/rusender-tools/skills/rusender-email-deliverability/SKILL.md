---
name: rusender-email-deliverability
description: Run an end-to-end deliverability test for a RuSender campaign, mailing, template, or transactional email by sending a real message to Email Spam Tester, collecting RuSender delivery evidence and the complete checker assessment, and producing a local HTML report. Use when a user asks to test an email, campaign, mailing, template, spam risk, technical email quality, or inbox readiness before a real send.
---

# RuSender email deliverability

Test one real RuSender message end to end. This skill is separate from domain reputation: it evaluates a particular rendered message and the infrastructure used for that send.

## Guardrails

- Use RuSender MCP as the only sending mechanism. Never send through local SMTP or request SMTP credentials.
- Treat this workflow as a real send. Before scheduling a campaign, show the sender, subject, source campaign/template, and exact recipient count, then obtain the user's confirmation required by the RuSender campaign tools.
- Tell the user that the complete message is sent to the external Email Spam Tester service. Do not use confidential production personalization values without explicit approval.
- For a campaign test, create a fresh list containing exactly one checker contact and, only when requested, one client-copy contact. Never attach an original list or segment to the test campaign.
- For a transactional test, use `public_external_mail_send` or `public_external_mail_send_by_template` only when `public_external_mail_keys_list` establishes an active key matching the sender domain. Do not create or enable a key for the test.
- Use all checker evidence as returned, including infrastructure and IP-related signals. Explain that such signals describe this particular send and can change on a later RuSender send.
- Never call the checker's `/message` endpoint. The report endpoint already contains the scores, checks, evidence, citations, and fixes needed for assessment.
- Treat the checker slug and `report_url` as access secrets. Do not put either into stored snapshots or the dashboard. Give the external report link only when the user explicitly asks for it.
- Do not store HTML, plain-text bodies, test-recipient addresses, raw headers, or raw message source in history.
- Keep `pass`, `warn`, `fail`, `skip`, and `error` distinct. A skipped or errored check is not a pass. If `complete` is false, state that the score may be optimistic.
- Do not claim guaranteed inbox placement at Gmail, Outlook, Yandex, or another mailbox provider. Present a point-in-time deliverability assessment of the tested send.
- Use the language of the user's request for the checker reservation, assessment, dashboard, and final response.

## Hosts and tool names

The skill runs unchanged in Codex and Claude Code. RuSender MCP tools are named below by their bare names (`public_campaigns_list`, ...); the host adds its own prefix (`mcp__rusender__` in Claude Code). Write files with the host's file-writing tool. Scripts are plain Node.js 20+; paths are relative to the directory containing this `SKILL.md`.

## Choose the sending path

### Campaign or mailing

Use the campaign path whenever the user names a campaign, mailing, newsletter, campaign draft, or campaign template. This path must exercise RuSender's campaign delivery pipeline even if an active transactional key exists.

Support existing RuSender campaigns and existing templates. Do not silently create a template from raw HTML: RuSender MCP has no template-delete operation, so that would leave a permanent object. If raw content must be tested as a campaign, ask the user to save it as a template first or explicitly approve creation of a retained template.

For an A/B campaign, ask which subject variant to test. Create a regular one-variant test campaign; do not attempt an A/B split over one or two contacts. Do not copy follow-up or chunk settings.

### Transactional email

Use the transactional path only when the user is testing an API/transactional message and an active matching key is already available. If no active key matches the sender domain, stop and explain the blocker. Do not fall back to a campaign, because that would test a different delivery path.

If the user supplies arbitrary HTML or text without saying how it will be sent, ask whether it is a campaign or a transactional message before choosing a path.

## Checker commands

Read `references/checker-api.md` before using the checker.

Reserve a single-use address only after the source, sender, subject, optional client copy, and final confirmation are resolved:

```bash
node scripts/email_tester.mjs reserve --locale ru
```

The command returns a local `test_id` and the checker address. It stores the upstream slug in a private local session file.

After the RuSender send starts, wait for deterministic checks and collect the report:

```bash
node scripts/email_tester.mjs collect <test_id> --timeout 300
```

Use `status <test_id>` for a non-blocking check and `discard <test_id>` when setup failed before any message was sent. Do not expose the returned `report_url` unless explicitly requested.

## Campaign workflow

1. Resolve the source with `public_campaigns_list`/`public_campaigns_get_by_id` or `public_templates_list_v2`/`public_templates_get_by_id`. Resolve the verified sender with `public_senders_list`.
2. Copy only supported message fields into the test campaign: template, sender, sender name, subject or selected A/B subject, preview text, attachments, and UTM settings. Never copy source `listIds` or `segmentId`.
3. Ask whether the user wants a visual copy at their own address. If yes, validate the address with `public_contacts_list`:
   - add an existing active/new contact to the temporary list;
   - never resubscribe an unsubscribed, complaint, bounced, or errored contact automatically; ask for another address;
   - remember whether the contact already existed so cleanup never deletes user data.
4. For personalization, use neutral test values supplied or approved by the user. Never copy another subscriber's personal data into the checker contact.
5. Show the final send confirmation: source, sender, subject, one checker recipient, and the optional client-copy recipient.
6. After confirmation, reserve the checker address, then:
   - create a uniquely named temporary list with `public_lists_create`;
   - create the checker contact with `public_lists_contacts_create`;
   - add or create the optional client contact;
   - create a campaign named `[Deliverability test] <source> <timestamp>` with only the temporary list;
   - call `public_campaigns_schedule` without follow-up, chunks, or a delayed start.
7. Poll the checker with `collect`. A campaign passes RuSender moderation first, so it may stay `scheduled`, `on_hold` or `in_progress` for a while; the checker reservation lives one hour. Poll with `status` every 30–60 s while the campaign is not terminal, run `collect --timeout 600` once RuSender reports the recipient as sent, and if the reservation expires before delivery report `expired`, clean up, and offer a rerun. In parallel, inspect `public_campaigns_get_by_id`, `public_campaigns_get_activity`, and `public_campaigns_recipients` until the test is completed, banned/rejected, or the wait limit is reached.
8. Cleanup best-effort after the send reaches a terminal state:
   - archive a completed or banned test campaign with `public_campaigns_archive`;
   - remove an existing client contact from the temporary list, but never delete that contact;
   - delete contacts created solely for the test;
   - delete the temporary list.
   If cleanup fails, record the remaining object IDs and dashboard URLs and explain what remains. Do not repeat destructive calls blindly.

If setup fails before scheduling, delete the test draft, delete only contacts created by this run, and delete the temporary list. The remote checker reservation cannot be cancelled; discard only its local session.

## Transactional workflow

1. Resolve the sender and call `public_external_mail_keys_list`. Select only an active key whose bound domain exactly matches the sender domain. If several match, ask the user by key name, not only by ID.
2. Resolve an existing template when using `public_external_mail_send_by_template`, including required substitution values. Otherwise require subject and at least one of HTML or text.
3. Show the sender, subject/template, and the fact that one message will be sent to the external checker. Obtain confirmation when the request did not already explicitly authorize the test send.
4. Reserve the checker address and send one message with the selected active key. Do not add CC or BCC unless the user explicitly requests it.
5. Run `collect`, then use `public_external_mails_list` filtered by the unique checker address and key ID to capture the actual RuSender status. Keep the checker address out of the stored snapshot.

## Assessment and storage

Read `references/result-contract.md`. Combine the checker output with RuSender delivery evidence and cleanup evidence. Preserve the full checker `panel`, `checks`, `fixes`, scores, subscores, citations, and message summary. Remove `report_url` before storage.

Store the combined result with:

```bash
node scripts/store_result.mjs result.json
```

This writes a private immutable JSON file under `<data dir>/rusender-email-deliverability/history/` and atomically updates `latest.json`. The data dir is `$RUSENDER_DELIVERABILITY_DIR`, else `~/.codex/data` when it already holds this skill's data, else `~/.rusender-deliverability`; both Codex and Claude Code share it. The command refuses results that still contain the checker address, slug or report link.

## Digest and dashboard

The deliverable is a digest written by the agent, not a copy of the checker report. Read the checker output and the RuSender evidence, decide what materially affects inbox placement, and write the report from `references/dashboard-template.html`: copy it, replace the JSON in `<script id="digest-data">`, write all prose in the user's language, keep protocol values verbatim. Never paste the checker's check table, per-check titles, scores of individual checks or its `fixes` list into the report; the full checker output stays in the stored result for traceability. Never put the checker address, slug or report link into the report.

The digest contains:

- **Verdict**: one state (`healthy`, `attention`, `critical`, `unknown`), a headline in the agent's own words (for example «Письмо не готово к массовой отправке», «Можно отправлять после одной правки», «Готово»), a short readiness phrase, and one paragraph that a marketer understands. Do not show the checker's numeric score or its subscores anywhere in the report: the reader gets the agent's conclusion, the score stays in the stored result as evidence.
- **Facts**: 3–5 short facts in words, not numbers from the checker: RuSender send status, whether spam filters are clean or close to their thresholds, authentication outcome, completeness of the check.
- **Problems**: 0–6 items that really hurt deliverability, each with severity, a plain-language explanation of the consequence, and who fixes it (the domain owner in DNS, the template in RuSender, or the RuSender platform itself).
- **Actions**: concrete steps ordered by impact, each tied to a problem.
- **What is fine**: one sentence naming what passed, so the reader trusts the verdict.
- **What could not be verified**: skipped or errored checks and anything the user declined.

Selection rules for problems. Include: SPF or DKIM failure or misalignment that leaves DMARC without a passing identifier; DMARC absent or `p=none`; missing or unsigned one-click unsubscribe headers (Gmail and Яндекс requirements for bulk senders); spam-filter scores near or above their thresholds and the rules that drive them; IP or domain blocklist hits; missing plain-text part, broken or malicious links, URL shorteners, dangerous HTML, spam-trigger subjects; very low text-to-HTML ratio when the tested message is a real template (not a short test); forged or missing headers. Exclude, or mention only in the "what is fine / hardening" sentence: BIMI, MTA-STS, TLS-RPT, DNSSEC, ARC, Return-Path length, DMARC report delivery and any advisory the checker marks as not affecting the score, unless the user asked for them. When RuSender itself causes the problem (for example the platform signs headers or sets the Return-Path), say so explicitly: the user cannot fix it in DNS or in the template.

The state follows `references/result-contract.md`; the checker score is evidence, not the rule. Save the HTML locally and return it as a clickable absolute file link.
