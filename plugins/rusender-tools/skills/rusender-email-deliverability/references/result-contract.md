# Result contract

Store one evidence-first JSON object. Unknown fields are allowed. Do not store the checker slug, checker address, `report_url`, recipient addresses, HTML/text bodies, raw headers, raw MIME source, or OAuth/API credentials.

```json
{
  "generated_at": "2026-09-04T12:00:00Z",
  "locale": "ru",
  "mode": "campaign",
  "source": {
    "kind": "campaign",
    "id": 123,
    "name": "Осенняя акция",
    "dashboard_url": "https://...",
    "template_id": 456,
    "sender_id": 789,
    "subject": "Скидка до конца недели"
  },
  "test_send": {
    "source": "RuSender MCP",
    "recipient_count": 2,
    "client_copy_requested": true,
    "test_campaign_id": 987,
    "test_campaign_dashboard_url": "https://...",
    "state": "completed",
    "recipients": {
      "checker": {"state": "delivered"},
      "client_copy": {"state": "delivered"}
    }
  },
  "checker": {
    "source": "Email Spam Tester API v1",
    "checked_at": "2026-09-04T12:03:00Z",
    "analysis_status": "checks_ready",
    "ai_status": "running",
    "score_ours": 86.4,
    "score_compat": 9.2,
    "subscores": {},
    "scoring_version": "...",
    "complete": true,
    "errored_checks": [],
    "message": {
      "subject": "Скидка до конца недели",
      "from_addr": "news@example.com",
      "bounce_address": "...",
      "size_bytes": 42000,
      "has_html": true,
      "has_text": true,
      "forged_headers": {}
    },
    "panel": [],
    "checks": [],
    "fixes": []
  },
  "cleanup": {
    "campaign_archived": true,
    "temporary_list_deleted": true,
    "temporary_contacts_deleted": true,
    "remaining_objects": []
  },
  "assessment": {
    "state": "attention",
    "summary": "Есть исправимые риски перед основной отправкой.",
    "findings": [],
    "actions": []
  },
  "unverified": [
    {"check": "AI verdict", "reason": "ai_status was still running when checks were collected"}
  ]
}
```

`unverified` lists every checker check with status `skip` or `error`, every RuSender signal that could not be read, and anything skipped by the user (for example a declined client copy). The dashboard shows it as a separate block; an empty list is allowed and still rendered.

The dashboard is a digest built from `references/dashboard-template.html`: the agent's verdict, selected problems and actions. Its JSON is authored by the agent from this result and must never contain the checker address, slug or `report_url`. The full checker `checks` array stays only in the stored result.

`mode` is `campaign` or `transactional`. For transactional mode, replace test-campaign fields with the RuSender external-mail/key identifiers and status.

Preserve checker evidence exactly enough to support every finding, including IP and infrastructure evidence. State clearly that infrastructure observations belong to the tested message and are not guaranteed to repeat on a future send.

`cleanup.remaining_objects` must name every temporary object that could not be removed or archived, with its ID and dashboard URL when RuSender provides one. Do not call cleanup complete when any known temporary object remains.

Derive `assessment.state` as:

- `critical`: checker has material `fail` results, RuSender rejected/banned the send, or the checker message was not delivered;
- `attention`: checker has actionable `warn` results or `complete` is false;
- `healthy`: the message was delivered to the checker, the checker is complete, and no material fail/warn remains;
- `unknown`: the send or checker evidence is inconclusive.

The external checker score is evidence, not the sole state rule. A high score does not erase an explicit failure.
