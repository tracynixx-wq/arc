import asyncio
import hashlib
import hmac
import io
import json
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
    MenuButtonWebApp,
    WebAppInfo,
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
PAGE_SIZE = 10
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://arc-zh7i.onrender.com/app/")

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


# ---------- Telegram Mini App auth and API ----------
def telegram_user(init_data: str):
    if not init_data:
        return None
    from urllib.parse import parse_qsl
    try:
        values = dict(parse_qsl(init_data, keep_blank_values=True))
        received_hash = values.pop("hash", "")
        if not received_hash:
            return None
        check_string = "\n".join(f"{k}={v}" for k, v in sorted(values.items()))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, received_hash):
            return None
        if int(time.time()) - int(values.get("auth_date", "0")) > 86400:
            return None
        user = json.loads(values.get("user", "{}"))
        return user if user.get("id") else None
    except Exception:
        return None


def api_user(request):
    user = telegram_user(request.headers.get("X-Telegram-Init-Data", ""))
    if not user:
        return None
    return int(user["id"]), user


def api_auth(request):
    data = api_user(request)
    if not data:
        return None
    uid, user = data
    if not is_auth(uid):
        return None
    return uid, user


async def api_json_error(message, status=400):
    return web.json_response({"error": message}, status=status)


async def api_me(request):
    data = api_user(request)
    if not data:
        return web.json_response({"error": "Invalid Telegram session"}, status=401)
    uid, user = data
    return web.json_response({"authorized": is_auth(uid), "user": user})


async def api_unlock(request):
    data = api_user(request)
    if not data:
        return await api_json_error("Invalid Telegram session", 401)
    uid, _ = data
    try:
        body = await request.json()
    except Exception:
        body = {}
    if body.get("password") != PASSWORD:
        return await api_json_error("Wrong password", 403)
    unlocked[uid] = time.time() + LOCK_SECONDS
    return web.json_response({"ok": True})


async def api_summary(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, user = data
    counts = {key: await db_count(key, uid) for key in SECTIONS}
    return web.json_response({"counts": counts, "mode": mode.get(uid, "auto"), "user": user})


async def api_media(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    section = request.query.get("section", "")
    if section not in SECTIONS:
        return await api_json_error("Unknown section")
    try:
        page = max(0, int(request.query.get("page", "0")))
    except ValueError:
        page = 0
    url = (f"{SUPABASE_URL}/rest/v1/media?select=id,kind"
           f"&user_id=eq.{uid}&section=eq.{section}"
           f"&order=id.desc&limit=10&offset={page * 10}")
    async with session.get(url, headers=_headers()) as r:
        if r.status >= 300:
            logging.error("api_media list %s %s", r.status, await r.text())
            return await api_json_error("Database error", 500)
        items = await r.json()
    total = await db_count(section, uid)
    return web.json_response({"items": items, "total": total})


async def api_media_file(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    row_id = request.match_info["row_id"]
    url = f"{SUPABASE_URL}/rest/v1/media?select=kind,file_id&id=eq.{row_id}&user_id=eq.{uid}"
    async with session.get(url, headers=_headers()) as r:
        if r.status >= 300:
            return await api_json_error("Database error", 500)
        rows = await r.json()
    if not rows:
        return await api_json_error("File not found", 404)
    try:
        tg_file = await bot.get_file(rows[0]["file_id"])
        buffer = io.BytesIO()
        await bot.download_file(tg_file.file_path, buffer)
        content_type = {
            "photo": "image/jpeg", "video": "video/mp4",
            "video_note": "video/mp4", "animation": "video/mp4"
        }.get(rows[0]["kind"], "application/octet-stream")
        return web.Response(body=buffer.getvalue(), content_type=content_type,
                            headers={"Cache-Control": "private, max-age=300"})
    except Exception as e:
        logging.exception("Telegram media download failed: %s", e)
        return await api_json_error("Telegram file unavailable", 502)


async def api_delete_media(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    ok = await db_delete(uid, request.match_info["row_id"])
    return web.json_response({"ok": ok}, status=200 if ok else 404)


async def api_mode(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    mode[uid] = "auto" if mode.get(uid) == "leaks" else "leaks"
    return web.json_response({"mode": mode[uid]})


# ---------- handlers ----------
async def ask_password(chat_id, uid):
    if uid not in prompt:
        msg = await bot.send_message(chat_id, "🔒 Введи пароль")
        prompt[uid] = msg.message_id


async def on_message(m: Message):
    uid, chat_id = m.from_user.id, m.chat.id
    if not is_auth(uid):
        await safe_delete(chat_id, m.message_id)
        if m.text and m.text.strip() == PASSWORD:
            unlocked[uid] = time.time() + LOCK_SECONDS
            if uid in prompt:
                await safe_delete(chat_id, prompt.pop(uid))
            return
        await ask_password(chat_id, uid)
        return

    item = extract(m, uid)
    if item:
        section, kind, file_id, unique_id = item
        saved = await db_add(uid, section, kind, file_id, unique_id)
        if not saved:
            logging.error("Media save failed for user=%s", uid)
        await safe_delete(chat_id, m.message_id)
        return
    await safe_delete(chat_id, m.message_id)


# ---------- startup ----------
async def configure_menu_button():
    try:
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(
                text="Открыть ARC",
                web_app=WebAppInfo(url=WEBAPP_URL),
            )
        )
        logging.info("Telegram Mini App menu button configured")
    except Exception:
        logging.exception("Could not configure Telegram Mini App menu button")


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
    app.router.add_get("/api/me", api_me)
    app.router.add_post("/api/unlock", api_unlock)
    app.router.add_get("/api/summary", api_summary)
    app.router.add_get("/api/media", api_media)
    app.router.add_get("/api/media/{row_id}/file", api_media_file)
    app.router.add_delete("/api/media/{row_id}", api_delete_media)
    app.router.add_post("/api/mode", api_mode)
    app.router.add_static("/app", "miniapp", show_index=True)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    asyncio.create_task(self_ping())
    await bot.delete_webhook(drop_pending_updates=True)
    await configure_menu_button()
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
