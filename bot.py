import asyncio
import logging
import os
import time

import aiohttp
from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.exceptions import TelegramBadRequest
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

logging.basicConfig(level=logging.INFO)

BOT_TOKEN = os.environ["BOT_TOKEN"]
ADMIN_ID = int(os.environ["ADMIN_ID"])
PASSWORD = os.environ["PASSWORD"]
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
PORT = int(os.environ.get("PORT", "8080"))
SELF_URL = os.environ.get("RENDER_EXTERNAL_URL", "")

LOCK_SECONDS = 30 * 24 * 3600  # Keep the authenticated session for 30 days
PAGE_SIZE = 5

SECTIONS = {
    "videos": "🎬 Видео",
    "circles": "⭕ Кружки",
    "leaks": "🔥 Сливы",
}

bot = Bot(BOT_TOKEN)
dp = Dispatcher()
session: aiohttp.ClientSession | None = None

unlocked: dict[int, float] = {}
panel: dict[int, int] = {}
prompt: dict[int, int] = {}
shown: dict[int, list[int]] = {}
mode: dict[int, str] = {}
refresh_tasks: dict[int, asyncio.Task] = {}


# ---------- Supabase ----------
def _headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    if extra:
        h.update(extra)
    return h


async def db_add(uid, section, kind, file_id, unique_id):
    async with session.post(
        f"{SUPABASE_URL}/rest/v1/media?on_conflict=user_id,file_unique_id",
        json={
            "user_id": uid,
            "section": section,
            "kind": kind,
            "file_id": file_id,
            "file_unique_id": unique_id,
        },
        headers=_headers(
            {"Prefer": "resolution=ignore-duplicates,return=minimal"}
        ),
    ) as r:
        if r.status >= 300:
            logging.error("db_add %s %s", r.status, await r.text())
            return False
        return True


async def db_count(section, uid=None):
    url = f"{SUPABASE_URL}/rest/v1/media?select=id&section=eq.{section}&limit=1"
    if uid is not None:
        url += f"&user_id=eq.{uid}"
    async with session.get(url, headers=_headers({"Prefer": "count=exact"})) as r:
        cr = r.headers.get("Content-Range", "*/0")
        try:
            return int(cr.split("/")[-1])
        except ValueError:
            return 0


async def db_list(uid, section, page):
    url = (
        f"{SUPABASE_URL}/rest/v1/media?select=id,kind,file_id"
        f"&user_id=eq.{uid}&section=eq.{section}"
        f"&order=id.desc&limit={PAGE_SIZE}&offset={page * PAGE_SIZE}"
    )
    async with session.get(url, headers=_headers()) as r:
        if r.status >= 300:
            logging.error("db_list %s %s", r.status, await r.text())
            return []
        return await r.json()


async def db_delete(uid, row_id):
    async with session.delete(
        f"{SUPABASE_URL}/rest/v1/media?id=eq.{row_id}&user_id=eq.{uid}",
        headers=_headers(),
    ) as r:
        return r.status < 300


# ---------- helpers ----------
def is_auth(uid: int) -> bool:
    # Password is required for every account, including the administrator.
    return unlocked.get(uid, 0) > time.time()


async def safe_delete(chat_id, message_id):
    try:
        await bot.delete_message(chat_id, message_id)
    except Exception as e:
        logging.warning("delete_message failed chat=%s message=%s: %s", chat_id, message_id, e)


async def clear_view(chat_id, uid, drop_panel=False):
    for mid in shown.pop(uid, []):
        await safe_delete(chat_id, mid)
    if drop_panel and uid in panel:
        await safe_delete(chat_id, panel.pop(uid))


