# Google Postmaster connector

Use the bundled `scripts/google_postmaster.mjs` for read-only Gmail reputation and compliance evidence. `scripts/google_postmaster.ts` is its TypeScript source and uses `@googleapis/gmailpostmastertools`; plugin users do not install npm packages.

## Product setup

The plugin distributor, not the end user, must create one Google Desktop OAuth client, enable Gmail Postmaster Tools API, configure the consent screen, and publish or verify the app as required by Google. Ship its installed-app JSON as `config/google-postmaster-oauth.json`, or inject `RUSENDER_GOOGLE_CLIENT_ID` and optional `RUSENDER_GOOGLE_CLIENT_SECRET`.

Never ask a marketing user to create a Google Cloud project or OAuth client. Their only setup step is approving the Google consent screen. Do not bundle user tokens.

The connector requests only:

```text
https://www.googleapis.com/auth/postmaster.traffic.readonly
```

## Commands

Check connector state before every audit:

```bash
node scripts/google_postmaster.mjs status
```

Start browser authorization only after the user accepts:

```bash
node scripts/google_postmaster.mjs connect --locale ru
```

Collect the last 30 complete days for a RuSender domain:

```bash
node scripts/google_postmaster.mjs collect example.com --days 30
```

The token is stored locally at `<data dir>/google-postmaster-token.json` with user-only permissions. Never copy it to the snapshot, dashboard, logs, or plugin package.

The distributor builds all runtimes with `npm run build` before publishing the plugin. The generated `.mjs` files include their npm dependencies; do not run `npm install` on an end user's machine. The plugin runtime requires Node.js 20 or newer.

## Evidence rules

- Query only domains already returned by RuSender.
- Use Google Postmaster Tools API v2 compliance status and these selected metrics: spam rate, SPF/DKIM/DMARC success, inbound TLS rate, and delivery-error rate.
- Never request, retain, infer, or display IP-reputation data.
- Treat an empty period as insufficient volume, not good or bad reputation.
- Treat permission errors as unavailable for that domain, not evidence that the connector is absent.
- Preserve daily values in the snapshot; derive trends and findings in the agent assessment.
