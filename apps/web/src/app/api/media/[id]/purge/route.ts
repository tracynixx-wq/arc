import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });

    let body: { confirm?: unknown };
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: "Explicit confirmation is required." }, { status: 400 }); }
    if (body.confirm !== true) return NextResponse.json({ error: "Explicit confirmation is required." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const { data: media, error: mediaError } = await supabase.from("media")
      .select("id,is_trashed,purged_at").eq("id", id).maybeSingle();

    if (mediaError) return NextResponse.json({ error: "Could not verify media state." }, { status: 500 });
    if (!media) return NextResponse.json({ error: "Media not found." }, { status: 404 });
    if (!media.is_trashed) return NextResponse.json({ error: "Move the item to trash before permanent deletion." }, { status: 409 });
    if (media.purged_at) return NextResponse.json({ ok: true, alreadyPurged: true });

    const { data: files, error: filesError } = await supabase.from("media_files")
      .select("id,file_role,storage_bucket,storage_key")
      .eq("media_id", id).in("file_role", ["original", "cover", "preview"]);
    if (filesError) return NextResponse.json({ error: "Could not list media objects." }, { status: 500 });

    const byBucket = new Map<string, string[]>();
    for (const file of files ?? []) {
      const paths = byBucket.get(file.storage_bucket) ?? [];
      paths.push(file.storage_key);
      byBucket.set(file.storage_bucket, paths);
    }

    for (const [bucket, paths] of byBucket) {
      const { error } = await supabase.storage.from(bucket).remove(paths);
      if (error) return NextResponse.json({ error: "Storage cleanup incomplete. Retry permanent deletion." }, { status: 503 });
    }

    const { error: metadataError } = await supabase.from("media_files")
      .delete().eq("media_id", id).in("file_role", ["original", "cover", "preview"]);
    if (metadataError) return NextResponse.json({ error: "Files were removed but metadata cleanup failed. Retry." }, { status: 503 });

    const { error: updateError } = await supabase.from("media")
      .update({ purged_at: new Date().toISOString(), is_trashed: true })
      .eq("id", id);
    if (updateError) return NextResponse.json({ error: "Files were removed but archive state could not be finalized." }, { status: 503 });

    await supabase.from("activity_logs").insert({
      action: "media.permanently_purged",
      entity_type: "media",
      entity_id: id,
      details: { backup_objects_retained: true },
    });

    return NextResponse.json({ ok: true, backupsRetained: true });
  } catch {
    return NextResponse.json({ error: "Permanent deletion service is unavailable." }, { status: 503 });
  }
}
