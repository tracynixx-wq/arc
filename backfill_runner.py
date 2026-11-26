import asyncio
import logging
import os

import aiohttp

# These settings are required by the bot module but unused by backfill.
os.environ.setdefault("ADMIN_ID", "0")
os.environ.setdefault("PASSWORD", "actions-backfill")

import bot as arc


async def main():
    timeout = aiohttp.ClientTimeout(total=120, connect=15, sock_read=90)
    connector = aiohttp.TCPConnector(limit=10, limit_per_host=5)
    arc.session = aiohttp.ClientSession(timeout=timeout, connector=connector)
    try:
        logging.info("Starting ARC thumbnail backfill on GitHub Actions runner")
        await arc.backfill_missing_thumbnails()
    finally:
        await arc.session.close()
        await arc.bot.session.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
