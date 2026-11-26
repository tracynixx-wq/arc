import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { status: "ok", service: "arc-web", version: "1.0.0" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
