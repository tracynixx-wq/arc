import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });
    const supabase = createSupabaseAdmin();
    const { data: media, error: mediaError } = await supabase.from("media").select("id").eq("id", id).is("purged_at", null).maybeSingle();
    if (mediaError) return NextResponse.json({ error: "Could not locate media." }, { status: 500 });
    if (!media) return NextResponse.json({ error: "Media not found." }, { status: 404 });
    const { data, error } = await supabase.from("media_tags").select("tag_id,tags(id,name,color)").eq("media_id", id);
    if (error) return NextResponse.json({ error: "Could not load media tags." }, { status: 500 });
    return NextResponse.json({ items: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Tag service is unavailable." }, { status: 503 });
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });
    const body = await request.json() as { tagIds?: unknown };
    if (!Array.isArray(body.tagIds) || body.tagIds.length > 100 ||
        body.tagIds.some((value) => typeof value !== "string" || !UUID.test(value)) ||
        new Set(body.tagIds).size !== body.tagIds.length) {
      return NextResponse.json({ error: "Invalid tag selection." }, { status: 400 });
    }
    const supabase = createSupabaseAdmin();
    const { data: media, error: mediaError } = await supabase.from("media").select("id").eq("id", id).is("purged_at", null).maybeSingle();
    if (mediaError) return NextResponse.json({ error: "Could not locate media." }, { status: 500 });
    if (!media) return NextResponse.json({ error: "Media not found." }, { status: 404 });
    const ids = body.tagIds as string[];
    if (ids.length) {
      const { data: found, error: findError } = await supabase.from("tags").select("id").in("id", ids);
      if (findError) return NextResponse.json({ error: "Could not validate tags." }, { status: 500 });
      if ((found ?? []).length !== ids.length) return NextResponse.json({ error: "One or more tags do not exist." }, { status: 400 });
    }
    const { data: currentRows, error: currentError } = await supabase.from("media_tags").select("tag_id").eq("media_id", id);
    if (currentError) return NextResponse.json({ error: "Could not load current tags." }, { status: 500 });
    const currentIds = (currentRows ?? []).map((row) => row.tag_id);
    const toAdd = ids.filter((value) => !currentIds.includes(value));
    const toRemove = currentIds.filter((value) => !ids.includes(value));

    if (toAdd.length) {
      const { error: insertError } = await supabase.from("media_tags").insert(toAdd.map((tag_id) => ({ media_id: id, tag_id })));
      if (insertError) return NextResponse.json({ error: "Could not save tags." }, { status: 500 });
    }
    if (toRemove.length) {
      const { error: deleteError } = await supabase.from("media_tags").delete().eq("media_id", id).in("tag_id", toRemove);
      if (deleteError) return NextResponse.json({ error: "Could not remove old tags." }, { status: 500 });
    }
    await supabase.from("activity_logs").insert({ action: "media.tags_updated", entity_type: "media", entity_id: id, details: { tag_count: ids.length } });
    return NextResponse.json({ ok: true, tagIds: ids }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Tag service is unavailable." }, { status: 503 });
  }
}
