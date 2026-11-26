import asyncio
import hashlib
import hmac
import io
import json
import logging
import mimetypes
import os
import subprocess
import tempfile
import time
from collections import OrderedDict
from urllib.parse import quote

import aiohttp
from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter
from aiogram.filters import CommandStart
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    MenuButtonWebApp,
    WebAppInfo,
    BufferedInputFile,
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
thumbnail_tasks: set[asyncio.Task] = set()
placeholder_thumbnails: dict[str, str] = {}

# Small in-process cache prevents repeat downloads of the same Telegram media.
media_cache = OrderedDict()
media_cache_bytes = 0
MEDIA_CACHE_MAX = 48 * 1024 * 1024
MEDIA_CACHE_TTL = 600
media_download_slots = asyncio.Semaphore(4)


# ---------- Supabase ----------
def _headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    if extra:
        h.update(extra)
    return h


async def db_add(uid, section, kind, file_id, unique_id, thumb_file_id=None, file_name=None):
    async with session.post(
        f"{SUPABASE_URL}/rest/v1/media?on_conflict=user_id,file_unique_id",
        json={
            "user_id": uid,
            "section": section,
            "kind": kind,
            "file_id": file_id,
            "file_unique_id": unique_id,
            "thumb_file_id": thumb_file_id,
            "file_name": (file_name or f"{kind}-{unique_id[:10]}")[:180],
        },
        headers=_headers(
            {"Prefer": "resolution=ignore-duplicates,return=representation"}
        ),
    ) as r:
        if r.status >= 300:
            logging.error("db_add %s %s", r.status, await r.text())
            return False
        try:
            inserted = await r.json()
        except Exception:
            inserted = []
        if not inserted:
            logging.info("Duplicate media ignored user=%s unique_id=%s", uid, unique_id)
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


async def db_set_thumbnail(row_id, thumb_file_id):
    url = f"{SUPABASE_URL}/rest/v1/media?id=eq.{row_id}"
    async with session.patch(
        url, json={"thumb_file_id": thumb_file_id},
        headers=_headers({"Prefer": "return=minimal"}),
    ) as r:
        if r.status >= 300:
            logging.error("thumbnail save failed row=%s status=%s body=%s",
                          row_id, r.status, await r.text())
            return False
        return True


async def db_missing_thumbnails(after_id=0):
    url = (
        f"{SUPABASE_URL}/rest/v1/media"
        "?select=id,user_id,kind,file_id,thumb_file_id"
        "&kind=in.(video,video_note,animation)"
        f"&id=gt.{int(after_id)}&order=id.asc&limit=500"
    )
    async with session.get(url, headers=_headers()) as r:
        if r.status >= 300:
            logging.error("thumbnail backfill query failed: %s %s", r.status, await r.text())
            return []
        return await r.json()


_cover_upload_lock = asyncio.Lock()
_last_cover_upload_at = 0.0

async def send_cover_document(uid, document):
    """Serialize cover uploads to stay below Telegram per-chat flood limits."""
    global _last_cover_upload_at
    async with _cover_upload_lock:
        while True:
            wait = 8.0 - (time.monotonic() - _last_cover_upload_at)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                sent = await bot.send_document(
                    chat_id=uid, document=document, disable_notification=True
                )
                _last_cover_upload_at = time.monotonic()
                return sent
            except TelegramRetryAfter as exc:
                _last_cover_upload_at = time.monotonic()
                delay = max(1, int(exc.retry_after)) + 1
                logging.warning("Telegram cover upload rate limit; retry in %ss", delay)
                await asyncio.sleep(delay)

