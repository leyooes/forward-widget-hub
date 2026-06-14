import { NextRequest, NextResponse } from "next/server";
import { getBackendDb, getBackendStore } from "@/lib/backend";
import { verifyAdmin } from "@/lib/admin-auth";
import { parseWidgetMetadata } from "@/lib/parser";

const DOWNLOAD_TIMEOUT = 30_000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

async function downloadRemoteJs(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Forward" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_SIZE) throw new Error("Remote file exceeds 5MB limit");
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await verifyAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const db = await getBackendDb();

  const mod = await db
    .prepare("SELECT id, collection_id, filename, oss_key FROM modules WHERE id = ?")
    .get(id) as { id: string; collection_id: string; filename: string; oss_key: string | null } | undefined;

  if (!mod) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const remoteUrl = formData.get("url") as string | null;

  let buf: Buffer;
  if (file) {
    buf = Buffer.from(await file.arrayBuffer());
  } else if (remoteUrl) {
    try {
      buf = await downloadRemoteJs(remoteUrl);
    } catch (e) {
      return NextResponse.json({ error: `Failed to download: ${(e as Error).message}` }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "No file or URL provided" }, { status: 400 });
  }

  const store = await getBackendStore();
  const ossKey = await store.save(mod.collection_id, mod.filename, buf);

  const meta = parseWidgetMetadata(buf.toString("utf-8"));
  await db.prepare(
    "UPDATE modules SET file_size = ?, title = ?, version = ?, author = ?, description = ?, oss_key = ?, source_url = COALESCE(?, source_url), updated_at = unixepoch() WHERE id = ?"
  ).run(buf.length, meta?.title || mod.filename, meta?.version || null, meta?.author || null, meta?.description || null, ossKey || null, remoteUrl, id);

  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await verifyAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const db = await getBackendDb();

  const mod = await db
    .prepare("SELECT id, collection_id, filename, oss_key FROM modules WHERE id = ?")
    .get(id) as { id: string; collection_id: string; filename: string; oss_key: string | null } | undefined;

  if (!mod) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.prepare("DELETE FROM modules WHERE id = ?").run(id);
  const store = await getBackendStore();
  await store.remove(mod.collection_id, mod.oss_key || mod.filename);
  return NextResponse.json({ success: true });
}