def extract(m: Message, uid: int):
    """Returns (section, kind, file_id, unique_id) or None."""
    forced = mode.get(uid) == "leaks"
    if m.video_note:
        f, kind, sec = m.video_note, "video_note", "circles"
    elif m.video:
        f, kind, sec = m.video, "video", "videos"
    elif m.photo:
        f, kind, sec = m.photo[-1], "photo", "leaks"
    elif m.animation:
        f, kind, sec = m.animation, "animation", "leaks"
    elif m.document:
        f, kind, sec = m.document, "document", "leaks"
    else:
        return None
    if forced:
        sec = "leaks"
    return sec, kind, f.file_id, f.file_unique_id


async def send_media(chat_id, kind, file_id, kb):
    if kind == "video":
        return await bot.send_video(chat_id, file_id, reply_markup=kb)
    if kind == "video_note":
        return await bot.send_video_note(chat_id, file_id, reply_markup=kb)
    if kind == "photo":
        return await bot.send_photo(chat_id, file_id, reply_markup=kb)
    if kind == "animation":
        return await bot.send_animation(chat_id, file_id, reply_markup=kb)
    return await bot.send_document(chat_id, file_id, reply_markup=kb)


async def build_panel(uid, view=None):
    counts = await asyncio.gather(*[db_count(s, uid) for s in SECTIONS])
    lines = ["🔒 Хранилище", ""]
    for (key, title), c in zip(SECTIONS.items(), counts):
        lines.append(f"{title}: {c}")
    lines.append("")
    lines.append(
        "📥 Загрузка: " + ("всё в Сливы" if mode.get(uid) == "leaks" else "авто")
    )
    rows = [
        [
            InlineKeyboardButton(text=title, callback_data=f"v:{key}:0")
            for key, title in SECTIONS.items()
        ],
        [InlineKeyboardButton(text="📥 Режим загрузки", callback_data="mode")],
    ]
    if view:
        section, page, total = view
        pages = max(1, -(-total // PAGE_SIZE))
        lines.append(f"\n{SECTIONS[section]} · стр. {page + 1}/{pages}")
        if total == 0:
            lines.append("Пусто")
        nav = []
        if page > 0:
            nav.append(
                InlineKeyboardButton(text="⬅️", callback_data=f"v:{section}:{page - 1}")
            )
        if (page + 1) * PAGE_SIZE < total:
            nav.append(
                InlineKeyboardButton(text="➡️", callback_data=f"v:{section}:{page + 1}")
            )
        if nav:
            rows.insert(0, nav)
        rows.append([InlineKeyboardButton(text="🏠 Закрыть", callback_data="home")])
    return "\n".join(lines), InlineKeyboardMarkup(inline_keyboard=rows)


async def render_panel(chat_id, uid, view=None, force_new=False):
    text, kb = await build_panel(uid, view)
    if force_new and uid in panel:
        await safe_delete(chat_id, panel.pop(uid))
    if uid in panel:
        try:
            await bot.edit_message_text(
                text, chat_id=chat_id, message_id=panel[uid], reply_markup=kb
            )
            return
        except TelegramBadRequest as e:
            if "not modified" in str(e):
                return
            panel.pop(uid, None)
        except Exception:
            panel.pop(uid, None)
    msg = await bot.send_message(chat_id, text, reply_markup=kb)
    panel[uid] = msg.message_id


async def refresh_later(chat_id, uid):
    old = refresh_tasks.get(uid)
    if old and not old.done():
        old.cancel()

    async def job():
        try:
            await asyncio.sleep(1.5)
            await render_panel(chat_id, uid)
        except asyncio.CancelledError:
            pass

    refresh_tasks[uid] = asyncio.create_task(job())


async def show_section(chat_id, uid, section, page):
    await clear_view(chat_id, uid, drop_panel=True)
    total = await db_count(section, uid)
    rows = await db_list(uid, section, page) if total else []
    ids = []
    for r in rows:
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="🗑", callback_data=f"del:{r['id']}")]
            ]
        )
        try:
            msg = await send_media(chat_id, r["kind"], r["file_id"], kb)
            ids.append(msg.message_id)
        except Exception as e:
            logging.warning("send failed: %s", e)
    shown[uid] = ids
    await render_panel(chat_id, uid, view=(section, page, total), force_new=True)