async def make_thumbnail_from_image(uid, image_file_id, row_id):
    """Turn Telegram's native still thumbnail into a small looping animated GIF."""
    try:
        tg_file = await bot.get_file(image_file_id, request_timeout=20)
        image_buffer = io.BytesIO()
        await bot.download_file(tg_file.file_path, image_buffer, timeout=30)
        from PIL import Image
        source = Image.open(io.BytesIO(image_buffer.getvalue())).convert("RGB")
        source.thumbnail((320, 400), Image.Resampling.LANCZOS)
        width, height = source.size
        frames = []
        for step in range(12):
            zoom = 1.0 + (step / 11) * 0.07
            crop_w = max(1, int(width / zoom))
            crop_h = max(1, int(height / zoom))
            left = (width - crop_w) // 2
            top = (height - crop_h) // 2
            frame = source.crop((left, top, left + crop_w, top + crop_h))
            frame = frame.resize((width, height), Image.Resampling.LANCZOS)
            frames.append(frame)
        output = io.BytesIO()
        frames[0].save(
            output, format="GIF", save_all=True, append_images=frames[1:],
            duration=140, loop=0, optimize=True
        )
        gif_bytes = output.getvalue()
        if not gif_bytes or len(gif_bytes) > 4 * 1024 * 1024:
            return None
        sent = await send_cover_document(
            uid, BufferedInputFile(gif_bytes, filename=f"arc-cover-{row_id}.gif")
        )
        thumb_id = sent.document.file_id
        await safe_delete(uid, sent.message_id)
        logging.info("animated GIF cover generated from native thumbnail row=%s", row_id)
        return thumb_id
    except Exception:
        logging.exception("native-thumbnail GIF conversion failed row=%s", row_id)
        return None


async def make_thumbnail(uid, file_id, row_id, *, backfill=False):
    """Create a short looping animated GIF cover and store its Telegram file_id."""
    try:
        tg_file = await bot.get_file(file_id, request_timeout=30)
        if tg_file.file_size and tg_file.file_size > 20 * 1024 * 1024:
            logging.warning("animated cover skipped row=%s: Telegram download limit exceeded (%s bytes)",
                            row_id, tg_file.file_size)
            return None
        source = io.BytesIO()
        await bot.download_file(
            tg_file.file_path, source, timeout=90, chunk_size=256 * 1024
        )
        media_bytes = source.getvalue()
        if not media_bytes or len(media_bytes) > 20 * 1024 * 1024:
            return None

        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        # MP4 files often keep their index (moov atom) at the end. FFmpeg
        # cannot reliably seek such files when they are piped through stdin.
        # A temporary seekable file avoids the partial-file errors seen in Render logs.
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(prefix="arc-cover-", suffix=".media", delete=False) as tmp:
                tmp.write(media_bytes)
                temp_path = tmp.name
            command = [
                ffmpeg, "-hide_banner", "-loglevel", "error",
                "-i", temp_path, "-t", "2.5", "-an",
                "-filter_complex",
                "[0:v]fps=8,scale=320:-1:flags=lanczos,split[a][b];"
                "[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer",
                "-loop", "0", "-f", "gif", "pipe:1",
            ]
            proc = await asyncio.create_subprocess_exec(
                *command, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                gif_bytes, error = await asyncio.wait_for(
                    proc.communicate(), timeout=45
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                logging.warning("animated cover ffmpeg timeout row=%s", row_id)
                return None
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    logging.warning("temporary cover input cleanup failed row=%s", row_id)
        if proc.returncode != 0 or not gif_bytes or len(gif_bytes) > 8 * 1024 * 1024:
            logging.warning("animated cover conversion failed row=%s: %s",
                            row_id, error.decode("utf-8", "ignore")[:300])
            return None

        sent = await send_cover_document(
            uid, BufferedInputFile(gif_bytes, filename=f"arc-cover-{row_id}.gif")
        )
        thumb_id = sent.document.file_id
        try:
            await bot.delete_message(uid, sent.message_id)
        except Exception as exc:
            logging.warning("temporary animated cover cleanup failed row=%s: %s", row_id, exc)
        logging.info("animated GIF cover generated row=%s backfill=%s", row_id, backfill)
        return thumb_id
    except Exception:
        logging.exception("animated GIF cover generation failed row=%s backfill=%s", row_id, backfill)
        return None

async def generate_and_attach_thumbnail(uid, file_id, unique_id):
    try:
        url = (
            f"{SUPABASE_URL}/rest/v1/media?select=id,kind,thumb_file_id"
            f"&user_id=eq.{uid}&file_unique_id=eq.{unique_id}&limit=1"
        )
        async with session.get(url, headers=_headers()) as r:
            rows = await r.json() if r.status < 300 else []
        if not rows:
            return
        row = rows[0]
        row_id = row["id"]
        thumb_id = await make_thumbnail(uid, file_id, row_id)
        if not thumb_id and row.get("thumb_file_id"):
            thumb_id = await make_thumbnail_from_image(
                uid, row["thumb_file_id"], row_id
            )
        if thumb_id:
            await db_set_thumbnail(row_id, thumb_id)
        else:
            logging.warning("Cover remains pending; will retry in maintenance pass row=%s", row_id)
    except Exception:
        logging.exception("async thumbnail attach failed unique_id=%s", unique_id)


def make_placeholder_image(kind):
    """Create a small looping GIF fallback cover, not a static JPEG."""
    from PIL import Image, ImageDraw
    frames = []
    width, height = 320, 400
    palettes = {
        "video": ((31, 39, 67), (49, 112, 145)),
        "video_note": ((32, 27, 58), (105, 68, 160)),
        "animation": ((49, 30, 66), (151, 73, 139)),
    }
    top, bottom = palettes.get(kind, palettes["video"])
    label = {"video": "VIDEO", "video_note": "VIDEO NOTE", "animation": "GIF"}.get(kind, "MEDIA")
    for frame_index in range(12):
        shift = frame_index / 11
        image = Image.new("RGB", (width, height))
        draw = ImageDraw.Draw(image)
        for y in range(height):
            t = min(1, max(0, y / height + (shift - 0.5) * 0.12))
            color = tuple(int(top[c] * (1-t) + bottom[c] * t) for c in range(3))
            draw.line((0, y, width, y), fill=color)
        pulse = int(5 * (1 + __import__("math").sin(frame_index * 2 * __import__("math").pi / 12)))
        draw.rounded_rectangle((54-pulse, 68-pulse, 266+pulse, 280+pulse),
                               radius=42, outline="white", width=4)
        if kind == "video_note":
            draw.ellipse((111, 121, 209, 219), outline="white", width=7)
            draw.ellipse((151, 161, 169, 179), fill="white")
        else:
            draw.polygon([(132, 119), (132, 229), (218, 174)], fill="white")
        try:
            from PIL import ImageFont
            font = ImageFont.truetype("DejaVuSans-Bold.ttf", 22)
        except OSError:
            font = ImageFont.load_default()
        box = draw.textbbox((0, 0), label, font=font)
        draw.text(((width-(box[2]-box[0]))/2, 315), label, font=font, fill="white")
        frames.append(image)
    output = io.BytesIO()
    frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:],
                   duration=110, loop=0, optimize=True, disposal=2)
    return output.getvalue()

