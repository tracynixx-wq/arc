import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelegramUser = { id: number };
type TelegramChat = { id: number; type: string };
type TelegramPhoto = { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number };
type TelegramFile = { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number; duration?: number; width?: number; height?: number };
type TelegramMessage = {
  message_id: number;
  date: number;
  from?: TelegramUser;
  chat: TelegramChat;
  media_group_id?: string;
  photo?: TelegramPhoto[];
  video?: TelegramFile;
  animation?: TelegramFile;
  document?: TelegramFile;
  text?: string;
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage };

async function sendTelegramMessage(token: string, chatId: number, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Telegram sendMessage failed");
}

function mediaPayload(message: TelegramMessage) {
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return { type: "photo", file_id: photo.file_id, file_unique_id: photo.file_unique_id,
      mime_type: "image/jpeg", size_bytes: photo.file_size ?? null, width: photo.width, height: photo.height };
  }
  if (message.video) return { type: "video", ...message.video };
  if (message.animation) return { type: "gif", ...message.animation, mime_type: message.animation.mime_type ?? "image/gif" };
  if (message.document) return { type: "other", ...message.document };
  return null;
}

export async function POST(request: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const ownerId = process.env.TELEGRAM_OWNER_ID;

  if (!token || !secret || !ownerId) {
    return NextResponse.json({ error: "Telegram webhook is not configured." }, { status: 503 });
  }

  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 1_000_000) return NextResponse.json({ error: "Payload too large." }, { status: 413 });

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid update." }, { status: 400 });
  }

  const message = update.message;
  if (!Number.isSafeInteger(update.update_id) || !message || !message.from ||
      String(message.from.id) !== ownerId || message.chat.type !== "private" ||
      message.chat.id !== message.from.id) {
    return NextResponse.json({ ok: true });
  }

  const text = message.text?.trim() ?? "";
  const supabase = createSupabaseAdmin();

  if (text.startsWith("/")) {
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
    try {
      if (command === "/start") {
        const webUrl = process.env.ARC_WEB_URL;
        const greeting = webUrl
          ? `ARC подключён. Откройте личный архив: ${webUrl}\nОтправляйте сюда фото, видео и GIF — после надёжного сохранения они появятся на сайте.`
          : "ARC подключён. Отправляйте сюда фото, видео и GIF — после надёжного сохранения они появятся в архиве.";
        await sendTelegramMessage(token, message.chat.id, greeting);
      } else if (command === "/help") {
        await sendTelegramMessage(token, message.chat.id,
          "/status — состояние очередей\n/stats — статистика архива\n/send_all — отправить архив в этот чат\n/cancel — остановить ожидающую отправку\n/help — помощь");
      } else if (command === "/status") {
        const [queued, running, failed] = await Promise.all([
          supabase.from("telegram_jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
          supabase.from("telegram_jobs").select("id", { count: "exact", head: true }).eq("status", "running"),
          supabase.from("telegram_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
        ]);
        await sendTelegramMessage(token, message.chat.id,
          `Очередь ARC\nОжидают: ${queued.count ?? 0}\nВ работе: ${running.count ?? 0}\nОшибки: ${failed.count ?? 0}`);
      } else if (command === "/stats") {
        const [total, videos, gifs, photos] = await Promise.all([
          supabase.from("media").select("id", { count: "exact", head: true }).eq("is_trashed", false),
          supabase.from("media").select("id", { count: "exact", head: true }).eq("media_type", "video").eq("is_trashed", false),
          supabase.from("media").select("id", { count: "exact", head: true }).eq("media_type", "gif").eq("is_trashed", false),
          supabase.from("media").select("id", { count: "exact", head: true }).eq("media_type", "photo").eq("is_trashed", false),
        ]);
        await sendTelegramMessage(token, message.chat.id,
          `Архив ARC\nВсего: ${total.count ?? 0}\nВидео: ${videos.count ?? 0}\nGIF: ${gifs.count ?? 0}\nФото: ${photos.count ?? 0}`);
      } else if (command === "/send_all") {
        const { data: active } = await supabase.from("telegram_jobs").select("id")
          .eq("job_type", "send_archive").in("status", ["queued", "running"]).limit(1);
        if (active?.length) {
          await sendTelegramMessage(token, message.chat.id, "Отправка архива уже стоит в очереди или выполняется.");
        } else {
          const { error } = await supabase.from("telegram_jobs").insert({
            job_type: "send_archive", telegram_chat_id: message.chat.id,
            payload: { requested_by: message.from.id, delivery_mode: "ask" },
          });
          if (error) throw new Error("Could not enqueue archive delivery");
          await sendTelegramMessage(token, message.chat.id, "Полная отправка архива добавлена в очередь.");
        }
      } else if (command === "/cancel") {
        const { data, error } = await supabase.from("telegram_jobs").update({ status: "cancelled" })
          .eq("job_type", "send_archive").eq("status", "queued").select("id");
        if (error) throw new Error("Could not cancel archive delivery");
        await sendTelegramMessage(token, message.chat.id,
          data?.length ? "Ожидающая отправка отменена. Уже отправленные файлы останутся в чате." : "Нет ожидающей отправки для отмены.");
      }
    } catch {
      await sendTelegramMessage(token, message.chat.id, "Не удалось выполнить команду. Ошибка записана; попробуйте позже.");
    }
    return NextResponse.json({ ok: true });
  }

  const media = mediaPayload(message);
  if (!media) return NextResponse.json({ ok: true });

  const { error } = await supabase.from("telegram_jobs").insert({
    job_type: "ingest",
    telegram_update_id: update.update_id,
    telegram_message_id: message.message_id,
    telegram_chat_id: message.chat.id,
    payload: {
      ...media,
      message_date: message.date,
      media_group_id: message.media_group_id ?? null,
      sender_id: message.from.id,
      source_delete_after_verified_save: true,
      caption_ignored: true,
    },
  });

  if (error && error.code !== "23505") {
    return NextResponse.json({ error: "Could not queue media." }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
