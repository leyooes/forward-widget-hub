import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getBackendDb, getBackendStore } from "@/lib/backend";
import { verifyAdmin } from "@/lib/admin-auth";
import { parseWidgetMetadata } from "@/lib/parser";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
 
type Params = Promise<{ id: string }>;

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const denied = await verifyAdmin(request);
    if (denied) return denied;

    const { id: collectionId } = await params;
    const db = await getBackendDb();
    const store = await getBackendStore();

    const collection = await db.prepare("SELECT id, slug FROM collections WHERE id = ?").get(collectionId) as { id: string; slug: string } | undefined;
    if (!collection) {
      return NextResponse.json({ error: "Collection not found" }, { status: 404 });
    }

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    const remoteUrl = formData.get("url") as string | null;
    const sourceUrl = formData.get("source_url") as string | null;

    let filesToProcess: Array<{ buffer: Buffer; filename: string; sourceUrl: string | null }> = [];

    // 处理通过 URL 下载的文件
    if (remoteUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(remoteUrl, { signal: controller.signal, headers: { "User-Agent": "ForwardWidgetHub" } });
        clearTimeout(timeout);
        
        if (!res.ok) {
          return NextResponse.json({ error: `Failed to download: HTTP ${res.status}` }, { status: 400 });
        }
        
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > MAX_FILE_SIZE) {
          return NextResponse.json({ error: "File exceeds 5MB limit" }, { status: 413 });
        }
        
        const urlPath = new URL(remoteUrl).pathname;
        let filename = urlPath.split("/").pop() || "widget.js";
        if (!filename.endsWith(".js")) filename += ".js";
        
        filesToProcess.push({ buffer, filename, sourceUrl: remoteUrl });
      } catch (e) {
        return NextResponse.json({ error: `Failed to download: ${(e as Error).message}` }, { status: 400 });
      }
    }

    // 处理直接上传的文件
    if (files.length > 0) {
      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          return NextResponse.json({ error: `File ${file.name} exceeds 5MB limit` }, { status: 413 });
        }
        if (!file.name.endsWith(".js")) {
          return NextResponse.json({ error: `File ${file.name} must be .js` }, { status: 400 });
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        filesToProcess.push({ buffer, filename: file.name, sourceUrl: sourceUrl || null });
      }
    }

    if (filesToProcess.length === 0 && !remoteUrl) {
      return NextResponse.json({ error: "No files or URL provided" }, { status: 400 });
    }

    const modules: Array<{ id: string; filename: string; title: string; version?: string }> = [];

    for (const { buffer, filename, sourceUrl: fileSourceUrl } of filesToProcess) {
      const encrypted = buffer.toString("utf8").startsWith("enc:");
      const meta = encrypted ? null : parseWidgetMetadata(buffer.toString("utf8"));
      const moduleId = nanoid();

      await db.prepare(
        `INSERT INTO modules (id, collection_id, filename, widget_id, title, description, version, author, required_version, file_size, is_encrypted, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
        buffer.length,
        encrypted ? 1 : 0,
        fileSourceUrl || null
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

    await db.prepare("UPDATE collections SET updated_at = unixepoch() WHERE id = ?").run(collectionId);

    return NextResponse.json({ success: true, modules });
  } catch (error) {
    console.error("Admin POST error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Server error: ${msg}` }, { status: 500 });
  }
}
 
export async function PUT(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const denied = await verifyAdmin(request);
    if (denied) return denied;
 
    const { id } = await params;
    const db = await getBackendDb();
 
    const collection = (await db
      .prepare("SELECT id, slug, icon_url FROM collections WHERE id = ?")
      .get(id)) as { id: string; slug: string; icon_url: string } | undefined;
 
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
 
    let iconUrl = collection.icon_url || "";
 
    if (icon) {
      const store = await getBackendStore();
      const iconBuffer = Buffer.from(await icon.arrayBuffer());
      const ext = icon.name.split(".").pop() || "png";
      const iconKey = `_icon.${ext}`;
      await store.save(id, iconKey, iconBuffer);
      const proto = request.headers.get("x-forwarded-proto") || "https";
      const host = request.headers.get("host") || request.nextUrl.host;
      iconUrl = `${proto}://${host}/api/collections/${collection.slug}/icon`;
    }
 
    await db.prepare(
      "UPDATE collections SET title = ?, description = ?, icon_url = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(title.trim(), description || "", iconUrl, id);
 
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Admin PUT error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Server error: ${msg}` }, { status: 500 });
  }
}
 
export async function DELETE(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
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
  } catch (error) {
    console.error("Admin DELETE error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Server error: ${msg}` }, { status: 500 });
  }
}