async def get_placeholder_thumbnail(uid, kind):
    """Upload one reusable fallback cover per media kind."""
    if kind in placeholder_thumbnails:
        return placeholder_thumbnails[kind]
    try:
        animation = BufferedInputFile(
            make_placeholder_image(kind), filename=f"arc-{kind}-cover.gif"
        )
        sent = await send_cover_document(uid, animation)
        thumb_id = sent.document.file_id
        placeholder_thumbnails[kind] = thumb_id
        try:
            await bot.delete_message(uid, sent.message_id)
        except Exception as exc:
            logging.warning("placeholder message cleanup failed: %s", exc)
        return thumb_id
    except Exception:
        logging.exception("placeholder cover upload failed kind=%s", kind)
        return None


async def backfill_missing_thumbnails():
    """Upgrade every video-like media cover to an animated GIF using keyset pagination."""
    # Wait until Render's rolling deployment has stopped the previous instance.
    await asyncio.sleep(45)
    last_id = 0
    total = done = failed = 0
    while True:
        rows = await db_missing_thumbnails(last_id)
        if not rows:
            break
        for row in rows:
            last_id = int(row["id"])
            existing = row.get("thumb_file_id")
            if existing:
                try:
                    old_thumb = await bot.get_file(existing, request_timeout=15)
                    if (old_thumb.file_path or "").lower().endswith(".gif"):
                        continue
                except Exception:
                    logging.warning("Existing cover unreadable row=%s; replacing", row["id"])
            total += 1
            thumb_id = await make_thumbnail(
                int(row["user_id"]), row["file_id"], row["id"], backfill=True
            )
            if not thumb_id and row.get("thumb_file_id"):
                thumb_id = await make_thumbnail_from_image(
                    int(row["user_id"]), row["thumb_file_id"], row["id"]
                )
            if thumb_id and await db_set_thumbnail(row["id"], thumb_id):
                done += 1
            else:
                failed += 1
                logging.warning(
                    "Cover still missing row=%s kind=%s; retrying next maintenance pass",
                    row["id"], row["kind"]
                )
            if total % 10 == 0:
                logging.info(
                    "Thumbnail backfill progress: %s generated=%s failed=%s",
                    total, done, failed
                )
            await asyncio.sleep(1.0)
    logging.info(
        "Thumbnail backfill finished: generated=%s failed=%s total=%s",
        done, failed, total
    )


