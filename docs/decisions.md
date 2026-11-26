# ARC 1.0 — Accepted decisions

| Area | Decision |
|---|---|
| Owner model | One owner |
| Upload path | Telegram bot only |
| Duplicate detection | SHA-256 exact content hash |
| Gallery | Dark Masonry / Pinterest-like |
| Page size | 10 media |
| Ordering | Newest first |
| Video playback | Click to play; no autoplay |
| Search | Instant while typing |
| Pagination | Numbered, jump to page |
| Viewer | Overlay over gallery |
| Collections | One media item may belong to multiple collections |
| Favorites and tags | Supported |
| Trash | Retain indefinitely until manual purge |
| Delete | Move to trash without prompt; permanent purge requires confirmation |
| Preview | Video: opening 3 seconds; short clips: full clip; GIF: optimized GIF derivative; photo: source image |
| Preview FPS | Adaptive 20–30 FPS |
| Preview resolution | Adaptive |
| ZIP | Browser or background, selected automatically; flat structure; original names; split large archives; covers excluded by default |
| Telegram delivery | Owner's private chat, archive insertion order |
| Album handling | Each item saved separately; album ordering preserved |
| Successful upload | Silent |
| Upload failure | Record details and expose retry |
| Telegram source deletion | Only after original is saved and verified; best-effort |
| Job scheduling | Durable database queues; Actions is only an executor |
| Parallelism | Automatic, resource-aware |
| Priority | Balanced across ingestion, covers, ZIP, Telegram and backups |
| Recovery | Lease expiry, bounded retries, idempotency |
| Session | Until manual logout/revocation, with server-side validation |
| Audit | All actions and detailed per-file processing history |
| Backups | Originals, covers, DB and settings; retain indefinitely |
| Restore | Selective or full, with preview |
| Storage alerts | 70%, 85%, 95%; block uploads before exhaustion |
| Admin | Separate panel; CPU, RAM, storage, traffic, queues, errors, throughput and history |
| Notifications | Daily summary and critical failures |
| Legacy migration | Deferred |

## Important interpretation

"Unlimited" preview size means no arbitrary product-level cap; it does not remove physical storage, network, CPU, browser or provider limits. "Forever" backup retention requires funded independent storage and monitoring. Sessions that last until logout must still be revocable after credential compromise.
