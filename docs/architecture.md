# ARC 1.0 — Architecture

## Runtime boundaries

1. **Web app** — gallery, viewer, search, collections, tags, favorites, admin and export controls.
2. **API** — authenticated server-side operations; validates Telegram identity and owner authorization.
3. **Telegram bot** — accepts media, preserves album order, reports failures only, and sends archive media back to the owner's private chat.
4. **Worker** — claims durable jobs from PostgreSQL, processes media, retries safely and records every state transition.
5. **Supabase PostgreSQL** — source of truth for metadata, queues, audit trail and session revocation.
6. **Supabase Storage** — private object storage for originals and regenerable derivatives.
7. **Independent backup target** — separate provider/account; backups retained indefinitely by policy.
8. **GitHub Actions** — CI and bounded batch execution only; never the queue's source of truth.
9. **Local Telegram Bot API Server** — optional deployment component for large file transfer; requires a separately managed host.

## Data flow: ingestion

Telegram update -> validate owner -> create idempotent ingestion job -> download to temporary storage -> compute SHA-256 -> verify integrity -> detect exact duplicate -> persist original -> verify stored object -> commit media metadata -> enqueue preview/backup jobs -> best-effort delete source message.

An album is represented as separate media rows with a stable album group identifier and original message ordering. A failure for one item must not discard successful siblings.

## Data flow: previews

A worker claims a cover job using a lease. Video preview uses the first 3 seconds (or the full clip if shorter), adaptive resolution and 20–30 FPS. GIF input receives a separate optimized GIF derivative. Original files are never modified. The worker validates the output before marking the job complete.

## Durable jobs

Every job has a unique ID, type, status, attempts, availability time, lease, idempotency key and structured error. Claiming is transactional. Expired leases are recoverable. Retries are bounded and use backoff. Cancel affects pending work; an active atomic operation finishes safely.

## Storage layout

- `originals/` — immutable source media.
- `covers/` — generated animated GIF previews and derivatives.
- `backups/` — backup manifests and copies; preferably a separate provider.
- `temporary/` — short-lived processing/export data.

The database stores object keys and metadata, not media bytes. Signed URLs are short-lived. Buckets are private.

## Deployment boundaries

Staging and production are separate. Render free services can sleep and are not an always-on worker guarantee. GitHub Actions cannot provide persistent processing or extra Render RAM. The exact production topology must be validated against current quotas and budget before enabling large-file processing or Local Bot API Server.

## Failure invariants

- Never delete the only verified original.
- Never mark an upload complete before object verification.
- Never delete a Telegram source message before the original is durably stored and verified.
- Never replace same-name content without explicit confirmation and a recoverable prior version.
- Never automatically purge trash or backups.
- ZIP filename collisions are resolved deterministically; no entry silently overwrites another.
