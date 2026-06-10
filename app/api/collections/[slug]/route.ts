import { NextRequest, NextResponse } from "next/server";
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

  const collection = (await db
    .prepare("SELECT id, slug FROM collections WHERE id = ?")
    .get(id)) as { id: string; slug: string } | undefined;

  if (!collection) {
    return NextResponse.json({ error: "合集不存在" }, { status: 404 });
  }

  const formData = await request.formData();
  const title = formData.get("title") as string;
  const description = formData.get("description") as string;
  const icon = formData.get("icon") as File | null;

  if (!title || !title.trim()) {
    return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
  }

  let icon_url = "";
  if (icon && icon.size > 0) {
    const store = await getBackendStore();
    const proto = request.headers.get("x-forwarded-proto") || "https";
    const host = request.headers.get("host") || request.nextUrl.host;
    const siteUrl = `${proto}://${host}`;
    
    const ext = icon.name.includes(".png") ? "png"
      : icon.name.includes(".gif") ? "gif"
      : icon.name.includes(".webp") ? "webp"
      : icon.name.includes(".svg") ? "svg"
      : "jpg";
    const iconFilename = `_icon.${ext}`;
    
    const buf = Buffer.from(await icon.arrayBuffer());
    await store.save(collection.id, iconFilename, buf);
    const cdnUrl = store.getUrl?.(collection.id, iconFilename);
    icon_url = cdnUrl || `${siteUrl}/api/collections/${collection.slug}/icon`;
  }

  try {
    if (icon_url) {
      await db
        .prepare(
          "UPDATE collections SET title = ?, description = ?, icon_url = ?, updated_at = strftime('%s', 'now') WHERE id = ?"
        )
        .run(title.trim(), description.trim(), icon_url, id);
    } else {
      await db
        .prepare(
          "UPDATE collections SET title = ?, description = ?, updated_at = strftime('%s', 'now') WHERE id = ?"
        )
        .run(title.trim(), description.trim(), id);
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("更新合集失败:", e);
    return NextResponse.json({ error: "更新失败" }, { status: 500 });
  }
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
