import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: RouteContext) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });
    const fileUrl = new URL(request.url);
    const role = fileUrl.searchParams.get("role") ?? "original";
    const download = fileUrl.searchParams.get("download") === "1";
    if (!["original", "cover"].includes(role)) return NextResponse.json({ error: "Invalid file role." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const { data: file, error } = await supabase.from("media_files")
      .select("storage_bucket,storage_key,mime_type")
      .eq("media_id", id).eq("file_role", role).eq("is_current", true).maybeSingle();

    if (error) return NextResponse.json({ error: "Could not locate media file." }, { status: 500 });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });

    const { data: signed, error: signedError } = await supabase.storage
      .from(file.storage_bucket).createSignedUrl(file.storage_key, 300, { download });
    if (signedError || !signed?.signedUrl) return NextResponse.json({ error: "Could not create secure file URL." }, { status: 500 });

    return NextResponse.json({ url: signed.signedUrl, mimeType: file.mime_type }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "File service is unavailable." }, { status: 503 });
  }
}
