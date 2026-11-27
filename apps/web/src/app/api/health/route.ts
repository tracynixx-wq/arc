import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ status: "degraded", database: "not_configured" }, { status: 503 });
    }
    const supabase = createSupabaseAdmin();
    const { error } = await supabase.from("processing_jobs").select("id").limit(1);
    if (error) {
      return NextResponse.json({ status: "degraded", database: "unavailable" }, { status: 503 });
    }
    return NextResponse.json(
      { status: "ok", service: "arc-web", database: "ok", version: "1.0.0" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ status: "degraded", database: "unavailable" }, { status: 503 });
  }
}
