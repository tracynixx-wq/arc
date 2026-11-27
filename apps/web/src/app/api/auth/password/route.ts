import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_COOKIE = "arc_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const attempts = new Map<string, { count: number; resetAt: number }>();

function allowedAttempt(ip: string) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return { allowed: true, retryAfter: 0 };
  }
  if (current.count >= 8) return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  current.count += 1;
  return { allowed: true, retryAfter: 0 };
}

export async function POST(request: Request) {
  const configuredPassword = process.env.ARC_OWNER_PASSWORD;
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!configuredPassword || configuredPassword.length < 24 || !ownerId || !/^\\d+$/.test(ownerId)) {
    return NextResponse.json({ error: "Авторизация владельца не настроена." }, { status: 503 });
  }

  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim().slice(0, 80);
  const limit = allowedAttempt(ip);
  if (!limit.allowed) {
    return NextResponse.json({ error: "Слишком много попыток. Повторите позже." }, {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfter), "Cache-Control": "no-store" },
    });
  }

  let body: { password?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Некорректный запрос." }, { status: 400 });
  }
  const supplied = typeof body.password === "string" ? body.password : "";
  const expectedHash = createHash("sha256").update(configuredPassword).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  if (!timingSafeEqual(expectedHash, suppliedHash)) {
    return NextResponse.json({ error: "Неверный код доступа." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const supabase = createSupabaseAdmin();
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const { error } = await supabase.from("sessions").insert({
      token_hash: tokenHash,
      telegram_user_id: Number(ownerId),
      user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
    });
    if (error) {
      console.error("ARC owner session creation failed:", error.message);
      return NextResponse.json({ error: "Не удалось создать защищённую сессию." }, { status: 503 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, rawToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "Сервис авторизации временно недоступен." }, { status: 503 });
  }
}
