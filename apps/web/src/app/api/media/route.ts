import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PAGE_SIZE = 10;
const VIEWS = ["all", "recent", "favorites", "videos", "gifs", "photos", "trash"] as const;

export async function GET(request: Request) {
  let ownerSession;
  try {
    ownerSession = await getOwnerSession();
  } catch {
    return NextResponse.json({ error: "Authentication service is unavailable." }, { status: 503 });
  }
  if (!ownerSession) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const url = new URL(request.url);
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1_000_000) : 1;
  const rawSearch = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const search = rawSearch.replace(/[^\p{L}\p{N}\s.-]/gu, " ").replace(/\s+/g, " ").trim();
  const rawView = url.searchParams.get("view") ?? "all";
  const view = VIEWS.includes(rawView as (typeof VIEWS)[number]) ? rawView : "all";
  const collectionId = url.searchParams.get("collection");
  const tagId = url.searchParams.get("tag");
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if ((collectionId && !UUID.test(collectionId)) || (tagId && !UUID.test(tagId))) return NextResponse.json({ error: "Invalid filter." }, { status: 400 });

  try {
    const supabase = createSupabaseAdmin();
    let favoriteIds: string[] = [];
    let scopedIds: Set<string> | null = null;

    if (collectionId) {
      const { data: memberships, error: membershipError } = await supabase.from("media_collections").select("media_id").eq("collection_id", collectionId);
      if (membershipError) return NextResponse.json({ error: "Could not load collection media." }, { status: 500 });
      scopedIds = new Set((memberships ?? []).map((item) => item.media_id));
    }
    if (tagId) {
      const { data: tagged, error: tagError } = await supabase.from("media_tags").select("media_id").eq("tag_id", tagId);
      if (tagError) return NextResponse.json({ error: "Could not load tagged media." }, { status: 500 });
      const tagIds = new Set((tagged ?? []).map((item) => item.media_id));
      scopedIds = scopedIds ? new Set([...scopedIds].filter((id) => tagIds.has(id))) : tagIds;
    }
    if (scopedIds && scopedIds.size === 0) {
      return NextResponse.json({ items: [], page, pageSize: PAGE_SIZE, hasMore: false, total: 0 });
    }

    if (view === "favorites") {
      const { data: favorites, error: favoriteError } = await supabase.from("favorites").select("media_id");
      if (favoriteError) return NextResponse.json({ error: "Could not load favorites." }, { status: 500 });
      favoriteIds = (favorites ?? []).map((favorite) => favorite.media_id);
      if (!favoriteIds.length) {
        return NextResponse.json({ items: [], page, pageSize: PAGE_SIZE, hasMore: false, total: 0 });
      }
    }

    let query = supabase
      .from("media")
      .select("id,filename,display_name,description,media_type,mime_type,size_bytes,uploaded_at,original_created_at,duration_ms,width,height,processing_status,is_trashed", { count: "exact" })
      .eq("is_trashed", view === "trash")
      .is("purged_at", null)
      .order("uploaded_at", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    if (view === "recent") query = query.gte("uploaded_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    if (view === "videos") query = query.eq("media_type", "video");
    if (view === "gifs") query = query.eq("media_type", "gif");
    if (view === "photos") query = query.eq("media_type", "photo");
    if (view === "favorites") query = query.in("id", favoriteIds);
    if (scopedIds) query = query.in("id", [...scopedIds]);
    if (search) query = query.or(`filename.ilike.%${search}%,display_name.ilike.%${search}%,description.ilike.%${search}%`);

    const { data, error, count } = await query;
    if (error) return NextResponse.json({ error: "Could not load archive media." }, { status: 500 });

    const media = data ?? [];
    const ids = media.map((item) => item.id);
    const coverUrls = new Map<string, string>();
    const currentFavorites = new Set(favoriteIds);

    if (ids.length) {
      const { data: files } = await supabase.from("media_files").select("media_id,file_role,storage_bucket,storage_key")
        .in("media_id", ids).in("file_role", ["cover", "original"]).eq("is_current", true);
      const { data: favorites } = view === "favorites"
        ? { data: ids.map((media_id) => ({ media_id })) }
        : await supabase.from("favorites").select("media_id").in("media_id", ids);

      for (const favorite of favorites ?? []) currentFavorites.add(favorite.media_id);

      for (const file of files ?? []) {
        const mediaItem = media.find((item) => item.id === file.media_id);
        const isPreview = file.file_role === "cover" || mediaItem?.media_type === "photo";
        if (!isPreview || coverUrls.has(file.media_id)) continue;
        const { data: signed } = await supabase.storage.from(file.storage_bucket).createSignedUrl(file.storage_key, 300);
        if (signed?.signedUrl) coverUrls.set(file.media_id, signed.signedUrl);
      }
    }

    const response = NextResponse.json({
      items: media.map((item) => ({
        ...item,
        coverUrl: coverUrls.get(item.id) ?? null,
        isFavorite: currentFavorites.has(item.id),
      })),
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
