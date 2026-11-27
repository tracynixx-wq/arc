import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase.from("collections").select("id,name,description,is_system,system_key,sort_order")
      .order("sort_order", { ascending: true }).order("name", { ascending: true });
    if (error) return NextResponse.json({ error: "Could not load collections." }, { status: 500 });
    return NextResponse.json({ items: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Collection service is unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const body = await request.json() as { name?: unknown; description?: unknown };
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) {
      return NextResponse.json({ error: "Collection name must contain 1–80 characters." }, { status: 400 });
    }
    if (body.description !== undefined && body.description !== null &&
        (typeof body.description !== "string" || body.description.length > 500)) {
      return NextResponse.json({ error: "Invalid collection description." }, { status: 400 });
    }

    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase.from("collections")
      .insert({ name: body.name.trim(), description: typeof body.description === "string" ? body.description.trim() : null })
      .select("id,name,description,is_system,system_key,sort_order").single();

    if (error?.code === "23505") return NextResponse.json({ error: "A collection with this name already exists." }, { status: 409 });
    if (error || !data) return NextResponse.json({ error: "Could not create collection." }, { status: 500 });

    await supabase.from("activity_logs").insert({ action: "collection.created", entity_type: "collection", entity_id: data.id });
    return NextResponse.json({ item: data }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Collection service is unavailable." }, { status: 503 });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const body = await request.json() as { id?: unknown; name?: unknown; description?: unknown };
    if (typeof body.id !== "string" || !UUID.test(body.id)) return NextResponse.json({ error: "Invalid collection id." }, { status: 400 });
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)) {
      return NextResponse.json({ error: "Collection name must contain 1–80 characters." }, { status: 400 });
    }
    if (body.description !== undefined && body.description !== null &&
        (typeof body.description !== "string" || body.description.length > 500)) {
      return NextResponse.json({ error: "Invalid collection description." }, { status: 400 });
    }

    const update: { name?: string; description?: string | null } = {};
    if (typeof body.name === "string") update.name = body.name.trim();
    if ("description" in body) update.description = typeof body.description === "string" ? body.description.trim() : null;
    if (!Object.keys(update).length) return NextResponse.json({ error: "No editable fields supplied." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase.from("collections").update(update).eq("id", body.id).eq("is_system", false)
      .select("id,name,description,is_system,system_key,sort_order").maybeSingle();
    if (error?.code === "23505") return NextResponse.json({ error: "A collection with this name already exists." }, { status: 409 });
    if (error) return NextResponse.json({ error: "Could not update collection." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Custom collection not found." }, { status: 404 });
    await supabase.from("activity_logs").insert({ action: "collection.updated", entity_type: "collection", entity_id: data.id });
    return NextResponse.json({ item: data });
  } catch {
    return NextResponse.json({ error: "Collection service is unavailable." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const id = new URL(request.url).searchParams.get("id");
    if (!id || !UUID.test(id)) return NextResponse.json({ error: "Invalid collection id." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase.from("collections").delete().eq("id", id).eq("is_system", false).select("id").maybeSingle();
    if (error) return NextResponse.json({ error: "Could not delete collection." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Custom collection not found." }, { status: 404 });
    await supabase.from("activity_logs").insert({ action: "collection.deleted", entity_type: "collection", entity_id: id });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Collection service is unavailable." }, { status: 503 });
  }
}
