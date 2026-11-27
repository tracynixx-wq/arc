import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const body = await request.json() as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 10_000 ||
        body.ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
        new Set(body.ids).size !== body.ids.length) {
      return NextResponse.json({ error: "Select between 1 and 10,000 unique media files." }, { status: 400 });
    }

    const ids = body.ids as string[];
    const supabase = createSupabaseAdmin();
    const { data: media, error: mediaError } = await supabase.from("media")
      .select("id").in("id", ids).eq("is_trashed", false).is("purged_at", null);
    if (mediaError) return NextResponse.json({ error: "Could not validate selected media." }, { status: 503 });
    if ((media ?? []).length !== ids.length) {
      return NextResponse.json({ error: "Some selected media is missing or in the trash." }, { status: 409 });
    }

    const { data: exportJob, error: exportError } = await supabase.from("export_jobs")
      .insert({ options: { media_ids: ids } }).select("id").single();
    if (exportError || !exportJob) {
      return NextResponse.json({ error: "Could not create ZIP export." }, { status: 503 });
    }

    const { error: queueError } = await supabase.from("processing_jobs").insert({
      job_type: "zip_export",
      idempotency_key: "zip:" + exportJob.id,
      priority: 80,
      payload: { export_id: exportJob.id },
    });
    if (queueError) {
      await supabase.from("export_jobs").update({
        status: "failed", error: { message: "Could not enqueue ZIP export." }, finished_at: new Date().toISOString(),
      }).eq("id", exportJob.id);
      return NextResponse.json({ error: "Could not queue ZIP export." }, { status: 503 });
    }

    return NextResponse.json({ exportId: exportJob.id, status: "queued" }, {
      status: 202,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "ZIP export service is unavailable." }, { status: 503 });
  }
}
