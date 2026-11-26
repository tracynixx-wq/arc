import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });

    const body = await request.json() as Record<string, unknown>;
    const update: { display_name?: string | null; description?: string | null; original_created_at?: string | null } = {};

    if ("display_name" in body) {
      if (body.display_name !== null && (typeof body.display_name !== "string" || body.display_name.length > 240)) {
        return NextResponse.json({ error: "Invalid display name." }, { status: 400 });
      }
      update.display_name = body.display_name as string | null;
    }
    if ("description" in body) {
      if (body.description !== null && (typeof body.description !== "string" || body.description.length > 10_000)) {
        return NextResponse.json({ error: "Invalid description." }, { status: 400 });
      }
      update.description = body.description as string | null;
    }
    if ("original_created_at" in body) {
      if (body.original_created_at !== null && (typeof body.original_created_at !== "string" || Number.isNaN(Date.parse(body.original_created_at)))) {
        return NextResponse.json({ error: "Invalid date." }, { status: 400 });
      }
      update.original_created_at = body.original_created_at as string | null;
    }

    if (!Object.keys(update).length) return NextResponse.json({ error: "No editable fields supplied." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase.from("media").update(update).eq("id", id).eq("is_trashed", false)
      .select("id,filename,display_name,description,original_created_at").maybeSingle();
    if (error) return NextResponse.json({ error: "Could not update media." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Media not found." }, { status: 404 });

    await supabase.from("activity_logs").insert({ action: "media.updated", entity_type: "media", entity_id: id, details: { fields: Object.keys(update) } });
    return NextResponse.json({ item: data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Media service is unavailable." }, { status: 503 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const now = new Date().toISOString();
    const { data, error } = await supabase.from("media").update({ is_trashed: true, trashed_at: now })
      .eq("id", id).eq("is_trashed", false).select("id").maybeSingle();

    if (error) return NextResponse.json({ error: "Could not move media to trash." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Media not found." }, { status: 404 });

    await supabase.from("activity_logs").insert({ action: "media.trashed", entity_type: "media", entity_id: id });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Media service is unavailable." }, { status: 503 });
  }
}
