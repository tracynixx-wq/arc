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
    const { data, error } = await supabase.from("tags").select("id,name,color").order("name", { ascending: true });
    if (error) return NextResponse.json({ error: "Could not load tags." }, { status: 500 });
    return NextResponse.json({ items: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Tag service is unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const body = await request.json() as { name?: unknown; color?: unknown };
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 40) {
      return NextResponse.json({ error: "Tag name must contain 1–40 characters." }, { status: 400 });
    }
    if (body.color !== undefined && body.color !== null &&
        (typeof body.color !== "string" || !/^#[0-9a-f]{6}$/i.test(body.color))) {
      return NextResponse.json({ error: "Invalid tag color." }, { status: 400 });
    }
    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase.from("tags")
      .insert({ name: body.name.trim(), color: typeof body.color === "string" ? body.color : null })
      .select("id,name,color").single();
    if (error?.code === "23505") return NextResponse.json({ error: "A tag with this name already exists." }, { status: 409 });
    if (error || !data) return NextResponse.json({ error: "Could not create tag." }, { status: 500 });
    return NextResponse.json({ item: data }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Tag service is unavailable." }, { status: 503 });
  }
}
