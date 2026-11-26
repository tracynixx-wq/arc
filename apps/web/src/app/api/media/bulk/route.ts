import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const body = await request.json() as { action?: unknown; ids?: unknown };
    const actions = ["trash", "restore", "favorite", "unfavorite"] as const;
    if (typeof body.action !== "string" || !actions.includes(body.action as (typeof actions)[number])) {
      return NextResponse.json({ error: "Invalid bulk action." }, { status: 400 });
    }
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100 ||
        body.ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
        new Set(body.ids).size !== body.ids.length) {
      return NextResponse.json({ error: "Select between 1 and 100 unique media items." }, { status: 400 });
    }

    const ids = body.ids as string[];
    const supabase = createSupabaseAdmin();
    const { data: media, error: mediaError } = await supabase.from("media").select("id,is_trashed")
      .in("id", ids).is("purged_at", null);
    if (mediaError) return NextResponse.json({ error: "Could not verify selected media." }, { status: 500 });
    if ((media ?? []).length !== ids.length) return NextResponse.json({ error: "Some selected media no longer exists." }, { status: 404 });

    const now = new Date().toISOString();
    if (body.action === "trash") {
      const activeIds = media.filter((item) => !item.is_trashed).map((item) => item.id);
      if (activeIds.length) {
        const { error } = await supabase.from("media").update({ is_trashed: true, trashed_at: now }).in("id", activeIds);
        if (error) return NextResponse.json({ error: "Could not move selected media to trash." }, { status: 500 });
      }
    } else if (body.action === "restore") {
      const trashedIds = media.filter((item) => item.is_trashed).map((item) => item.id);
      if (trashedIds.length) {
        const { error } = await supabase.from("media").update({ is_trashed: false, trashed_at: null }).in("id", trashedIds);
        if (error) return NextResponse.json({ error: "Could not restore selected media." }, { status: 500 });
      }
    } else if (body.action === "favorite") {
      const activeIds = media.filter((item) => !item.is_trashed).map((item) => item.id);
      if (activeIds.length) {
        const { error } = await supabase.from("favorites").upsert(activeIds.map((media_id) => ({ media_id })), { onConflict: "media_id" });
        if (error) return NextResponse.json({ error: "Could not favorite selected media." }, { status: 500 });
      }
    } else {
      const { error } = await supabase.from("favorites").delete().in("media_id", ids);
      if (error) return NextResponse.json({ error: "Could not remove selected favorites." }, { status: 500 });
    }

    await supabase.from("activity_logs").insert({
      action: "media.bulk_" + body.action,
      entity_type: "media",
      details: { media_ids: ids, count: ids.length },
    });
    return NextResponse.json({ ok: true, affected: ids.length });
  } catch {
    return NextResponse.json({ error: "Bulk media service is unavailable." }, { status: 503 });
  }
}
