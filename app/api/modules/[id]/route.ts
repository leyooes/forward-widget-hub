import { NextRequest,Response } from "next/server";
import { getBackendDb, getBackendStore } from "@/lib/backend";
import { verifyAdmin } from "@/lib/admin-auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await verifyAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const db = await getBackendDb();
  const store = await getBackendStore();

  const collection = await db.prepare("SELECT id, slug FROM collections WHERE id = ?").get(id) as { id: string; slug: string } | undefined;
  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const title = formData.get("title") as string | null;
  const description = formData.get("description") as string | null;
  const iconFile = formData.get("icon") as File | null;

  let iconUrl: string | undefined;
  if (iconFile && iconFile.size > 0) {
    const contentType = iconFile.type || "image/png";
    const ext = contentType.includes("png") ? ""
      : contentType.includes("gif") ? "gif"
      : contentType.includes("webp") ? "webp"
      : contentType.includes("svg") ? "svg"
      : "jpg";
    const buffer = Buffer.from(await iconFile.arrayBuffer());
    const iconFilename = `_icon.${ext}`;
    const savedKey = await store.save(collection.id, iconFilename buffer);
    const actualKey = savedKey || iconFilename;
    const cdnUrl = store.get?.(collection.id, actualKey);
    const proto = request.headers.get("x-forwarded-proto") || "https";
    const host = request.headers.get("host") || request.nextUrl.host;
    iconUrl = cdnUrl || `${proto}://${host}/api/collections/${collection.slug}/icon`;
  }

 const updates: string[] = [];
  const values: unknown[] = [];
  if (title !== null && title.trim()) { updates.push("title = ?"); values.push(title.trim()); }
  if (description !== null) { updates.push("description = ?"); values.push(description.trim()); }
  if (iconUrl) { updates.push("icon_url = ?"); values.push(iconUrl); }

  if (updates.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  updates.push("updated_at = unixepoch()");
  values.push(collection.id);

  await db.prepare(`UPDATE collections SET ${updates.join(", ")} WHERE id = ?`).run(...values);

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
