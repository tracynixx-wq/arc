import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramApiBase = (process.env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org").replace(/\/$/, "");
const telegramFileBase = (process.env.TELEGRAM_FILE_BASE_URL ?? "https://api.telegram.org/file").replace(/\/$/, "");
const tusEndpointOverride = process.env.SUPABASE_TUS_ENDPOINT;
const workerId = process.env.RENDER_INSTANCE_ID ?? `arc-worker-${randomUUID()}`;

if (!supabaseUrl || !serviceKey || !telegramToken) {
  throw new Error("Worker requires Supabase URL, service role key and Telegram bot token.");
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

type TelegramJob = {
  id: string;
  job_type: string;
  telegram_message_id: number | null;
  telegram_chat_id: number | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

type ProcessingJob = {
  id: string;
  media_id: string | null;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFilename(input: unknown, fallback: string) {
  const raw = typeof input === "string" && input.trim() ? basename(input.trim()) : fallback;
  const cleaned = raw.replace(/[\\/\u0000-\u001f]/g, "_").replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(0, 180);
  return cleaned || fallback;
}

function storageTusEndpoint() {
  if (tusEndpointOverride) return tusEndpointOverride;
  const projectRef = new URL(supabaseUrl!).hostname.split(".")[0];
  return `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`;
}

function streamToFile(source: NodeJS.ReadableStream, destination: string) {
  const hash = createHash("sha256");
  const counter = { bytes: 0 };
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      counter.bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return pipeline(source, transform, createWriteStream(destination)).then(() => ({
    sha256: hash.digest("hex"),
    size: counter.bytes,
  }));
}

async function downloadTelegramFile(fileId: string, destination: string) {
  const infoResponse = await fetch(`${telegramApiBase}/bot${telegramToken}/getFile?file_id=${encodeURIComponent(fileId)}`, { cache: "no-store" });
  if (!infoResponse.ok) throw new Error(`Telegram getFile failed: HTTP ${infoResponse.status}`);
  const info = await infoResponse.json() as { ok?: boolean; description?: string; result?: { file_path?: string } };
  const filePath = info.result?.file_path;
  if (!info.ok || !filePath) throw new Error(info.description ?? "Telegram did not return a file path.");

  if (isAbsolute(filePath) && existsSync(filePath)) {
    const result = await streamToFile(createReadStream(filePath), destination);
    return { ...result, sourcePath: filePath };
  }

  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const fileResponse = await fetch(`${telegramFileBase}/bot${telegramToken}/${encodedPath}`, { cache: "no-store" });
  if (!fileResponse.ok || !fileResponse.body) throw new Error(`Telegram file download failed: HTTP ${fileResponse.status}`);

  const result = await streamToFile(Readable.fromWeb(fileResponse.body as never), destination);
  return { ...result, sourcePath: null };
}

async function uploadTus(filePath: string, bucketName: string, objectName: string, contentType: string) {
  const fileStat = await stat(filePath);
  await new Promise<void>(async (resolve, reject) => {
    const upload = new Upload(createReadStream(filePath), {
      endpoint: storageTusEndpoint(),
      uploadSize: fileStat.size,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey!,
        "x-upsert": "false",
      },
      metadata: {
        bucketName,
        objectName,
        contentType,
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      onError: reject,
      onSuccess: () => resolve(),
    });

    try {
      const previous = await upload.findPreviousUploads();
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    } catch (error) {
      reject(error);
    }
  });
}

async function verifyStorageObject(bucket: string, objectKey: string) {
  const folder = objectKey.split("/").slice(0, -1).join("/");
  const name = objectKey.split("/").at(-1) ?? objectKey;
  const { data, error } = await supabase.storage.from(bucket).list(folder, { search: name, limit: 10 });
  if (error || !data?.some((entry) => entry.name === name)) {
    throw new Error("Uploaded object could not be verified in private storage.");
  }
}

async function telegramCall(method: string, body: Record<string, unknown>): Promise<{ message_id?: number }> {
  const response = await fetch(`${telegramApiBase}/bot${telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json() as { ok?: boolean; description?: string; result?: { message_id?: number } };
  if (!response.ok || !result.ok) throw new Error(result.description ?? `Telegram ${method} failed`);
  return result.result ?? {};
}

async function deleteSourceMessage(chatId: number | null, messageId: number | null, mediaId: string) {
  if (!chatId || !messageId) return;
  try {
    await telegramCall("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (error) {
    await supabase.from("activity_logs").insert({
      action: "telegram.source_delete_failed",
      entity_type: "media",
      entity_id: mediaId,
      details: { message: error instanceof Error ? error.message : "Unknown Telegram error" },
    });
  }
}

async function markTelegramSuccess(job: TelegramJob) {
  await supabase.from("telegram_jobs").update({
    status: "succeeded",
    finished_at: new Date().toISOString(),
    locked_at: null,
    locked_by: null,
    heartbeat_at: null,
    error: null,
  }).eq("id", job.id);
}

async function retryTelegramJob(job: TelegramJob, error: unknown) {
  const exhausted = job.attempts >= job.max_attempts;
  const waitSeconds = Math.min(900, 15 * (2 ** Math.max(0, job.attempts - 1)));
  const message = error instanceof Error ? error.message : "Unknown ingestion error";

  await supabase.from("telegram_jobs").update({
    status: exhausted ? "failed" : "queued",
    available_at: new Date(Date.now() + waitSeconds * 1000).toISOString(),
    locked_at: null,
    locked_by: null,
    heartbeat_at: null,
    finished_at: exhausted ? new Date().toISOString() : null,
    error: { message, retryable: !exhausted },
  }).eq("id", job.id).eq("status", "running");

  if (exhausted && job.telegram_chat_id) {
    try {
      await telegramCall("sendMessage", {
        chat_id: job.telegram_chat_id,
        text: job.job_type === "send_archive"
          ? "ARC не смог завершить отправку архива после нескольких попыток. Отправленные файлы сохранены в истории; повторный запуск пропустит подтверждённые отправки."
          : "ARC не смог сохранить файл после нескольких попыток. Оригинальное сообщение оставлено в чате; подробности записаны в журнал.",
      });
    } catch {
      // The durable job error remains available even if Telegram notification fails.
    }
  }
}

async function processIngest(job: TelegramJob) {
  const payload = job.payload;
  const fileId = typeof payload.file_id === "string" ? payload.file_id : "";
  if (!fileId) throw new Error("Telegram media job has no file_id.");

  const tempDir = await mkdtemp(join(tmpdir(), "arc-ingest-"));
  const localFile = join(tempDir, "original.bin");

  try {
    const downloaded = await downloadTelegramFile(fileId, localFile);
    const existing = await supabase.from("media").select("id")
      .eq("sha256", downloaded.sha256).is("purged_at", null).maybeSingle();
    if (existing.error) throw new Error(`Duplicate check failed: ${existing.error.message}`);
    const mediaId = existing.data?.id ?? job.id;

    if (existing.data) {
      const { data: original } = await supabase.from("media_files").select("storage_bucket,storage_key")
        .eq("media_id", existing.data.id).eq("file_role", "original").eq("is_current", true).maybeSingle();
      if (original) {
        const { data: signed } = await supabase.storage.from(original.storage_bucket).createSignedUrl(original.storage_key, 60);
        if (signed?.signedUrl) {
          await markTelegramSuccess(job);
          await deleteSourceMessage(job.telegram_chat_id, job.telegram_message_id, existing.data.id);
          return;
        }
      }
    }

    const fallbackExtension = payload.type === "video" ? ".mp4" : payload.type === "gif" ? ".gif" : ".jpg";
    const originalFilename = safeFilename(payload.file_name, `arc-${job.telegram_message_id ?? mediaId}${fallbackExtension}`);
    const extension = extname(originalFilename).slice(1).toLowerCase() || fallbackExtension.slice(1);
    const mimeType = typeof payload.mime_type === "string" ? payload.mime_type : payload.type === "gif" ? "image/gif" : payload.type === "video" ? "video/mp4" : "image/jpeg";
    const mediaType = payload.type === "photo" || payload.type === "video" || payload.type === "gif" ? payload.type : "other";

    const { data: nameCollision } = await supabase.from("media").select("id")
      .eq("filename", originalFilename).is("purged_at", null).limit(1);
    const filenameConflict = Boolean(nameCollision?.length);

    const objectKey = `${mediaId}/${originalFilename}`;
    const { data: priorObject } = await supabase.storage.from("arc-originals").list(mediaId, { search: originalFilename, limit: 5 });
    if (priorObject?.some((entry) => entry.name === originalFilename)) {
      await supabase.storage.from("arc-originals").remove([objectKey]);
    }

    await uploadTus(localFile, "arc-originals", objectKey, mimeType);
    await verifyStorageObject("arc-originals", objectKey);

    const messageDate = typeof payload.message_date === "number" ? new Date(payload.message_date * 1000).toISOString() : null;
    const metadata = {
      telegram_file_id: fileId,
      telegram_file_unique_id: typeof payload.file_unique_id === "string" ? payload.file_unique_id : null,
      filename_conflict: filenameConflict,
      original_download_path: downloaded.sourcePath,
      telegram_media_group_id: typeof payload.media_group_id === "string" ? payload.media_group_id : null,
    };

    const { data: existingRow } = await supabase.from("media").select("id").eq("id", mediaId).maybeSingle();
    if (!existingRow) {
      const { error: mediaError } = await supabase.from("media").insert({
        id: mediaId,
        sha256: downloaded.sha256,
        filename: originalFilename,
        extension,
        mime_type: mimeType,
        size_bytes: downloaded.size,
        media_type: mediaType,
        source_message_id: job.telegram_message_id,
        source_chat_id: job.telegram_chat_id,
        album_group_id: typeof payload.media_group_id === "string" ? payload.media_group_id : null,
        album_position: job.telegram_message_id,
        original_created_at: messageDate,
        metadata,
        processing_status: mediaType === "video" || mediaType === "gif" ? "queued" : "ready",
        integrity_status: "verified",
        width: typeof payload.width === "number" ? payload.width : null,
        height: typeof payload.height === "number" ? payload.height : null,
        duration_ms: typeof payload.duration === "number" ? Math.round(payload.duration * 1000) : null,
      });
      if (mediaError) throw new Error(`Media metadata insert failed: ${mediaError.message}`);
    }

    const { error: fileError } = await supabase.from("media_files").upsert({
      media_id: mediaId,
      file_role: "original",
      storage_bucket: "arc-originals",
      storage_key: objectKey,
      version_number: 1,
      sha256: downloaded.sha256,
      size_bytes: downloaded.size,
      mime_type: mimeType,
      is_current: true,
    }, { onConflict: "media_id,file_role,version_number" });
    if (fileError) throw new Error(`Original file metadata insert failed: ${fileError.message}`);

    const processingJobs = [];
    if (mediaType === "video" || mediaType === "gif") {
      processingJobs.push({
        media_id: mediaId,
        job_type: "cover",
        idempotency_key: `cover:${mediaId}:v1`,
        priority: 50,
        payload: { source: "telegram_ingest" },
      });
    }
    processingJobs.push({
      media_id: mediaId,
      job_type: "backup",
      idempotency_key: `backup:${mediaId}:original:v1`,
      priority: 40,
      payload: { file_role: "original", storage_bucket: "arc-originals", storage_key: objectKey },
    });
    const { error: jobsError } = await supabase.from("processing_jobs").upsert(processingJobs, {
      onConflict: "idempotency_key",
      ignoreDuplicates: true,
    });
    if (jobsError) throw new Error(`Could not enqueue follow-up jobs: ${jobsError.message}`);

    await markTelegramSuccess(job);
    await deleteSourceMessage(job.telegram_chat_id, job.telegram_message_id, mediaId);

    if (filenameConflict && job.telegram_chat_id) {
      try {
        await telegramCall("sendMessage", {
          chat_id: job.telegram_chat_id,
          text: `Файл «${originalFilename}» уже встречался. Новая копия сохранена отдельно; существующий файл не заменялся.`,
        });
      } catch {
        // A notification failure must not invalidate a verified archive upload.
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-3000) || `${command} exited with ${code}`)));
  });
}

async function downloadStorageFile(bucket: string, key: string, destination: string) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, 3600);
  if (error || !data?.signedUrl) throw new Error("Could not sign original media URL.");
  const response = await fetch(data.signedUrl, { cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`Original download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}

function parseFps(value: string | undefined) {
  if (!value) return 25;
  const [numerator, denominator] = value.split("/").map(Number);
  const parsed = denominator ? numerator / denominator : numerator;
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(20, Math.min(30, Math.round(parsed))) : 25;
}

async function retryProcessingJob(job: ProcessingJob, error: unknown) {
  const exhausted = job.attempts >= job.max_attempts;
  const waitSeconds = Math.min(900, 15 * (2 ** Math.max(0, job.attempts - 1)));
  const message = error instanceof Error ? error.message : "Unknown processing error";
  await supabase.from("processing_jobs").update({
    status: exhausted ? "failed" : "queued",
    available_at: new Date(Date.now() + waitSeconds * 1000).toISOString(),
    locked_at: null, locked_by: null, heartbeat_at: null,
    finished_at: exhausted ? new Date().toISOString() : null,
    error: { message, retryable: !exhausted },
  }).eq("id", job.id);
  if (exhausted && job.media_id) {
    await supabase.from("media").update({ processing_status: "partial" }).eq("id", job.media_id);
  }
}

async function processCover(job: ProcessingJob) {
  if (!job.media_id) throw new Error("Cover job has no media_id.");
  const { data: original, error } = await supabase.from("media_files").select("storage_bucket,storage_key,mime_type")
    .eq("media_id", job.media_id).eq("file_role", "original").eq("is_current", true).maybeSingle();
  if (error || !original) throw new Error("Verified original file is missing.");

  const tempDir = await mkdtemp(join(tmpdir(), "arc-cover-"));
  const inputPath = join(tempDir, `source${extname(original.storage_key) || ".bin"}`);
  const outputPath = join(tempDir, "cover.gif");

  try {
    await downloadStorageFile(original.storage_bucket, original.storage_key, inputPath);
    const probe = await runCommand("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,width,height",
      "-of", "json", inputPath,
    ]);
    const probeData = JSON.parse(probe) as { streams?: Array<{ avg_frame_rate?: string; width?: number; height?: number }> };
    const stream = probeData.streams?.[0];
    const fps = parseFps(stream?.avg_frame_rate);
    const mediaResult = await supabase.from("media").select("media_type").eq("id", job.media_id).single();
    if (mediaResult.error) throw mediaResult.error;
    const isVideo = mediaResult.data.media_type === "video";
    const commonFilter = `fps=${fps},scale='min(720,iw)':-2:flags=lanczos`;
    const graph = `[0:v]${commonFilter},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`;
    const inputArgs = isVideo ? ["-t", "3", "-i", inputPath] : ["-i", inputPath];
    await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputArgs, "-filter_complex", graph, "-loop", "0", outputPath]);

    const outputStat = await stat(outputPath);
    if (!outputStat.size) throw new Error("Generated GIF preview is empty.");
    const verify = await runCommand("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", outputPath]);
    const verified = JSON.parse(verify) as { streams?: Array<{ codec_name?: string; width?: number; height?: number }> };
    const outputStream = verified.streams?.[0];
    if (outputStream?.codec_name !== "gif") throw new Error("Generated preview is not a valid GIF.");

    const { data: latestCover, error: versionError } = await supabase.from("media_files").select("version_number")
      .eq("media_id", job.media_id).eq("file_role", "cover").order("version_number", { ascending: false }).limit(1).maybeSingle();
    if (versionError) throw versionError;
    const version = (latestCover?.version_number ?? 0) + 1;
    const objectKey = `${job.media_id}/cover-v${version}.gif`;
    await uploadTus(outputPath, "arc-covers", objectKey, "image/gif");
    await verifyStorageObject("arc-covers", objectKey);

    await supabase.from("media_files").update({ is_current: false })
      .eq("media_id", job.media_id).eq("file_role", "cover").eq("is_current", true);

    const { error: insertError } = await supabase.from("media_files").insert({
      media_id: job.media_id,
      file_role: "cover",
      storage_bucket: "arc-covers",
      storage_key: objectKey,
      version_number: version,
      sha256: createHash("sha256").update(await readFile(outputPath)).digest("hex"),
      size_bytes: outputStat.size,
      mime_type: "image/gif",
      is_current: true,
    });
    if (insertError) throw insertError;

    const { error: mediaUpdateError } = await supabase.from("media").update({
      processing_status: "ready",
      fps,
    }).eq("id", job.media_id);
    if (mediaUpdateError) throw mediaUpdateError;

    const { error: jobUpdateError } = await supabase.from("processing_jobs").update({
      status: "succeeded", finished_at: new Date().toISOString(),
      locked_at: null, locked_by: null, heartbeat_at: null, error: null,
    }).eq("id", job.id);
    if (jobUpdateError) throw jobUpdateError;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function processArchiveDelivery(job: TelegramJob) {
  const chatId = job.telegram_chat_id;
  const mode = job.payload.delivery_mode;
  if (!chatId || (mode !== "native" && mode !== "document")) throw new Error("Archive delivery has no valid destination or format.");

  const { count: total, error: countError } = await supabase.from("media").select("id", { count: "exact", head: true })
    .eq("is_trashed", false).is("purged_at", null);
  if (countError) throw countError;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let offset = 0;
  const pageSize = 100;
  let cancelled = false;

  await telegramCall("sendMessage", { chat_id: chatId, text: "ARC: начинаю отправку архива. Подтверждённые ранее файлы будут пропущены." });

  while (true) {
    const { data: mediaPage, error: mediaError } = await supabase.from("media")
      .select("id,filename,media_type,mime_type")
      .eq("is_trashed", false).is("purged_at", null)
      .order("uploaded_at", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (mediaError) throw mediaError;
    const batch = mediaPage ?? [];
    if (!batch.length) break;

    const ids = batch.map((item) => item.id);
    const { data: deliveries, error: deliveryReadError } = await supabase.from("telegram_deliveries")
      .select("media_id,status").eq("telegram_chat_id", chatId).in("media_id", ids);
    if (deliveryReadError) throw deliveryReadError;
    const alreadySent = new Set((deliveries ?? []).filter((item) => item.status === "sent").map((item) => item.media_id));

    for (const item of batch) {
      const { data: currentJob, error: currentJobError } = await supabase.from("telegram_jobs").select("status").eq("id", job.id).maybeSingle();
      if (currentJobError) throw currentJobError;
      if (currentJob?.status === "cancelled") { cancelled = true; break; }

      if (alreadySent.has(item.id)) { skipped += 1; continue; }

      try {
        const { data: original, error: originalError } = await supabase.from("media_files")
          .select("storage_bucket,storage_key").eq("media_id", item.id)
          .eq("file_role", "original").eq("is_current", true).maybeSingle();
        if (originalError || !original) throw new Error("Verified original file is missing.");

        const { data: signed, error: signedError } = await supabase.storage
          .from(original.storage_bucket).createSignedUrl(original.storage_key, 3600);
        if (signedError || !signed?.signedUrl) throw new Error("Could not create a temporary original URL.");

        const method = mode === "document" ? "sendDocument"
          : item.media_type === "photo" ? "sendPhoto"
          : item.media_type === "video" ? "sendVideo"
          : item.media_type === "gif" ? "sendAnimation"
          : "sendDocument";
        const field = method === "sendPhoto" ? "photo"
          : method === "sendVideo" ? "video"
          : method === "sendAnimation" ? "animation" : "document";
        const telegramResult = await telegramCall(method, {
          chat_id: chatId, [field]: signed.signedUrl, caption: item.filename,
        });

        const { error: saveDeliveryError } = await supabase.from("telegram_deliveries").upsert({
          media_id: item.id,
          telegram_chat_id: chatId,
          telegram_message_id: telegramResult.message_id ?? null,
          delivery_mode: mode,
          status: "sent",
          sent_at: new Date().toISOString(),
          error: null,
        }, { onConflict: "media_id,telegram_chat_id" });
        if (saveDeliveryError) throw new Error("Telegram sent the file, but ARC could not record delivery confirmation: " + saveDeliveryError.message);
        sent += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : "Unknown Telegram delivery error";
        await supabase.from("telegram_deliveries").upsert({
          media_id: item.id,
          telegram_chat_id: chatId,
          delivery_mode: mode,
          status: "failed",
          error: { message },
        }, { onConflict: "media_id,telegram_chat_id" });
        await supabase.from("activity_logs").insert({
          action: "telegram.archive_delivery_failed",
          entity_type: "media",
          entity_id: item.id,
          details: { job_id: job.id, message },
        });
      }

      if ((sent + failed + skipped) % 10 === 0) {
        await telegramCall("sendMessage", {
          chat_id: chatId,
          text: "ARC: обработано " + (sent + failed + skipped) + " из " + (total ?? "?") +
            ". Отправлено: " + sent + ", пропущено: " + skipped + ", ошибок: " + failed + ".",
        }).catch(() => undefined);
      }
    }

    if (cancelled || batch.length < pageSize) break;
    offset += batch.length;
  }

  if (cancelled) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: "Отправка остановлена. Уже отправленные файлы сохранены; повторный запуск пропустит подтверждённые отправки.",
    }).catch(() => undefined);
    await supabase.from("telegram_jobs").update({
      status: "cancelled", finished_at: new Date().toISOString(),
      locked_at: null, locked_by: null, heartbeat_at: null,
    }).eq("id", job.id);
    return;
  }

  await telegramCall("sendMessage", {
    chat_id: chatId,
    text: "ARC: отправка архива завершена.\nВсего в архиве: " + (total ?? 0) +
      "\nОтправлено сейчас: " + sent + "\nУже было отправлено: " + skipped + "\nОшибок: " + failed,
  });
  const { error: finishError } = await supabase.from("telegram_jobs").update({
    status: failed ? "failed" : "succeeded",
    finished_at: new Date().toISOString(),
    locked_at: null, locked_by: null, heartbeat_at: null,
    error: failed ? { message: "Some media items could not be delivered.", failed_count: failed } : null,
  }).eq("id", job.id);
  if (finishError) throw finishError;
}

async function processTelegramJob(job: TelegramJob) {
  const heartbeat = setInterval(() => {
    void supabase.from("telegram_jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", job.id).eq("status", "running");
  }, 30_000);
  try {
    if (job.job_type === "send_archive") {
      await processArchiveDelivery(job);
      return;
    }
    if (job.job_type !== "ingest") throw new Error("Unsupported Telegram job type: " + job.job_type);
    await processIngest(job);
  } catch (error) {
    await retryTelegramJob(job, error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function processProcessingJob(job: ProcessingJob) {
  const heartbeat = setInterval(() => {
    void supabase.from("processing_jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", job.id).eq("status", "running");
  }, 30_000);
  try {
    if (job.job_type === "cover" || job.job_type === "cover_regenerate") {
      await processCover(job);
      return;
    }
    // Backups remain queued until an independent backup destination is configured.
    await supabase.from("processing_jobs").update({
      status: "queued", attempts: Math.max(0, job.attempts - 1),
      locked_at: null, locked_by: null, heartbeat_at: null,
      available_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    }).eq("id", job.id);
  } catch (error) {
    await retryProcessingJob(job, error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  console.log("ARC worker started", { workerId });
  let lastRecovery = 0;

  while (true) {
    try {
      if (Date.now() - lastRecovery > 60_000) {
        await supabase.rpc("recover_stale_jobs", { p_stale_after_seconds: 600 });
        lastRecovery = Date.now();
      }

      const telegramResult = await supabase.rpc("claim_telegram_jobs", { p_worker_id: workerId, p_batch_size: 1 });
      if (telegramResult.error) throw telegramResult.error;
      const telegramJob = (telegramResult.data ?? [])[0] as TelegramJob | undefined;
      if (telegramJob) await processTelegramJob(telegramJob);

      const coverResult = await supabase.rpc("claim_cover_jobs", { p_worker_id: workerId, p_batch_size: 1 });
      if (coverResult.error) throw coverResult.error;
      const coverJob = (coverResult.data ?? [])[0] as ProcessingJob | undefined;
      if (coverJob) await processProcessingJob(coverJob);
      if (!telegramJob && !coverJob) await delay(2500);
    } catch (error) {
      console.error("ARC worker loop error:", error instanceof Error ? error.message : error);
      await delay(5000);
    }
  }
}

void main().catch((error: unknown) => {
  console.error("ARC worker stopped:", error);
  process.exitCode = 1;
});
