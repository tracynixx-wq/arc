import "server-only";

import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

const SESSION_COOKIE = "arc_session";

export async function getOwnerSession() {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (!rawToken || rawToken.length > 200) return null;

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("sessions")
    .select("id,telegram_user_id")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !data || !process.env.TELEGRAM_OWNER_ID || String(data.telegram_user_id) !== process.env.TELEGRAM_OWNER_ID) return null;

  await supabase.from("sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  return { sessionId: data.id, telegramUserId: data.telegram_user_id };
}
