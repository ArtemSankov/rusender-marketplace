# Snapshot contract

Store one evidence-first JSON object. The agent reads this snapshot and authors the dashboard directly; there is no fixed renderer. Unknown fields are allowed. Never include credentials, OAuth tokens, recipient addresses, raw message bodies, campaign content, or sending IPs.

`scripts/store_snapshot.mjs` stores each audit as a separate private JSON file under `<data dir>/history/` (the data dir is `$RUSENDER_DELIVERABILITY_DIR`, else `~/.codex/data/rusender-deliverability` when it already exists, else `~/.rusender-deliverability`) and atomically updates `latest.json`. The history files are the source for later trend comparisons; there is no database.

```json
{
  "generated_at": "2026-09-04T12:00:00Z",
  "locale": "en",
  "account_label": "Acme",
  "domains": [
    {
      "id": 123,
      "name": "example.com",
      "dashboard_url": "https://...",
      "evidence": {
        "rusender_domain": {
          "source": "RuSender public_domains_list",
          "checked_at": "2026-09-04T11:58:00Z",
          "status": "enabled",
          "verified": true,
          "dns_records": {
            "spf": {"verified": true, "host": "example.com", "type": "TXT", "value": "v=spf1 include:rsndr.ru ~all"},
            "dkim": {"verified": true, "host": "selector._domainkey.example.com", "type": "TXT", "value": "v=DKIM1;..."},
            "dmarc": {"verified": true, "host": "_dmarc.example.com", "type": "TXT", "value": "v=DMARC1; p=none"}
          },
          "warnings": []
        },
        "public_probe": {
          "source": "scripts/domain_probe.mjs",
          "checked_at": "2026-09-04T11:59:00Z",
          "checks": {
            "spf": {"state": "present", "records": ["v=spf1 include:rsndr.ru ~all"], "source": "DNS", "checked_at": "..."},
            "dkim:selector": {"state": "present", "records": ["v=DKIM1;..."], "source": "DNS", "checked_at": "..."},
            "dmarc": {"state": "present", "records": ["v=DMARC1; p=none"], "source": "DNS", "checked_at": "..."},
            "bimi": {"state": "absent", "records": [], "source": "DNS", "checked_at": "..."},
            "mta_sts": {"state": "absent", "records": [], "source": "DNS", "checked_at": "..."},
            "tls_rpt": {"state": "absent", "records": [], "source": "DNS", "checked_at": "..."},
            "mx": {"state": "present", "records": ["10 mail.example.com."], "source": "DNS", "checked_at": "..."},
            "dnssec": {"state": "absent", "records": [], "source": "DNS", "checked_at": "..."}
          },
          "registration": {"state": "present", "created": "2020-01-01", "expires": "2027-01-01", "registrar": "Example Registrar", "source": "registry WHOIS protocol", "checked_at": "..."}
        },
        "campaigns": {
          "source": "RuSender campaigns APIs",
          "period": {"from": "2026-08-06", "to": "2026-09-04"},
          "count": 2,
          "totals": {"sent": 1000, "delivered": 980, "hard_bounced": 5, "complaints": 1},
          "by_provider": [{"provider": "yandex", "label": "Яндекс", "all": 400, "delivered": 395, "hard_bounced": 2, "complaint": 1}]
        },
        "external_mail": {
          "source": "scripts/aggregate_mails.mjs over public_external_mails_list pages",
          "period": {"from": "2026-08-06", "to": "2026-09-04"},
          "rows": 20,
          "key_ids": [456],
          "totals": {"all": 20, "delivered": 20, "hard_bounced": 0, "soft_bounced": 0, "error": 0, "complaint": 0, "unsubscribed": 0, "in_flight": 0,
                     "rates": {"delivered_rate": 1, "hard_bounce_rate": 0, "complaint_rate": 0}},
          "daily": [{"date": "2026-09-04", "all": 3, "delivered": 3, "hard_bounced": 0, "soft_bounced": 0, "error": 0, "complaint": 0, "unsubscribed": 0, "in_flight": 0}],
          "by_provider": [{"provider": "mailru", "label": "Mail.ru (VK)", "all": 12, "delivered": 12, "hard_bounced": 0, "complaint": 0, "rates": {"complaint_rate": 0}}]
        },
        "transactional_keys": {
          "source": "RuSender external mail keys API",
          "items": [{"id": 789, "name": "Website", "status": "enabled", "sent": 0}]
        },
        "postmaster": {
          "state": "connected",
          "source": "Google Postmaster Tools API v2",
          "checked_at": "2026-09-04T12:00:00Z",
          "period": {"from": "2026-08-05", "to": "2026-09-03"},
          "data_available": true,
          "compliance": {"name": "domains/example.com/complianceStatus", "complianceData": {}},
          "metrics": [
            {"date": {"year": 2026, "month": 9, "day": 3}, "metric": "spam_rate", "value": {"doubleValue": 0.0004}}
          ],
          "error": null
        }
      },
      "assessment": {
        "state": "attention",
        "findings": [{"severity": "attention", "title": "DMARC is monitoring only", "detail": "The observed policy is p=none."}],
        "actions": ["Verify alignment for all legitimate senders before enforcing DMARC."]
      }
    }
  ],
  "unverified": [
    {"domain": "example.com", "check": "Google Postmaster", "state": "unavailable", "reason": "product_oauth_client_not_configured"},
    {"domain": "example.com", "check": "MultiRBL", "state": "unknown", "reason": "timeout after 20 s"}
  ]
}
```

