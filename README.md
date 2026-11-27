# ARC

Private media archive with Telegram-only ingestion and a responsive web gallery.

## Project status

ARC 1.0 foundation. This branch is isolated from `main`; no production service is pointed at it yet. CI validation is enabled for this branch.

## Product rules

- Single-owner private archive.
- Uploads enter through the Telegram bot only.
- Exact duplicate detection uses SHA-256.
- Originals are immutable; previews/covers are regenerable derivatives.
- Gallery: dark Pinterest-style masonry, 10 items per page, newest first.
- Video playback starts only after an explicit click.
- Trash is retained until manually emptied.
- Collections, favorites, tags, search, metadata editing, multi-select and bulk actions.
- Single-file download and flat browser ZIP export for small selections (up to 40 MiB); background ZIP and automatic multipart export are not yet implemented.
- Telegram source messages are deleted only after storage verification succeeds.
- No automatic deletion of originals or backups.

## Repository layout

- `apps/web` — Next.js web application.
- `apps/worker` — idempotent Telegram ingestion, GIF cover generation and archive delivery.
- `supabase/migrations` — reviewed database migrations.
- `docs` — architecture, decisions, operations and test strategy.

## Local development

The app is being introduced in staged commits. Never put secrets in Git. Copy `.env.example` to a local environment file only after the required credentials are provisioned. The archive delivery worker requires the latest queue-claim migration before deployment. Independent backups and Local Bot API Server hosting are not yet provisioned.

## Environments

Production and staging must use separate Supabase projects, Telegram bot credentials, Render services and storage buckets. GitHub Actions is an ephemeral executor, not the durable queue.

## Security

All archive data is private. Telegram WebApp init data must be verified server-side. Service-role credentials must remain server-only. All exposed tables require RLS and owner-scoped policies.
