import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

export async function GET(request: Request) {
  let ownerSession;
  try {
    ownerSession = await getOwnerSession();
  } catch {
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }

  if (!ownerSession) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const url = new URL(request.url);
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1_000_000) : 1;
  const rawSearch = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const search = rawSearch.replace(/[%,()_]/g, " ").replace(/\s+/g, " ").trim();

  try {
    const supabase = createSupabaseAdmin();
    let query = supabase
      .from("media")
      .select("id,filename,display_name,description,media_type,mime_type,size_bytes,uploaded_at,duration_ms,width,height,processing_status,is_trashed")
      .eq("is_trashed", false)
      .order("uploaded_at", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    if (search) query = query.ilike("filename", `%${search}%`);

    const [{ data, error, count },] = await Promise.all([
      query,
    ]);

    if (error) {
      return NextResponse.json({ error: "Could not load archive media." }, { status: 500 });
    }

    const media = data ?? [];
    const ids = media.map((item) => item.id);
    const coverUrls = new Map<string, string>();

    if (ids.length) {
      const { data: covers } = await supabase
        .from("media_files")
        .select("media_id,storage_bucket,storage_key")
        .in("media_id", ids)
        .eq("file_role", "cover")
        .eq("is_current", true);

      for (const cover of covers ?? []) {
        const { data: signed } = await supabase.storage
          .from(cover.storage_bucket)
          .createSignedUrl(cover.storage_key, 300);
        if (signed?.signedUrl) coverUrls.set(cover.media_id, signed.signedUrl);
      }
    }

    const response = NextResponse.json({
      items: media.map((item) => ({ ...item, coverUrl: coverUrls.get(item.id) ?? null })),
      page,
      pageSize: PAGE_SIZE,
      hasMore: media.length === PAGE_SIZE,
      total: count ?? null,
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "Archive service is unavailable." }, { status: 503 });
  }
}
