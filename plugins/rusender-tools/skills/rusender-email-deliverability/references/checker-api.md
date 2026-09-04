# Email Spam Tester API

Use `scripts/email_tester.mjs`; do not call the HTTP endpoints ad hoc. The service requires no account or API key.

## Lifecycle

1. `POST /api/v1/inbox?lang=<locale>` reserves a single-use address for one hour.
2. Send exactly one real message to that address through RuSender.
3. Poll `GET /api/v1/tests/{slug}/status` until `analysis_status` is `checks_ready` or `failed`.
4. Fetch `GET /api/v1/tests/{slug}` once when checks are ready.

Do not call `/api/v1/tests/{slug}/message`; it returns headers, bodies, attachments, and raw source that the skill does not need.

## Meaning of results

- `score_ours`: checker score from 0 to 100.
- `score_compat`: compatibility score from 0 to 10.
- `subscores`: checker section scores, including authentication, infrastructure/spam, content, and compliance.
- `panel`: results from the checker engines.
- `checks`: all deterministic checks with category, status, evidence, weights, and citations.
- `fixes`: prioritized changes and their predicted score gains.
- `complete: false`: at least one check could not run; treat the score as potentially optimistic.
- check `skip`: not applicable, not a pass.
- check `error`: inconclusive and excluded from scoring, not a pass.

`analysis_status` reaches `checks_ready` before the optional AI plan is ready. Titles and summaries arrive in English; `summary_localised` and `translating` describe a later asynchronous translation that the skill does not wait for (see `check-glossary.ru.json`). Do not wait for `ai_status` when deterministic checks are sufficient; the agent authors its own assessment.

## Privacy and capability URLs

The slug and `report_url` grant access to the permanent report and can also authorize retrieval of the raw message while it remains retained upstream. Treat them like passwords:

- keep the slug only in the private local session created by the script;
- never store the slug or `report_url` in result history or HTML;
- show the external report link only on explicit request;
- never log or persist the test address after the send is correlated.

The report endpoint contains a limited message summary (`subject`, sender, bounce address, size, and body-part flags) but not the message bodies or raw source. It is acceptable evidence for the local result.

## Failure handling

- Reservation lifetime is one hour from `expires_at`; campaign moderation can exceed it, so reserve as late as possible (right before scheduling) and check `status` before `collect`.
- `202`: message or analysis is not ready; continue polling within the time budget.
- `404`: invalid or unavailable reservation; return `unknown`.
- `410`: reservation expired before the message arrived; return `expired`.
- `429`: service limit; return `unavailable` with the upstream retry information.
- timeout: return `pending`, preserve the local session, and allow a later `collect` retry.

Do not convert an unavailable or expired checker run into a positive result.
