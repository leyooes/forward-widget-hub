import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getBackendDb, getBackendStore } from "@/lib/backend";
import { verifyAdmin } from "@/lib/admin-auth";
import { parseWidgetMetadata, isEncrypted } from "@/lib/parser";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
 
type Params = Promise<{ id: string }>;

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const denied = await verifyAdmin(request);
  if (denied) return denied;

  const { id: collectionId } = await params;
  const db = await getBackendDb();
  const store = await getBackendStore();

  // Verify collection exists
  const collection = await db.prepare("SELECT id, slug FROM collections WHERE id = ?").get(collectionId) as { id: string; slug: string } | undefined;
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const files = formData.getAll("files") as File[];
  const sourceUrl = formData.get("source_url") as string | null;

  if (!files.length) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const modules: Array<{ id: string; filename: string; title: string; version?: string }> = [];

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `File ${file.name} exceeds 5MB limit` }, { status: 413 });
    }
    if (!file.name.endsWith(".js")) {
      return NextResponse.json({ error: `File ${file.name} must be .js` }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const encrypted = isEncrypted(buffer);
    const meta = encrypted ? null : parseWidgetMetadata(buffer.toString("utf8"));
    const moduleId = nanoid();
    const filename = file.name;

    await db.prepare(
      `INSERT INTO modules (id, collection_id, filename, widget_id, title, description, version, author, required_version, file_size, is_encrypted, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      moduleId,
      collectionId,
      filename,
      meta?.id || null,
      meta?.title || filename.replace(".js", ""),
      meta?.description || "",
      meta?.version || null,
      meta?.author || null,
      meta?.requiredVersion || null,
      file.size,
      encrypted ? 1 : 0,
      sourceUrl || null
    );

    const ossKey = await store.save(collectionId, filename, buffer);
    if (ossKey) {
      await db.prepare("UPDATE modules SET oss_key = ? WHERE id = ?").run(ossKey, moduleId);
    }

    modules.push({
      id: moduleId,
      filename,
      title: meta?.title || filename,
      version: meta?.version,
    });
  }

  // Update collection timestamp
  await db.prepare("UPDATE collections SET updated_at = unixepoch() WHERE id = ?").run(collectionId);

  return NextResponse.json({ success: true, modules });
}
 
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
 
export async function DELETE(
  request: NextRequest,
  { params }: { params: Params }
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
