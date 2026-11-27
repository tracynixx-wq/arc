import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase.from("media")
      .update({ is_trashed: false, trashed_at: null })
      .eq("id", id).eq("is_trashed", true).is("purged_at", null).select("id").maybeSingle();

    if (error) return NextResponse.json({ error: "Could not restore media." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Media not found in trash." }, { status: 404 });

    await supabase.from("activity_logs").insert({ action: "media.restored", entity_type: "media", entity_id: id });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Media service is unavailable." }, { status: 503 });
  }
}
