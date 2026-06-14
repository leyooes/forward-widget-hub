import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getBackendDb, getBackendStore } from "@/lib/backend";
import { verifyAdmin } from "@/lib/admin-auth";
import { parseWidgetMetadata, isEncrypted } from "@/lib/parser";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 30_000;

interface FwdWidget {
  id?: string;
  title?: string;
  description?: string;
  version?: string;
  author?: string;
  requiredVersion?: string;
  url: string;
}

interface FwdIndex {
  title?: string;
  description?: string;
  icon?: string;
  widgets: FwdWidget[];
}

async function downloadRemoteJs(url: string): Promise<{ buffer: Buffer; filename: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Forward" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_SIZE) throw new Error("Remote file exceeds 5MB limit");
    const urlPath = new URL(url).pathname;
    let filename = urlPath.split("/").pop() || "widget.js";
    if (!filename.endsWith(".js")) filename += ".js";
    return { buffer: buf, filename };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadRaw(url: string): Promise<Buffer> {
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

  const collection = await db.prepare("SELECT id, slug FROM collections WHERE id = ?").get(collectionId) as { id: string; slug: string } | undefined;
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const files = formData.getAll("files") as File[];
  const sourceUrl = formData.get("source_url") as string | null;
  const remoteUrl = formData.get("url") as string | null;
  const syncMode = formData.get("sync") === "true";

  if (!files.length && !remoteUrl) {
    return NextResponse.json({ error: "No files or URL provided" }, { status: 400 });
  }

  // Sync mode: download .fwd from URL, replace all modules
  if (syncMode && remoteUrl) {
    let fwdContent: string;
    try {
      fwdContent = (await downloadRaw(remoteUrl)).toString("utf8");
    } catch (e) {
      return NextResponse.json({ error: `Failed to download .fwd: ${(e as Error).message}` }, { status: 400 });
    }

    let fwd: FwdIndex;
    try {
      const parsed = JSON.parse(fwdContent);
      if (!parsed.widgets || !Array.isArray(parsed.widgets)) throw new Error("Invalid .fwd: missing widgets");
      fwd = parsed as FwdIndex;
    } catch (e) {
      return NextResponse.json({ error: `Invalid .fwd: ${(e as Error).message}` }, { status: 400 });
    }

    await db.prepare(
      "UPDATE collections SET title = COALESCE(?, title), description = COALESCE(?, description), source_url = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(fwd.title || null, fwd.description || null, remoteUrl, collectionId);

    await db.prepare("DELETE FROM modules WHERE collection_id = ?").run(collectionId);
    await store.removeCollection(collectionId);

    const modules: Array<{ id: string; filename: string; title: string; version?: string; encrypted: boolean }> = [];
    for (const widget of fwd.widgets) {
      const dl = await downloadRemoteJs(widget.url);
      const encrypted = isEncrypted(dl.buffer);
      const meta = encrypted ? null : parseWidgetMetadata(dl.buffer.toString("utf8"));
      const moduleId = nanoid();

      await db.prepare(
        `INSERT INTO modules (id, collection_id, filename, widget_id, title, description, version, author, required_version, file_size, is_encrypted, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        moduleId, collectionId, dl.filename,
        widget.id || meta?.id || null,
        widget.title || meta?.title || dl.filename.replace(".js", ""),
        widget.description || meta?.description || "",
        widget.version || meta?.version || null,
        widget.author || meta?.author || null,
        widget.requiredVersion || meta?.requiredVersion || null,
        dl.buffer.length, encrypted ? 1 : 0,
        widget.url
      );

      const ossKey = await store.save(collectionId, dl.filename, dl.buffer);
      if (ossKey) await db.prepare("UPDATE modules SET oss_key = ? WHERE id = ?").run(ossKey, moduleId);

      modules.push({ id: moduleId, filename: dl.filename, title: widget.title || meta?.title || dl.filename, version: widget.version || meta?.version, encrypted });
    }

    return NextResponse.json({ success: true, modules });
  }

  // Handle remote URL (single .js): download server-side
  if (remoteUrl && files.length === 0) {
    let downloaded: { buffer: Buffer; filename: string };
    try {
      downloaded = await downloadRemoteJs(remoteUrl);
    } catch (e) {
      return NextResponse.json({ error: `Failed to download: ${(e as Error).message}` }, { status: 400 });
    }

    const { buffer, filename } = downloaded;
    const encrypted = isEncrypted(buffer);
    const meta = encrypted ? null : parseWidgetMetadata(buffer.toString("utf8"));
    const moduleId = nanoid();

    await db.prepare(
      `INSERT INTO modules (id, collection_id, filename, widget_id, title, description, version, author, required_version, file_size, is_encrypted, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      moduleId, collectionId, filename,
      meta?.id || null, meta?.title || filename.replace(".js", ""),
      meta?.description || "", meta?.version || null,
      meta?.author || null, meta?.requiredVersion || null,
      buffer.length, encrypted ? 1 : 0, remoteUrl
    );

    const ossKey = await store.save(collectionId, filename, buffer);
    if (ossKey) await db.prepare("UPDATE modules SET oss_key = ? WHERE id = ?").run(ossKey, moduleId);
    await db.prepare("UPDATE collections SET updated_at = unixepoch() WHERE id = ?").run(collectionId);

    return NextResponse.json({
      success: true,
      modules: [{ id: moduleId, filename, title: meta?.title || filename, version: meta?.version }],
    });
  }

  // Local file upload
  const modules: Array<{ id: string; filename: string; title: string; version?: string }> = [];
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) return NextResponse.json({ error: `File ${file.name} exceeds 5MB limit` }, { status: 413 });
    if (!file.name.endsWith(".js")) return NextResponse.json({ error: `File ${file.name} must be .js` }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const encrypted = isEncrypted(buffer);
    const meta = encrypted ? null : parseWidgetMetadata(buffer.toString("utf8"));
    const moduleId = nanoid();
    const filename = file.name;

    await db.prepare(
      `INSERT INTO modules (id, collection_id, filename, widget_id, title, description, version, author, required_version, file_size, is_encrypted, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(moduleId, collectionId, filename, meta?.id || null, meta?.title || filename.replace(".js", ""),
      meta?.description || "", meta?.version || null, meta?.author || null, meta?.requiredVersion || null,
      file.size, encrypted ? 1 : 0, sourceUrl || null);

    const ossKey = await store.save(collectionId, filename, buffer);
    if (ossKey) await db.prepare("UPDATE modules SET oss_key = ? WHERE id = ?").run(ossKey, moduleId);
    modules.push({ id: moduleId, filename, title: meta?.title || filename, version: meta?.version });
  }

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

  let iconUrl: string | null = null;
  if (icon) {
    const store = await getBackendStore();
    // Delete all old icon files (could be a different extension or case)
    for (const oldExt of ["jpg", "jpeg", "png", "gif", "webp", "svg", "JPG", "JPEG", "PNG", "GIF", "WEBP", "SVG"]) {
      await store.remove(id, `_icon.${oldExt}`).catch(() => {});
    }
    const iconBuffer = Buffer.from(await icon.arrayBuffer());
    const ext = (icon.name.split(".").pop() || "png").toLowerCase();
    const iconKey = `_icon.${ext}`;
    await store.save(id, iconKey, iconBuffer);
    iconUrl = `/api/collections/${collection.slug}/icon?t=${Date.now()}`;
  }

  await db.prepare(
    "UPDATE collections SET title = ?, description = ?, icon_url = COALESCE(?, icon_url), updated_at = unixepoch() WHERE id = ?"
  ).run(title.trim(), description || "", iconUrl, id);

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
