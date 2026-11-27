import { NextResponse } from "next/server";
import { getOwnerSession } from "@/lib/auth/session";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const owner = await getOwnerSession();
    if (!owner) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: "Invalid export ID." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const { data: job, error } = await supabase.from("export_jobs")
      .select("id,status,storage_bucket,storage_key,expires_at,error")
      .eq("id", id).maybeSingle();
    if (error) return NextResponse.json({ error: "Could not read export status." }, { status: 503 });
    if (!job) return NextResponse.json({ error: "Export not found." }, { status: 404 });

    if (job.status === "succeeded") {
      if (!job.storage_bucket || !job.storage_key || !job.expires_at || Date.parse(job.expires_at) <= Date.now()) {
        await supabase.from("export_jobs").update({ status: "expired" }).eq("id", id).eq("status", "succeeded");
        return NextResponse.json({ status: "expired", error: "Срок хранения ZIP-архива истёк." });
      }
      const { data: signed, error: signError } = await supabase.storage
        .from(job.storage_bucket).createSignedUrl(job.storage_key, 600, { download: "ARC-export.zip" });
      if (signError || !signed?.signedUrl) {
        return NextResponse.json({ error: "Could not create a temporary download link." }, { status: 503 });
      }
      return NextResponse.json({ status: job.status, downloadUrl: signed.signedUrl }, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    return NextResponse.json({ status: job.status, error: job.error }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Export status service is unavailable." }, { status: 503 });
  }
}
