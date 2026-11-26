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
