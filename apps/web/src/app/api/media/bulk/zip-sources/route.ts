import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const body = await request.json() as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100 ||
        body.ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
        new Set(body.ids).size !== body.ids.length) {
      return NextResponse.json({ error: "Provide between 1 and 100 unique media IDs." }, { status: 400 });
    }

    const supabase = createSupabaseAdmin();
    const ids = body.ids as string[];
    const { data: media, error: mediaError } = await supabase.from("media")
      .select("id,filename,size_bytes").in("id", ids).is("purged_at", null);
    if (mediaError) return NextResponse.json({ error: "Could not load selected media." }, { status: 500 });
    if ((media ?? []).length !== ids.length) return NextResponse.json({ error: "Some selected media no longer exists." }, { status: 404 });

    const { data: originals, error: filesError } = await supabase.from("media_files")
      .select("media_id,storage_bucket,storage_key").in("media_id", ids)
      .eq("file_role", "original").eq("is_current", true);
    if (filesError) return NextResponse.json({ error: "Could not locate original files." }, { status: 500 });

    const byId = new Map((originals ?? []).map((file) => [file.media_id, file]));
    const files: Array<{ id: string; filename: string; sizeBytes: number; url: string }> = [];
    for (const item of media ?? []) {
      const original = byId.get(item.id);
      if (!original) return NextResponse.json({ error: "An original file is missing from storage." }, { status: 409 });
      const { data: signed, error: signedError } = await supabase.storage
        .from(original.storage_bucket).createSignedUrl(original.storage_key, 300, { download: item.filename });
      if (signedError || !signed?.signedUrl) return NextResponse.json({ error: "Could not create secure ZIP source URLs." }, { status: 503 });
      files.push({ id: item.id, filename: item.filename, sizeBytes: Number(item.size_bytes), url: signed.signedUrl });
    }

    const ordered = ids.map((id) => files.find((file) => file.id === id)).filter((file) => file !== undefined);
    return NextResponse.json({ files: ordered, totalBytes: ordered.reduce((sum, file) => sum + file.sizeBytes, 0) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "ZIP preparation service is unavailable." }, { status: 503 });
  }
}
