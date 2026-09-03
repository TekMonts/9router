import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";

// POST /api/keys/[id]/reveal — on-demand reveal of the full virtual key for
// the dashboard Copy action. Session-gated like every /api/* route. The list
// endpoints stay masked (see keys-masking.test.js); this is the only read path
// that returns the raw sk-… value, and it returns nothing else secret
// (machineId stays server-side). POST so the key never lands in a GET URL.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key: key.key });
  } catch (error) {
    console.log("Error revealing key:", error);
    return NextResponse.json({ error: "Failed to reveal key" }, { status: 500 });
  }
}
