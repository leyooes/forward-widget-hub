import { NextRequest, NextResponse } from "next/server";
import { getBackendDb, getBackendStore } from "@/lib/backend";
import { verifyAdmin } from "@/lib/admin-auth";

type Params = Promise<{ id: string }>;

export async function PUT(
  request: NextRequest,
  { params }: { params: Params }
) {
  const denied = await verifyAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const db = await getBackendDb();

  const collection = (await db
    .prepare("SELECT id, slug FROM collections WHERE id = ?")
    .get(id)) as { id: string; slug: string } | undefined;

  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const title = formData.get("title") as string | null;
  const description = formData.get("description") as string | null;
  const icon = formData.get("icon") as File | null;

  if (!title || !title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  if (icon) {
    const store = await getBackendStore();
    const iconBuffer = Buffer.from(await icon.arrayBuffer());
    const ext = icon.name.split(".").pop() || "png";
    const iconKey = `_icon.${ext}`;
    await store.save(id, iconKey, iconBuffer);
  }

  await db.prepare(
    "UPDATE collections SET title = ?, description = ?, updated_at = unixepoch() WHERE id = ?"
  ).run(title.trim(), description || "", id);

  return NextResponse.json({ success: true });
}
