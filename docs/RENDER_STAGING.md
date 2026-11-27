# ARC staging deployment

This repository is a monorepo. Deploy the web application and queue worker as separate Render services.

## Services

- `arc-web-staging`: Next.js web app, free plan, Frankfurt. Health endpoint: `/api/health`.
- `arc-worker-staging`: Docker worker with FFmpeg, Frankfurt. The worker continuously polls Supabase queues.

Both services are pinned to `arc-v1-foundation`; neither replaces the existing `arc` service or deploys from `main`.

## Required configuration

Set the prompted values in Render for each service. Never commit secrets.

Web:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `ARC_WEB_URL` — the actual public URL of `arc-web-staging`

Worker:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`

Use a dedicated staging Supabase project and a dedicated staging Telegram bot. Do not reuse production credentials until staging isolation has been verified.

## Cost and deployment safety

The web service is configured on Render's free plan. Render does not offer always-on background workers on the free compute tier; the worker is configured at the smallest paid compute size (0.5 CPU / 512 MB, currently listed at $7/month). Applying this Blueprint can create a billable worker. Review the Render plan before approving the first Blueprint sync.

This file only defines staging resources. Do not repoint the existing production service, merge this branch into `main`, or apply database migrations to the production Supabase project as part of staging setup.

## First deployment checklist

1. Create a Render Blueprint from this repository and select `arc-v1-foundation`.
2. Review the two resources and the worker's paid plan before applying.
3. Enter staging-only Supabase and Telegram values.
4. After the web service is live, set `ARC_WEB_URL` to its actual URL.
5. Apply the reviewed Supabase migrations to the staging project only.
6. Set the Telegram webhook to `https://<arc-web-staging-host>/api/telegram/webhook`, using the matching webhook secret.
7. Verify `GET /api/health`, Telegram authentication, media ingest, cover generation, archive delivery, retries and cancellation with test media.

A green GitHub build is not an end-to-end test. Do not treat staging as production until all checks above pass.
