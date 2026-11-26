# Operations and deployment notes

## Environment variables

Configure these in the deployment provider's secret manager. Never commit actual values.

- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL (public URL, not a secret).
- `SUPABASE_SERVICE_ROLE_KEY` — server-only service role key; never expose to browser code.
- `TELEGRAM_BOT_TOKEN` — bot token, server-only.
- `TELEGRAM_OWNER_ID` — numeric Telegram user ID allowed to access the private archive.
- `TELEGRAM_WEBHOOK_SECRET` — random secret used by Telegram's webhook header.
- `ARC_WEB_URL` — public HTTPS URL of the web app.
- `TELEGRAM_API_BASE_URL` — Bot API base URL; defaults to Telegram cloud API.
- `TELEGRAM_FILE_BASE_URL` — Bot API file-download base URL.
- `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` — independent backup destination.

## Telegram webhook

After deploying the web service and configuring the bot secrets, register the webhook from a trusted environment:

```sh
npm run telegram:webhook:set
```

The script requires HTTPS and does not print the bot token or webhook secret. It preserves pending Telegram updates.

## Security model

- The web app never receives the Supabase service role key.
- Every private API route validates an opaque session token against the `sessions` table.
- Telegram Web App `initData` is validated server-side with the bot token and checked against the configured owner ID.
- Session tokens are random, stored only as SHA-256 hashes, and revocable server-side.
- All application tables have RLS enabled and no client-facing policies. The server uses the service role only after owner-session validation.
- All Storage buckets are private. The web app issues short-lived signed URLs after authorization.
- Production and staging must use separate Supabase projects, Telegram credentials, storage buckets and Render services.

## Current implementation boundary

The database schema, private media API, Telegram webhook receiver and initial gallery are implemented on the isolated `arc-v1-foundation` branch. A persistent media worker, cover generation, resumable large-file ingestion, archive export, independent backup execution and admin monitoring are still implementation tasks. Do not register the production webhook or point production traffic at this branch until those components and end-to-end tests are complete.


## Telegram archive delivery

- `/send_all` creates a durable delivery job and asks the owner to choose native media types or document-only delivery.
- The worker sends active media in archive insertion order and records each confirmed delivery in `telegram_deliveries`.
- A subsequent run skips records already marked `sent`; failed items remain eligible for a later run.
- `/cancel` marks queued or running delivery jobs as cancelled. The worker checks cancellation between media items; an in-flight Telegram request is allowed to finish.
- Apply migration `20261126160000_claim_archive_delivery_jobs.sql` before enabling this worker version. It allows the worker to claim delivery jobs only after the owner has selected a format.
- Delivery currently uses Telegram Bot API URL-based file retrieval. Large-file limits depend on the Bot API deployment; a Local Bot API Server and shared file access are not yet provisioned.

## Backup status

Independent backup execution is not enabled. Ingestion records `backup_status: not_configured` in media metadata and does not create endlessly retrying backup jobs. Configure and test an independent S3-compatible destination and restore procedure before treating originals as backed up. Do not infer backup protection from Supabase Storage alone.
