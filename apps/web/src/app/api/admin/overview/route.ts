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
    const { data, error } = await supabase.rpc("arc_admin_overview");
    if (error) return NextResponse.json({ error: "Could not load system metrics." }, { status: 500 });

    const memory = process.memoryUsage();
    const response = NextResponse.json({
      archive: data,
      runtime: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        uptimeSeconds: Math.round(process.uptime()),
        sampledAt: new Date().toISOString(),
      },
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "Admin monitoring is unavailable." }, { status: 503 });
  }
}
