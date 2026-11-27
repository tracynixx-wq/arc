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
    const { data: media } = await supabase.from("media").select("id").eq("id", id).eq("is_trashed", false).maybeSingle();
    if (!media) return NextResponse.json({ error: "Media not found." }, { status: 404 });

    const { error } = await supabase.from("favorites").upsert({ media_id: id }, { onConflict: "media_id" });
    if (error) return NextResponse.json({ error: "Could not add favorite." }, { status: 500 });
    await supabase.from("activity_logs").insert({ action: "media.favorited", entity_type: "media", entity_id: id });
    return NextResponse.json({ ok: true, favorite: true });
  } catch {
    return NextResponse.json({ error: "Favorite service is unavailable." }, { status: 503 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const { error } = await supabase.from("favorites").delete().eq("media_id", id);
    if (error) return NextResponse.json({ error: "Could not remove favorite." }, { status: 500 });
    await supabase.from("activity_logs").insert({ action: "media.unfavorited", entity_type: "media", entity_id: id });
    return NextResponse.json({ ok: true, favorite: false });
  } catch {
    return NextResponse.json({ error: "Favorite service is unavailable." }, { status: 503 });
  }
}
