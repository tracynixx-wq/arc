import asyncio
import logging
import os

import aiohttp

os.environ.setdefault("ADMIN_ID", "0")
os.environ.setdefault("PASSWORD", "actions-original-storage")
import bot as arc

MAX_NEW_BYTES = int(os.getenv("MAX_NEW_BYTES", str(600 * 1024 * 1024)))
PAGE_SIZE = 500

async def fetch_rows():
    rows = []
    offset = 0
    while True:
        params = {
            "select": "id,user_id,kind,file_id,file_unique_id,storage_path,storage_status",
            "order": "id.asc", "limit": str(PAGE_SIZE), "offset": str(offset),
        }
        async with arc.session.get(
            f"{arc.SUPABASE_URL}/rest/v1/media", params=params, headers=arc._headers()
        ) as response:
            if response.status >= 300:
                raise RuntimeError(f"Media query failed: {response.status} {(await response.text())[:400]}")
            batch = await response.json()
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows

async def existing_original_bytes():
    query = "select coalesce(sum((metadata->>'size')::bigint),0) as bytes from storage.objects where bucket_id='arc-originals'"
    async with arc.session.post(
        f"{arc.SUPABASE_URL}/rest/v1/rpc/does_not_exist", json={}, headers=arc._headers()
    ) as _:
        pass
    # Storage usage is also counted locally as successful objects are created in this run.
    return 0

async def main():
    timeout = aiohttp.ClientTimeout(total=180, connect=15, sock_read=150)
    connector = aiohttp.TCPConnector(limit=5, limit_per_host=3)
    arc.session = aiohttp.ClientSession(timeout=timeout, connector=connector)
    try:
        rows = await fetch_rows()
        pending = [row for row in rows if not row.get("storage_path")]
        logging.info("Original storage audit: total=%s already_stored=%s to_check=%s",
                     len(rows), len(rows)-len(pending), len(pending))
        total_bytes = 0
        downloadable = 0
        oversized = 0
        unavailable = 0
        sizes = {}
        for row in pending:
            try:
                tg_file = await arc.bot.get_file(row["file_id"], request_timeout=30)
                size = int(tg_file.file_size or 0)
                sizes[row["id"]] = size
                if size > 20 * 1024 * 1024:
                    oversized += 1
                else:
                    downloadable += 1
                    total_bytes += size
            except Exception as exc:
                unavailable += 1
                logging.warning("Cannot inspect Telegram file row=%s: %s", row["id"], exc)
        logging.info("Original storage audit result: downloadable=%s estimated_mib=%.1f oversized=%s unavailable=%s",
                     downloadable, total_bytes/1024/1024, oversized, unavailable)
        mode = os.getenv("STORAGE_MODE", "audit").lower()
        if mode != "migrate":
            logging.info("Audit only; no original files were copied.")
            return
        if total_bytes > MAX_NEW_BYTES:
            raise RuntimeError(
                f"Estimated copy {total_bytes} bytes exceeds safety budget {MAX_NEW_BYTES}; no files copied."
            )
        copied = failed = 0
        copied_bytes = 0
        for row in pending:
            size = sizes.get(row["id"])
            if size is None or size > 20 * 1024 * 1024:
                failed += 1
                continue
            ok, error = await arc.store_original_media(
                int(row["user_id"]), row["file_unique_id"], row["file_id"]
            )
            if ok:
                copied += 1
                copied_bytes += size
            else:
                failed += 1
                logging.warning("Original copy failed row=%s: %s", row["id"], error)
            if (copied + failed) % 10 == 0:
                logging.info("Original copy progress copied=%s failed=%s copied_mib=%.1f",
                             copied, failed, copied_bytes/1024/1024)
            await asyncio.sleep(0.3)
        logging.info("Original copy finished copied=%s failed=%s copied_mib=%.1f",
                     copied, failed, copied_bytes/1024/1024)
    finally:
        await arc.session.close()
        await arc.bot.session.close()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())