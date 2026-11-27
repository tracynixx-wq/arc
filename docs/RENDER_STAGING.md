# ARC staging deployment

ARC is a monorepo. The staging website is a separate Render Free web service; queue processing is designed to run as a one-shot GitHub Actions job so testing does not require a continuously running paid Render worker.

## Staging web service

- Name: `arc-web-staging`
- Runtime: Node.js / Next.js
- Plan: Render Free
- Region: Frankfurt
- Branch: `arc-v1-foundation`
- Health check: `/api/health`

This Blueprint creates only the staging website. It does not adopt, update, or replace the existing production service named `arc`.

## Queue executor

The worker supports `npm run worker:once`. Each invocation recovers stale jobs, claims at most one Telegram job and one cover-processing job, handles them, then exits. The GitHub Actions workflow `.github/workflows/arc-worker.yml` can run this on a five-minute schedule or manually.

GitHub scheduled workflows execute only from the repository's default branch. The workflow is intentionally disabled unless repository variable `ARC_WORKER_ENABLED` is set to `true`. After the application and workflow are reviewed and promoted to the default branch, configure:

Repository variable:
- `ARC_WORKER_ENABLED=true`

Repository Actions secrets:
- `ARC_SUPABASE_URL`
- `ARC_SUPABASE_SERVICE_ROLE_KEY`
- `ARC_TELEGRAM_BOT_TOKEN`

The repository is public, so standard GitHub-hosted runner usage for public repositories is available without using Render worker compute. Never place credentials in workflow YAML or commit them to the repository.

## Web service environment

Set these values in Render for `arc-web-staging`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `ARC_WEB_URL` — the actual public URL of `arc-web-staging`

Use a dedicated staging Supabase project and a dedicated staging Telegram bot. Do not reuse production credentials until staging isolation has been verified.

## Deployment safety

- No paid Render worker is defined in this Blueprint.
- The existing Render service `arc` remains untouched and continues to use its current `main` configuration.
- No Supabase migrations are applied automatically.
- The worker workflow is disabled until explicitly enabled with the repository variable.
- The app and workflow must be reviewed before merging the staging branch into the default branch.

## First deployment checklist

1. Review the Render Blueprint plan. It should create only `arc-web-staging`.
2. Apply it only after confirming the environment values and staging project.
3. Set `ARC_WEB_URL` to the actual Render URL.
4. Apply the reviewed migrations to the staging Supabase project only.
5. Configure the Telegram webhook to `https://<arc-web-staging-host>/api/telegram/webhook` with the matching webhook secret.
6. Review and promote the GitHub Actions worker workflow to the default branch.
7. Add the three Actions secrets and set `ARC_WORKER_ENABLED=true`.
8. Test Telegram authentication, media ingest, original storage verification, cover generation, archive delivery, retries and cancellation with test media.

A green GitHub build is not an end-to-end test. Do not treat staging as production until all checks above pass.
