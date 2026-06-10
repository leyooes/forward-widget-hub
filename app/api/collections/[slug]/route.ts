import { NextRequest, NextResponse } from "next/server";
import { getBackendDb, getBackendStore } from "@/lib/backend";
import { verifyAdmin } from "../../../../lib/admin-auth";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await verifyAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const db = await getBackendDb();

  const collection = (await db
    .prepare("SELECT id FROM collections WHERE id = ?")
    .get(id)) as { id: string } | undefined;

  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.prepare("DELETE FROM modules WHERE collection_id = ?").run(id);
  await db.prepare("DELETE FROM collections WHERE id = ?").run(id);
  const store = await getBackendStore();
  await store.removeCollection(id);

  return NextResponse.json({ success: true });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await verifyAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const db = await getBackendDb();
  const store = await getBackendStore();

  const collection = (await db
    .prepare("SELECT id, slug, icon_url FROM collections WHERE id = ?")
    .get(id)) as { id: string; slug: string; icon_url: string } | undefined;

  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const title = formData.get("title") as string | null;
  const description = formData.get("description") as string | null;
  const iconFile = formData.get("icon") as File | null;

  if (!title || !title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  let iconUrl = collection.icon_url;

  // Handle icon upload
  if (iconFile && iconFile.size > 0) {
    const buffer = Buffer.from(await iconFile.arrayBuffer());
    const ext = iconFile.type.includes("png") ? "png"
      : iconFile.type.includes("gif") ? "gif"
      : iconFile.type.includes("webp") ? "webp"
      : iconFile.type.includes("svg") ? "svg"
      : "jpg";
    const iconFilename = `_icon.${ext}`;
    const savedKey = await store.save(id, iconFilename, buffer);
    const actualKey = savedKey || iconFilename;
    const cdnUrl = store.getUrl?.(id, actualKey);
    iconUrl = cdnUrl || `${request.headers.get("x-forwarded-proto") || "https"}://${request.headers.get("host") || request.nextUrl.host}/api/collections/${collection.slug}/icon`;
  }

  await db.prepare(
    "UPDATE collections SET title = ?, description = ?, icon_url = ?, updated_at = unixepoch() WHERE id = ?"
  ).run(title.trim(), description?.trim() || "", iconUrl, id);

  return NextResponse.json({ success: true });
}