## Sending series and provider breakdown

`external_mail.daily` and `*.by_provider` are produced by `scripts/aggregate_mails.mjs` from MCP responses saved to files. The script drops recipients, subjects and ids; only day buckets, provider buckets and the top recipient domains of the `other` bucket (domain names, never addresses) survive. Provider ids are `mailru`, `yandex`, `gmail`, `microsoft`, `rambler`, `apple`, `other`. Counters follow RuSender statuses; `opened`, `clicked`, `complaint` and `unsubscribed` also count as `delivered`. `in_flight` collects `sending` and `pending` and is excluded from rate denominators. Do not hand-edit these numbers.

## Sending assessment

`external_mail.assessment` is also produced by `scripts/aggregate_mails.mjs` and is the machine-graded reputation view of the series: `sending_state`, `sample_sufficient` and a list of `signals` (`id`, `state`, `metric`, `value`, `threshold`, `scope`, `detail`, `weight`). The rules are: complaint rate ≥ 0.1 % attention / ≥ 0.3 % critical; hard bounce ≥ 2 % / ≥ 5 %; soft bounce ≥ 5 % / ≥ 10 %; error ≥ 2 % / ≥ 5 %; delivered ≤ 97 % / ≤ 90 %; a provider with at least 50 sends that is twice as bad as the account average or over the absolute thresholds; hard-bounce or complaint rate growing more than 1.5x week over week; volume growing 3x week over week above 1 000 messages; any day over critical thresholds. Below 100 completed sends the state is capped at `attention`.

The per-domain `assessment.state` must be at least as severe as `external_mail.assessment.sending_state` (and the campaign equivalent when available) combined with the authentication findings. Copy signals with state `attention` or `critical` into `assessment.findings`, keeping their value and threshold, and give each a matching action. Never present a rate without stating the sample size it is based on.

## Unverified checks

`unverified` is a top-level list of every check that ended in `unknown`, `unavailable`, `declined` or was skipped, with the domain, the check name and a short machine-readable reason. The dashboard renders it as the "what could not be verified" block. An empty list means every planned check produced a result. Never leave an `unknown` check out of this list; a gap that is not listed looks like a pass.

`locale` is required and must match the language of the user's request, preferably as a BCP 47 tag such as `ru`, `en`, or `de`. Raw DNS and API values remain exact; only `assessment` and the authored dashboard prose are localized.

Every attempted check must have a stable name, `state`, raw `records` or aggregate values, `source`, `checked_at`, and `error` when applicable. Use `unknown` for unavailable evidence and keep it distinct from an observed zero or absence.

Keep SMTP and transactional key evidence separate. A key ID seen in external-mail history but absent from transactional-key listings may be an SMTP key; do not call it missing or historical.

`postmaster.state` may be `connected`, `not_connected`, `declined`, `unavailable`, `pending`, or `unknown`. Do not finalize with `unknown` merely because connection was never offered. Obtain an explicit acceptance, refusal, or deferral first.

Postmaster evidence must come from the bundled `scripts/google_postmaster.mjs` connector and use the read-only traffic scope. Preserve returned daily metric values and compliance data, but never store OAuth credentials, access/refresh tokens, authorization URLs, or IP-level data. `data_available: false` means Google had insufficient data for the period; it is not a positive or negative reputation result.

Add blacklist evidence only after assessing a positive MultiRBL result. Do not store `no hits`, failed checks, raw HTML, or an inference that the domain is clean.

`assessment.state` must be `healthy`, `attention`, `critical`, or `unknown`. Scores are optional; omit them when evidence is insufficient. Findings must cite the evidence that supports them, while the dashboard may present that evidence in whatever layout best fits the audit.
