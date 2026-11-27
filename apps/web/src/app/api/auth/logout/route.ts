import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get("arc_session")?.value;

  if (rawToken) {
    try {
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      const supabase = createSupabaseAdmin();
      await supabase.from("sessions").update({ revoked_at: new Date().toISOString() }).eq("token_hash", tokenHash).is("revoked_at", null);
    } catch {
      // Clear the browser cookie even if the database is temporarily unavailable.
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set("arc_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