async def thumbnail_maintenance_loop():
    """Retry any missing covers periodically, including uploads that failed once."""
    while True:
        try:
            await backfill_missing_thumbnails()
        except Exception:
            logging.exception("thumbnail maintenance pass failed")
        await asyncio.sleep(6 * 60 * 60)


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
    """Returns (section, kind, file_id, unique_id, thumbnail_file_id) or None."""
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
    thumb = getattr(f, "thumbnail", None)
    thumb_file_id = thumb.file_id if thumb else (f.file_id if kind == "photo" else None)
    file_name = (getattr(f, "file_name", None) or m.caption or f"{kind}-{f.file_unique_id[:10]}").strip()[:180]
    return sec, kind, f.file_id, f.file_unique_id, thumb_file_id, file_name


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


def make_session_token(uid: int) -> str:
    expires = int(time.time()) + LOCK_SECONDS
    payload = f"{uid}.{expires}"
    signature = hmac.new(BOT_TOKEN.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def session_uid(token: str):
    try:
        uid_text, expires_text, signature = token.rsplit(".", 2)
        payload = f"{uid_text}.{expires_text}"
        expected = hmac.new(BOT_TOKEN.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return None
        uid, expires = int(uid_text), int(expires_text)
        if uid <= 0 or expires <= time.time():
            return None
        return uid
    except (ValueError, TypeError):
        return None


def api_user(request):
    user = telegram_user(request.headers.get("X-Telegram-Init-Data", "") or request.query.get("tgWebAppData", ""))
    if user:
        return int(user["id"]), user
    uid = session_uid(request.cookies.get("arc_session", ""))
    if uid:
        return uid, {"id": uid}
    return None


def api_auth(request):
    data = api_user(request)
    if not data:
        return None
    uid, user = data
    cookie_uid = session_uid(request.cookies.get("arc_session", ""))
    if not is_auth(uid) and cookie_uid != uid:
        return None
    return uid, user


async def api_json_error(message, status=400):
    return web.json_response({"error": message}, status=status)


async def site_login(request):
    """Password login for the standalone ARC website; bind the session to the archive owner."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict) or not isinstance(body.get("password"), str):
        return await api_json_error("Wrong password", 403)
    if not hmac.compare_digest(body["password"], PASSWORD):
        return await api_json_error("Wrong password", 403)
    response = web.json_response({"ok": True})
    response.set_cookie(
        "arc_session", make_session_token(ADMIN_ID), max_age=LOCK_SECONDS,
        httponly=True, secure=True, samesite="Strict", path="/api"
    )
    return response


async def site_logout(_):
    response = web.json_response({"ok": True})
    response.del_cookie("arc_session", path="/api")
    return response


async def site_index(_):
    index_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "index.html")
    if not os.path.isfile(index_path):
        logging.error("Standalone site index missing: %s", index_path)
        return web.Response(text="ARC website build is missing", status=503)
    return web.FileResponse(index_path, headers={"Cache-Control": "no-store"})


async def api_me(request):
    data = api_user(request)
    if not data:
        return web.json_response({"error": "Invalid Telegram session"}, status=401)
    uid, user = data
    return web.json_response({"authorized": is_auth(uid) or session_uid(request.cookies.get("arc_session", "")) == uid, "user": user})


async def api_unlock(request):
    data = api_user(request)
    if not data:
        return await api_json_error("Invalid Telegram session", 401)
    uid, _ = data
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict) or body.get("password") != PASSWORD:
        return await api_json_error("Wrong password", 403)
    unlocked[uid] = time.time() + LOCK_SECONDS
    response = web.json_response({"ok": True})
    response.set_cookie(
        "arc_session", make_session_token(uid), max_age=LOCK_SECONDS,
        httponly=True, secure=True, samesite="Strict", path="/api"
    )
    return response


async def api_summary(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, user = data
    count_values = await asyncio.gather(*[db_count(key, uid) for key in SECTIONS])
    counts = dict(zip(SECTIONS, count_values))
    async with session.get(
        f"{SUPABASE_URL}/rest/v1/media?select=id&user_id=eq.{uid}&is_favorite=eq.true&limit=1",
        headers=_headers({"Prefer": "count=exact"}),
    ) as r:
        if r.status >= 300:
            logging.error("favorite count %s %s", r.status, await r.text())
            return await api_json_error("Не удалось загрузить статистику", 500)
        favorite_range = r.headers.get("Content-Range", "*/0")
    try:
        favorites = int(favorite_range.split("/")[-1])
    except (ValueError, IndexError):
        favorites = 0
    return web.json_response({"counts": counts, "favorites": favorites,
                              "mode": mode.get(uid, "auto"), "user": user})


async def api_media(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    section = request.query.get("section", "")
    if section not in (*SECTIONS, "favorites", "all"):
        return await api_json_error("Unknown section")
    try:
        page = min(100000, max(0, int(request.query.get("page", "0"))))
    except ValueError:
        page = 0
    kind = request.query.get("kind", "").strip()
    if kind not in ("photo", "video", "animation", "video_note"):
        kind = ""
    query = request.query.get("q", "").strip()[:100]
    query = query.replace("%", "").replace("*", "").replace(",", " ").replace("(", " ").replace(")", " ").replace("\\", " ").replace(chr(34), " ").replace("'", " ").strip()
    params = {
        "select": "id,kind,thumb_file_id,file_name,is_favorite",
        "user_id": f"eq.{uid}", "order": "id.desc",
        "limit": str(PAGE_SIZE), "offset": str(page * PAGE_SIZE),
    }
    if section == "favorites":
        params["is_favorite"] = "eq.true"
    elif section != "all":
        params["section"] = f"eq.{section}"
    if kind:
        params["kind"] = f"eq.{kind}"
    if query:
        params["file_name"] = f"ilike.*{query}*"
    async with session.get(
        f"{SUPABASE_URL}/rest/v1/media", params=params,
        headers=_headers({"Prefer": "count=exact"}),
    ) as r:
        if r.status >= 300:
            logging.error("api_media list %s %s", r.status, await r.text())
            return await api_json_error("Database error", 500)
        items = await r.json()
        content_range = r.headers.get("Content-Range", "*/0")
    try:
        total = int(content_range.split("/")[-1])
    except (ValueError, IndexError):
        total = 0
    logging.info(
        "api_media page uid=%s section=%s kind=%s page=%s returned=%s total=%s",
        uid, section, kind or "all", page, len(items), total
    )
    return web.json_response({"items": items, "total": total})


async def api_media_file(request):
    global media_cache_bytes
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    row_id = request.match_info["row_id"]
    if not (row_id.isascii() and row_id.isdecimal()):
        return await api_json_error("Invalid media id", 400)
    cache_key = f"{uid}:{row_id}"
    cached = media_cache.get(cache_key)
    payload = None
    kind = None
    file_name = ""
    if cached and time.monotonic() - cached[0] < MEDIA_CACHE_TTL:
        _, payload, kind, file_name = cached
        media_cache.move_to_end(cache_key)
    else:
        if cached:
            media_cache_bytes -= len(cached[1])
            media_cache.pop(cache_key, None)
        url = (f"{SUPABASE_URL}/rest/v1/media?select=kind,file_id,file_name"
               f"&id=eq.{row_id}&user_id=eq.{uid}")
        async with session.get(url, headers=_headers()) as r:
            if r.status >= 300:
                return await api_json_error("Database error", 500)
            rows = await r.json()
        if not rows:
            return await api_json_error("File not found", 404)
        kind = rows[0]["kind"]
        file_name = rows[0].get("file_name") or ""
        async with media_download_slots:
            # Another request may have populated the cache while this one waited.
            cached = media_cache.get(cache_key)
            if cached and time.monotonic() - cached[0] < MEDIA_CACHE_TTL:
                _, payload, kind, file_name = cached
                media_cache.move_to_end(cache_key)
            else:
                last_error = None
                for attempt in range(3):
                    try:
                        tg_file = await bot.get_file(rows[0]["file_id"], request_timeout=45)
                        buffer = io.BytesIO()
                        await bot.download_file(
                            tg_file.file_path, buffer, timeout=120, chunk_size=512 * 1024
                        )
                        payload = buffer.getvalue()
                        break
                    except Exception as e:
                        last_error = e
                        logging.warning(
                            "Media download attempt %s/3 failed for row=%s: %s",
                            attempt + 1, row_id, e
                        )
                        # Telegram's hosted Bot API cannot download files above its size limit.
                        # Retrying the same request cannot help and only stalls the archive.
                        if "file is too big" in str(e).lower():
                            break
                        if attempt < 2:
                            await asyncio.sleep(0.7 * (attempt + 1))
                if payload is None:
                    logging.error("Telegram media download failed row=%s: %s", row_id, last_error)
                    if last_error and "file is too big" in str(last_error).lower():
                        return await api_json_error(
                            "Файл превышает лимит загрузки стандартного Telegram Bot API. Для больших файлов нужен отдельный сервер Telegram Bot API.",
                            413
                        )
                    return await api_json_error(
                        "Не удалось получить файл из Telegram. Попробуй обновить страницу.", 502
                    )
                if len(payload) <= MEDIA_CACHE_MAX:
                    media_cache[cache_key] = (time.monotonic(), payload, kind, file_name)
                    media_cache_bytes += len(payload)
                    while media_cache_bytes > MEDIA_CACHE_MAX and media_cache:
                        _, evicted = media_cache.popitem(last=False)
                        media_cache_bytes -= len(evicted[1])

    guessed_type = mimetypes.guess_type(file_name)[0] if file_name else None
    content_type = {
        "photo": "image/jpeg", "video": "video/mp4",
        "video_note": "video/mp4", "animation": guessed_type or "video/mp4"
    }.get(kind, guessed_type or "application/octet-stream")
    etag = f'W/"{row_id}-{len(payload)}"'
    download_name = file_name or "arc-" + row_id
    headers = {
        "Cache-Control": "private, max-age=600, stale-while-revalidate=60",
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Content-Disposition": "inline" if kind != "document" else f"attachment; filename*=UTF-8''{quote(download_name, safe='')}",
    }
    if request.headers.get("If-None-Match") == etag and not request.headers.get("Range"):
        return web.Response(status=304, headers=headers)
    range_header = request.headers.get("Range", "")
    if range_header.startswith("bytes=") and "," not in range_header:
        try:
            start_text, end_text = range_header[6:].split("-", 1)
            if not start_text and end_text:
                suffix = int(end_text)
                start = max(0, len(payload) - suffix)
                end = len(payload) - 1
            else:
                start = int(start_text) if start_text else 0
                end = int(end_text) if end_text else len(payload) - 1
            if start < 0 or start >= len(payload) or end < start:
                return web.Response(status=416, headers={"Content-Range": f"bytes */{len(payload)}"})
            end = min(end, len(payload) - 1)
            chunk = payload[start:end + 1]
            headers["Content-Range"] = f"bytes {start}-{end}/{len(payload)}"
            headers["Content-Length"] = str(len(chunk))
            return web.Response(status=206, body=chunk, content_type=content_type, headers=headers)
        except (ValueError, TypeError):
            pass
    headers["Content-Length"] = str(len(payload))
    return web.Response(body=payload, content_type=content_type, headers=headers)


async def api_media_cover(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    row_id = request.match_info["row_id"]
    if not (row_id.isascii() and row_id.isdecimal()):
        return await api_json_error("Invalid media id", 400)
    url = (f"{SUPABASE_URL}/rest/v1/media?select=kind,file_id,thumb_file_id"
           f"&id=eq.{row_id}&user_id=eq.{uid}")
    async with session.get(url, headers=_headers()) as r:
        if r.status >= 300:
            return await api_json_error("Database error", 500)
        rows = await r.json()
    if not rows:
        return await api_json_error("File not found", 404)
    item = rows[0]
    thumb_id = item.get("thumb_file_id")
    if not thumb_id and item["kind"] == "photo":
        thumb_id = item["file_id"]
    if not thumb_id:
        return await api_json_error("Для этого старого файла обложка не сохранена", 404)
    try:
        tg_file = await bot.get_file(thumb_id, request_timeout=20)
        buffer = io.BytesIO()
        await bot.download_file(tg_file.file_path, buffer, timeout=30)
        body = buffer.getvalue()
        path = (tg_file.file_path or "").lower()
        mime = "image/gif" if path.endswith(".gif") else (
            "video/mp4" if path.endswith(".mp4") else "image/jpeg"
        )
        return web.Response(body=body, content_type=mime,
                            headers={"Cache-Control":"private, max-age=3600"})
    except Exception:
        logging.exception("Thumbnail fetch failed row=%s", row_id)
        return await api_json_error("Не удалось загрузить обложку", 502)


async def api_toggle_favorite(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    row_id = request.match_info["row_id"]
    if not (row_id.isascii() and row_id.isdecimal()):
        return await api_json_error("Invalid media id", 400)
    try:
        body = await request.json()
    except Exception:
        return await api_json_error("Invalid request")
    if not isinstance(body, dict) or not isinstance(body.get("favorite"), bool):
        return await api_json_error("Invalid request")
    favorite = body["favorite"]
    url = f"{SUPABASE_URL}/rest/v1/media?id=eq.{row_id}&user_id=eq.{uid}"
    async with session.patch(url, json={"is_favorite": favorite},
                             headers=_headers({"Prefer": "return=representation"})) as r:
        if r.status >= 300:
            logging.error("favorite update %s %s", r.status, await r.text())
            return await api_json_error("Не удалось обновить избранное", 500)
        rows = await r.json()
    if not rows:
        return await api_json_error("File not found", 404)
    return web.json_response({"ok": True, "is_favorite": rows[0].get("is_favorite", favorite)})


async def api_profile(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, user = data
    url = f"{SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.{uid}&select=user_id,display_name,accent,theme,density"
    if request.method == "GET":
        async with session.get(url, headers=_headers()) as r:
            if r.status >= 300:
                logging.error("profile read %s %s", r.status, await r.text())
                return await api_json_error("Не удалось загрузить профиль", 500)
            rows = await r.json()
        profile = rows[0] if rows else {}
        if not profile.get("display_name"):
            profile["display_name"] = user.get("first_name", "Пользователь")
        profile.setdefault("accent", "#a98dff")
        profile.setdefault("theme", "dark")
        profile.setdefault("density", "comfortable")
        return web.json_response({"profile": profile, "telegram": user})
    try:
        body = await request.json()
    except Exception:
        return await api_json_error("Invalid request")
    if not isinstance(body, dict):
        return await api_json_error("Invalid request")
    accents = {"#a98dff", "#63b3ed", "#70d6a5", "#ff9f70", "#f28bb8", "#f4d06f"}
    accent, theme, density = body.get("accent", "#a98dff"), body.get("theme", "dark"), body.get("density", "comfortable")
    raw_name = body.get("display_name", "")
    if not isinstance(raw_name, str) or not isinstance(accent, str) or not isinstance(theme, str) or not isinstance(density, str):
        return await api_json_error("Некорректные настройки профиля")
    display_name = raw_name.strip()[:32]
    if accent not in accents or theme not in ("dark", "light") or density not in ("compact", "comfortable"):
        return await api_json_error("Некорректные настройки профиля")
    payload = {"user_id": uid, "display_name": display_name, "accent": accent,
               "theme": theme, "density": density}
    async with session.post(f"{SUPABASE_URL}/rest/v1/user_profiles?on_conflict=user_id",
                            json=payload,
                            headers=_headers({"Prefer": "resolution=merge-duplicates,return=representation"})) as r:
        if r.status >= 300:
            logging.error("profile save %s %s", r.status, await r.text())
            return await api_json_error("Не удалось сохранить настройки", 500)
        rows = await r.json()
    return web.json_response({"ok": True, "profile": rows[0] if rows else payload})


async def api_send_media(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    row_id = request.match_info["row_id"]
    if not (row_id.isascii() and row_id.isdecimal()):
        return await api_json_error("Invalid media id", 400)
    url = f"{SUPABASE_URL}/rest/v1/media?select=kind,file_id&id=eq.{row_id}&user_id=eq.{uid}"
    async with session.get(url, headers=_headers()) as r:
        if r.status >= 300:
            return await api_json_error("Database error", 500)
        rows = await r.json()
    if not rows:
        return await api_json_error("File not found", 404)
    item = rows[0]
    try:
        await send_media(uid, item["kind"], item["file_id"], None)
        return web.json_response({"ok": True})
    except Exception:
        logging.exception("Could not send media to Telegram chat user=%s row=%s", uid, row_id)
        return await api_json_error("Не удалось отправить медиа в Telegram", 502)


async def api_delete_media(request):
    data = api_auth(request)
    if not data:
        return web.json_response({"auth_required": True}, status=401)
    uid, _ = data
    row_id = request.match_info["row_id"]
    if not (row_id.isascii() and row_id.isdecimal()):
        return await api_json_error("Invalid media id", 400)
    ok = await db_delete(uid, row_id)
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


@dp.message(CommandStart(), F.chat.type == "private")
async def on_start(m: Message):
    await m.answer(
        "ARC готов. Отправляй сюда фото, видео, видеокружки, GIF или документы — "
        "они сохранятся в архиве. Открой архив кнопкой меню Telegram «Открыть ARC». "
        "Чтобы отправить файл из архива обратно в чат, используй кнопку «В Telegram» в Mini App."
    )


@dp.message(F.chat.type == "private")
async def on_message(m: Message):
    uid, chat_id = m.from_user.id, m.chat.id
    # The bot is an upload-only endpoint: no password gate here.
    # Password protection remains enabled for the Mini App API.
    item = extract(m, uid)
    if item:
        section, kind, file_id, unique_id, thumb_file_id, file_name = item
        saved = await db_add(uid, section, kind, file_id, unique_id, thumb_file_id, file_name)
        if saved:
            # Telegram normally supplies video thumbnails; generate one asynchronously if absent.
            if kind in ("video", "video_note", "animation"):
                task = asyncio.create_task(
                    generate_and_attach_thumbnail(uid, file_id, unique_id)
                )
                thumbnail_tasks.add(task)
                task.add_done_callback(thumbnail_tasks.discard)
            await safe_delete(chat_id, m.message_id)
        else:
            logging.error("Media save failed; original message retained user=%s", uid)
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


async def miniapp_index(_):
    index_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "miniapp", "index.html")
    if not os.path.isfile(index_path):
        logging.error("Mini App index missing: %s", index_path)
        return web.Response(text="ARC Mini App build is missing", status=503)
    return web.FileResponse(index_path, headers={"Cache-Control": "no-store"})


async def miniapp_redirect(_):
    raise web.HTTPFound("/app/")


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
    timeout = aiohttp.ClientTimeout(total=25, connect=6, sock_read=18)
    connector = aiohttp.TCPConnector(limit=100, limit_per_host=30, ttl_dns_cache=300, keepalive_timeout=30)
    session = aiohttp.ClientSession(timeout=timeout, connector=connector)
    app = web.Application()
    app.router.add_get("/", site_index)
    app.router.add_get("/health", health)
    app.router.add_get("/site/", site_index)
    app.router.add_post("/site/login", site_login)
    app.router.add_post("/site/logout", site_logout)
    app.router.add_get("/app", miniapp_redirect)
    app.router.add_get("/app/", miniapp_index)
    app.router.add_get("/api/me", api_me)
    app.router.add_post("/api/unlock", api_unlock)
    app.router.add_get("/api/summary", api_summary)
    app.router.add_get("/api/media", api_media)
    app.router.add_get("/api/media/{row_id}/file", api_media_file)
    app.router.add_get("/api/media/{row_id}/cover", api_media_cover)
    app.router.add_post("/api/media/{row_id}/favorite", api_toggle_favorite)
    app.router.add_get("/api/profile", api_profile)
    app.router.add_post("/api/profile", api_profile)
    app.router.add_post("/api/media/{row_id}/send", api_send_media)
    app.router.add_delete("/api/media/{row_id}", api_delete_media)
    app.router.add_post("/api/mode", api_mode)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    asyncio.create_task(self_ping())
    await bot.delete_webhook(drop_pending_updates=True)
    await configure_menu_button()
    asyncio.create_task(thumbnail_maintenance_loop())
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