# ---------- handlers ----------
async def handle_locked(m: Message):
    uid, chat_id = m.from_user.id, m.chat.id
    await safe_delete(chat_id, m.message_id)
    await clear_view(chat_id, uid, drop_panel=True)
    if m.text and m.text.strip() == PASSWORD:
        unlocked[uid] = time.time() + LOCK_SECONDS
        if uid in prompt:
            await safe_delete(chat_id, prompt.pop(uid))
        await render_panel(chat_id, uid, force_new=True)
        return
    if uid in prompt:
        try:
            await bot.edit_message_text(
                "🔒 Неверный пароль. Введи ещё раз",
                chat_id=chat_id,
                message_id=prompt[uid],
            )
        except Exception:
            pass
    else:
        msg = await bot.send_message(chat_id, "🔒 Введи пароль")
        prompt[uid] = msg.message_id


@dp.message(F.chat.type == "private")
async def on_message(m: Message):
    uid, chat_id = m.from_user.id, m.chat.id
    if not is_auth(uid):
        await handle_locked(m)
        return

    text = (m.text or "").strip()
    if text.startswith("/stats") and uid == ADMIN_ID:
        await safe_delete(chat_id, m.message_id)
        counts = await asyncio.gather(*[db_count(s) for s in SECTIONS])
        stat = "📊 Всего: " + " · ".join(
            f"{t} {c}" for t, c in zip(SECTIONS.values(), counts)
        )
        msg = await bot.send_message(chat_id, stat)
        await asyncio.sleep(5)
        await safe_delete(chat_id, msg.message_id)
        return
    if text.startswith("/start"):
        await safe_delete(chat_id, m.message_id)
        await clear_view(chat_id, uid)
        await render_panel(chat_id, uid, force_new=True)
        return

    item = extract(m, uid)
    if item:
        section, kind, file_id, unique_id = item
        saved = await db_add(uid, section, kind, file_id, unique_id)
        if saved:
            await refresh_later(chat_id, uid)
            await safe_delete(chat_id, m.message_id)
        else:
            await bot.send_message(
                chat_id,
                "⚠️ Не удалось сохранить файл. Сообщение оставлено в чате — попробуй позже."
            )
        return
    await safe_delete(chat_id, m.message_id)


@dp.callback_query()
async def on_callback(c: CallbackQuery):
    uid = c.from_user.id
    chat_id = c.message.chat.id
    if not is_auth(uid):
        await c.answer()
        if uid not in prompt:
            msg = await bot.send_message(chat_id, "🔒 Сессия завершена. Введи пароль одним сообщением.")
            prompt[uid] = msg.message_id
        return
    data = c.data or ""
    await c.answer()

    if data.startswith("v:"):
        _, section, page = data.split(":")
        if section in SECTIONS:
            await show_section(chat_id, uid, section, int(page))
    elif data == "home":
        await clear_view(chat_id, uid)
        await render_panel(chat_id, uid)
    elif data == "mode":
        mode[uid] = "auto" if mode.get(uid) == "leaks" else "leaks"
        await render_panel(chat_id, uid)
    elif data.startswith("del:"):
        row_id = int(data.split(":")[1])
        if await db_delete(uid, row_id):
            await safe_delete(chat_id, c.message.message_id)
            if uid in shown and c.message.message_id in shown[uid]:
                shown[uid].remove(c.message.message_id)


# ---------- keep-alive web server (Render) ----------
async def health(_):
    return web.Response(text="ok")


async def self_ping():
    if not SELF_URL:
        return
    while True:
        await asyncio.sleep(600)
        try:
            async with session.get(SELF_URL) as r:
                await r.read()
        except Exception:
            pass


async def main():
    global session
    session = aiohttp.ClientSession()
    app = web.Application()
    app.router.add_get("/", health)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    asyncio.create_task(self_ping())
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
