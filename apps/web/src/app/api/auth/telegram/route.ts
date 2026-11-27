import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyTelegramInitData } from "@/lib/telegram/verify-init-data";

export const runtime = "nodejs";

const SESSION_COOKIE = "arc_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 365 * 10;

export async function POST(request: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const ownerId = process.env.TELEGRAM_OWNER_ID;

  if (!botToken || !ownerId) {
    return NextResponse.json({ error: "Telegram authentication is not configured." }, { status: 503 });
  }

  let body: { initData?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.initData !== "string") {
    return NextResponse.json({ error: "Telegram init data is required." }, { status: 400 });
  }

  const verified = verifyTelegramInitData(body.initData, botToken);
  if (!verified || String(verified.user.id) !== ownerId) {
    return NextResponse.json({ error: "Telegram identity could not be verified." }, { status: 401 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const { error } = await supabase.from("sessions").insert({
      token_hash: tokenHash,
      telegram_user_id: verified.user.id,
      user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
    });

    if (error) {
      return NextResponse.json({ error: "Could not create a secure session." }, { status: 500 });
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
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }
}
