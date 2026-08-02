import assert from "node:assert/strict";
import {
  AnnotationStore,
  serializeAnnotations,
  parseAnnotations,
  type AnnotationDoc,
} from "../src/annotations";
import { DocumentBinder, LEGACY_BUNDLE_LIBRARY } from "../src/document-binding";
import { copyForPdfJs, sha256Hex } from "../src/pdf-bytes";
import { TFile, normalizePath } from "./obsidian-stub";

const HIDDEN = { storageMode: "hidden-beside" as const };
const BESIDE = { storageMode: "beside-pdf" as const };

/** Obsidian keeps anything under a leading-dot folder out of the vault index. */
function isIndexed(path: string): boolean {
  return !normalizePath(path)
    .split("/")
    .some((segment) => segment.startsWith("."));
}

class MemoryAdapter {
  text = new Map<string, string>();
  binary = new Map<string, ArrayBuffer>();
  folders = new Set<string>([""]);

  async exists(path: string): Promise<boolean> {
    path = normalizePath(path);
    return this.text.has(path) || this.binary.has(path) || this.folders.has(path);
  }

  async stat(path: string): Promise<any> {
    path = normalizePath(path);
    if (this.folders.has(path)) return { type: "folder", size: 0, ctime: 0, mtime: 0 };
    if (this.text.has(path)) {
      return {
        type: "file",
        size: new TextEncoder().encode(this.text.get(path)).byteLength,
        ctime: 0,
        mtime: 0,
      };
    }
    if (this.binary.has(path)) {
      return { type: "file", size: this.binary.get(path)!.byteLength, ctime: 0, mtime: 0 };
    }
    return null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    path = normalizePath(path);
    const prefix = path ? `${path}/` : "";
    const direct = (candidate: string) =>
      candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/");
    return {
      files: [...this.text.keys(), ...this.binary.keys()].filter(direct),
      folders: [...this.folders].filter((folder) => folder !== path && direct(folder)),
    };
  }

  async read(path: string): Promise<string> {
    const value = this.text.get(normalizePath(path));
    if (value === undefined) throw new Error(`Missing text file: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.text.set(normalizePath(path), data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binary.get(normalizePath(path));
    if (!value) throw new Error(`Missing binary file: ${path}`);
    return value.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binary.set(normalizePath(path), data.slice(0));
  }

  async remove(path: string): Promise<void> {
    path = normalizePath(path);
    this.text.delete(path);
    this.binary.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    from = normalizePath(from);
    to = normalizePath(to);
    if (this.text.has(from)) {
      this.text.set(to, this.text.get(from)!);
      this.text.delete(from);
    } else if (this.binary.has(from)) {
      this.binary.set(to, this.binary.get(from)!);
      this.binary.delete(from);
    }
  }

  async trashSystem(path: string): Promise<boolean> {
    this.trashed.push(normalizePath(path));
    await this.remove(path);
    return true;
  }

  async trashLocal(path: string): Promise<void> {
    this.trashed.push(normalizePath(path));
    await this.remove(path);
  }

  trashed: string[] = [];

  async mkdir(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }
}

class MemoryVault {
  adapter = new MemoryAdapter();

  get trashed(): string[] {
    return this.adapter.trashed;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.adapter.text.keys()]
      .filter((path) => path.endsWith(".md") && isIndexed(path))
      .map((path) => new TFile(path));
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  getAbstractFileByPath(path: string): TFile | null {
    path = normalizePath(path);
    if (!isIndexed(path)) return null; // hidden folders are not in the index
    return this.adapter.text.has(path) || this.adapter.binary.has(path) ? new TFile(path) : null;
  }

  async rename(file: TFile, target: string): Promise<void> {
    const from = normalizePath(file.path);
    const to = normalizePath(target);
    if (this.adapter.text.has(from)) {
      this.adapter.text.set(to, this.adapter.text.get(from)!);
      this.adapter.text.delete(from);
    } else if (this.adapter.binary.has(from)) {
      this.adapter.binary.set(to, this.adapter.binary.get(from)!);
      this.adapter.binary.delete(from);
    }
    file.setPath(to);
  }
}

function makeApp() {
  const vault = new MemoryVault();
  return {
    vault,
    fileManager: {
      async trashFile(file: TFile) {
        vault.adapter.trashed.push(file.path);
        await vault.adapter.remove(file.path);
      },
    },
  } as any;
}

function docWith(pdf: string, extra: Partial<AnnotationDoc> = {}): AnnotationDoc {
  return {
    version: 1,
    pdf,
    highlights: [
      {
        id: "mark0001",
        page: 0,
        color: "#FBF719",
        text: "an existing annotation",
        rects: [],
        created: "2026-07-17T00:00:00.000Z",
      },
    ],
    ...extra,
  };
}

async function main(): Promise<void> {
  const app = makeApp();
  const vault: MemoryVault = app.vault;
  const binder = new DocumentBinder(app);

  const file = new TFile("Papers/paper.pdf") as any;
  const bytesA = new TextEncoder().encode("original PDF").buffer;
  const bytesB = new TextEncoder().encode("a different PDF").buffer;
  await vault.adapter.writeBinary(file.path, bytesA);

  // --- a PDF with no annotations anywhere -----------------------------------
  const fresh = await binder.prepare(file, bytesA, { pageCount: 12, pathOptions: HIDDEN });
  assert.equal(
    fresh.sidecarPath,
    "Papers/.annotations/paper.annotations.md",
    "the sidecar hides in the PDF's own directory"
  );
  assert.equal(fresh.sidecarBackupPath, "Papers/.annotations/paper.annotations.previous.md");
  assert.equal(fresh.change.kind, "new");
  assert.equal(
    vault.getAbstractFileByPath(fresh.sidecarPath),
    null,
    "hidden sidecars are outside the vault index, so file ops must use the adapter"
  );

  const store = new AnnotationStore({
    adapter: vault.adapter as any,
    sidecarPath: fresh.sidecarPath,
    pdfBasename: file.basename,
    pdfVaultPath: file.path,
    loadFallbackPaths: fresh.fallbackPaths,
    migrateFallbackOnLoad: true,
    sidecarBackupPath: fresh.sidecarBackupPath,
    document: fresh.document,
  });
  await store.load();
  store.add({
    id: "mark0002",
    page: 0,
    color: "#FBF719",
    text: "written now",
    rects: [],
    created: "2026-08-02T00:00:00.000Z",
  });
  await store.flush();

  const written = parseAnnotations(await vault.adapter.read(fresh.sidecarPath))!;
  assert.equal(written.sha256, await sha256Hex(bytesA), "the sidecar records the document hash");
  assert.equal(written.pageCount, 12);
  assert.equal(written.byteLength, bytesA.byteLength);

  // --- reopening the same bytes ---------------------------------------------
  const again = await binder.prepare(file, bytesA, { pageCount: 12, pathOptions: HIDDEN });
  assert.equal(again.change.kind, "unchanged", "matching bytes load without prompting");

  // --- same path, different bytes, same page count ---------------------------
  const reencoded = await binder.prepare(file, bytesB, { pageCount: 12, pathOptions: HIDDEN });
  assert.equal(reencoded.change.kind, "changed");
  assert.equal((reencoded.change as any).samePageCount, true, "an equal page count is reported");
  assert.equal((reencoded.change as any).highlightCount, 1);
  assert.equal((reencoded.change as any).storedPath, fresh.sidecarPath);

  // --- same path, different bytes, different page count ----------------------
  const replaced = await binder.prepare(file, bytesB, { pageCount: 9, pathOptions: HIDDEN });
  assert.equal((replaced.change as any).samePageCount, false, "a different page count is reported");

  // An unknown page count must not be mistaken for agreement.
  const unknownPages = await binder.prepare(file, bytesB, { pathOptions: HIDDEN });
  assert.equal((unknownPages.change as any).samePageCount, false);

  // --- an unstamped sidecar, written by an older version in the OTHER mode ---
  const legacyFile = new TFile("Papers/legacy.pdf") as any;
  const legacyBytes = new TextEncoder().encode("legacy PDF").buffer;
  await vault.adapter.writeBinary(legacyFile.path, legacyBytes);
  await vault.adapter.write(
    "Papers/legacy.annotations.md",
    serializeAnnotations(docWith(legacyFile.path, { fingerprint: "fp-legacy" }), "legacy")
  );
  const unstamped = await binder.prepare(legacyFile, legacyBytes, {
    fingerprint: "fp-legacy",
    pageCount: 4,
    pathOptions: HIDDEN,
  });
  assert.equal(unstamped.change.kind, "first-stamp", "an unstamped sidecar is adopted, not doubted");
  assert.deepEqual(
    unstamped.fallbackPaths,
    ["Papers/legacy.annotations.md"],
    "a visible sidecar is found while running in hidden mode"
  );

  const legacyStore = new AnnotationStore({
    adapter: vault.adapter as any,
    sidecarPath: unstamped.sidecarPath,
    pdfBasename: legacyFile.basename,
    pdfVaultPath: legacyFile.path,
    loadFallbackPaths: unstamped.fallbackPaths,
    migrateFallbackOnLoad: true,
    sidecarBackupPath: unstamped.sidecarBackupPath,
    document: unstamped.document,
  });
  await legacyStore.load();
  assert.equal(legacyStore.doc.highlights.length, 1, "existing annotations survive the upgrade");
  await legacyStore.flush();
  assert.equal(
    unstamped.sidecarPath,
    "Papers/.annotations/legacy.annotations.md",
    "the visible sidecar migrates into the hidden folder"
  );
  const restamped = parseAnnotations(await vault.adapter.read(unstamped.sidecarPath))!;
  assert.equal(restamped.sha256, await sha256Hex(legacyBytes), "loading stamps the hash for next time");
  assert.ok(
    !(await vault.adapter.exists("Papers/legacy.annotations.md")),
    "the migrated-from sidecar no longer looks canonical"
  );
  assert.ok(
    await vault.adapter.exists("Papers/legacy.annotations.migrated.md"),
    "it is retired, not deleted, so it stays a recovery snapshot"
  );
  assert.equal(
    (await binder.prepare(legacyFile, legacyBytes, { pageCount: 4, pathOptions: HIDDEN })).change.kind,
    "unchanged",
    "the upgraded sidecar then compares cleanly"
  );

  // Switching modes must not strand it: the hidden sidecar is now the source.
  const switchedBack = await binder.prepare(legacyFile, legacyBytes, {
    pageCount: 4,
    pathOptions: BESIDE,
  });
  assert.ok(
    switchedBack.fallbackPaths.includes("Papers/.annotations/legacy.annotations.md"),
    "switching storage mode still finds the hidden sidecar"
  );

  // --- annotations still living in the retired bundle layout ----------------
  const bundledFile = new TFile("Papers/bundled.pdf") as any;
  const bundledBytes = new TextEncoder().encode("bundled PDF").buffer;
  const bundledHash = await sha256Hex(bundledBytes);
  await vault.adapter.writeBinary(bundledFile.path, bundledBytes);
  const bundleRoot = `${LEGACY_BUNDLE_LIBRARY}/${bundledHash}`;
  for (const part of [".pdf-annotator", ".pdf-annotator/bundles", LEGACY_BUNDLE_LIBRARY, bundleRoot]) {
    await vault.adapter.mkdir(part);
  }
  await vault.adapter.write(
    `${bundleRoot}/annotations.md`,
    serializeAnnotations(docWith(bundledFile.path), "bundled")
  );
  await vault.adapter.write(
    `${bundleRoot}/manifest.json`,
    JSON.stringify({ originalName: "bundled.pdf", currentPath: bundledFile.path })
  );
  await vault.adapter.writeBinary(`${bundleRoot}/document.pdf`, bundledBytes);

  const bundled = await binder.prepare(bundledFile, bundledBytes, {
    pageCount: 3,
    pathOptions: HIDDEN,
  });
  assert.deepEqual(
    bundled.fallbackPaths,
    [`${bundleRoot}/annotations.md`],
    "the retired bundle sidecar is offered as a migration source"
  );
  const bundledStore = new AnnotationStore({
    adapter: vault.adapter as any,
    sidecarPath: bundled.sidecarPath,
    pdfBasename: bundledFile.basename,
    pdfVaultPath: bundledFile.path,
    loadFallbackPaths: bundled.fallbackPaths,
    migrateFallbackOnLoad: true,
    sidecarBackupPath: bundled.sidecarBackupPath,
    document: bundled.document,
  });
  await bundledStore.load();
  assert.equal(bundledStore.doc.highlights.length, 1);
  assert.ok(
    await vault.adapter.exists("Papers/.annotations/bundled.annotations.md"),
    "bundled annotations migrate to the hidden folder on open"
  );

  const bundles = await binder.listLegacyBundles();
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].backupBytes, bundledBytes.byteLength);
  assert.equal(
    bundles[0].hasAnnotations,
    false,
    "a migrated bundle reports itself empty, which is what unblocks reclaiming"
  );
  const reclaimed = await binder.reclaimLegacyBackups(bundles);
  assert.equal(reclaimed, bundledBytes.byteLength);
  assert.ok(
    !(await vault.adapter.exists(`${bundleRoot}/document.pdf`)),
    "reclaiming deletes only the duplicated PDF"
  );
  assert.ok(
    await vault.adapter.exists(`${bundleRoot}/annotations.migrated.md`),
    "the bundle's annotations survive as a retired snapshot"
  );

  // --- rename carries the sidecars, across directories ----------------------
  // The hidden sidecar is not a TFile, so this exercises the adapter path.
  await vault.adapter.write(fresh.sidecarBackupPath, await vault.adapter.read(fresh.sidecarPath));
  const oldPath = file.path;
  file.setPath("Archive/2026/renamed.pdf");
  const moved = await binder.onPdfRenamed(file, oldPath, HIDDEN);
  assert.equal(moved?.sidecarPath, "Archive/2026/.annotations/renamed.annotations.md");
  assert.ok(
    await vault.adapter.exists("Archive/2026/.annotations/renamed.annotations.md"),
    "the hidden sidecar follows into the new directory"
  );
  assert.ok(
    await vault.adapter.exists("Archive/2026/.annotations/renamed.annotations.previous.md"),
    "the last-known-good copy follows too"
  );
  assert.ok(
    !(await vault.adapter.exists("Papers/.annotations/paper.annotations.md")),
    "nothing is left behind at the old location"
  );

  // Renaming clash.pdf onto other.pdf would move clash's sidecar over one that
  // already describes a different document.
  await vault.adapter.write("Archive/2026/.annotations/clash.annotations.md", "ours");
  await vault.adapter.write(
    "Archive/2026/.annotations/other.annotations.md",
    "someone else's annotations"
  );
  await assert.rejects(
    () =>
      binder.onPdfRenamed(
        new TFile("Archive/2026/other.pdf") as any,
        "Archive/2026/clash.pdf",
        HIDDEN
      ),
    /already exists/,
    "renaming never clobbers another PDF's annotations"
  );
  assert.equal(
    await vault.adapter.read("Archive/2026/.annotations/other.annotations.md"),
    "someone else's annotations"
  );

  // --- deleting a PDF trashes its annotations -------------------------------
  const trashed = await binder.onPdfDeleted(file.path, HIDDEN);
  assert.deepEqual(trashed, [
    "Archive/2026/.annotations/renamed.annotations.md",
    "Archive/2026/.annotations/renamed.annotations.previous.md",
  ]);
  assert.deepEqual(
    vault.trashed,
    trashed,
    "hidden sidecars go through the adapter's trash, never a hard remove"
  );

  // --- a PDF moved outside Obsidian leaves its hidden sidecar behind ---------
  // No rename event ever reaches the plugin, so recovery is by stored hash and
  // needs a directory walk: the orphan is invisible to the vault index.
  const strayBytes = new TextEncoder().encode("stray PDF").buffer;
  await vault.adapter.write(
    "Somewhere/.annotations/stray.annotations.md",
    serializeAnnotations(
      docWith("Somewhere/stray.pdf", { sha256: await sha256Hex(strayBytes) }),
      "stray"
    )
  );
  await vault.adapter.mkdir("Somewhere");
  await vault.adapter.mkdir("Somewhere/.annotations");
  const relocated = new TFile("Elsewhere/stray.pdf") as any;
  await vault.adapter.writeBinary(relocated.path, strayBytes);
  const recovered = await binder.prepare(relocated, strayBytes, {
    pageCount: 5,
    pathOptions: HIDDEN,
  });
  assert.deepEqual(
    recovered.fallbackPaths,
    ["Somewhere/.annotations/stray.annotations.md"],
    "a uniquely matching hash recovers a hidden orphan the index cannot see"
  );

  // --- byte ownership regression --------------------------------------------
  // pdf.js transfers the buffer it receives, so passing a plain view over the
  // caller's ArrayBuffer detaches it and prepare() would then hash zero bytes.
  const transferFile = new TFile("Papers/transferred.pdf") as any;
  const transferBytes = new TextEncoder().encode("transferred PDF").buffer;
  await vault.adapter.writeBinary(transferFile.path, transferBytes);
  const handedToPdfJs = copyForPdfJs(transferBytes);
  structuredClone(handedToPdfJs, { transfer: [handedToPdfJs.buffer] });
  assert.equal(handedToPdfJs.byteLength, 0, "pdf.js keeps the copy it was given");
  assert.notEqual(transferBytes.byteLength, 0, "the caller's PDF bytes survive getDocument");

  const afterTransfer = await binder.prepare(transferFile, transferBytes, {
    pageCount: 2,
    pathOptions: HIDDEN,
  });
  assert.notEqual(
    afterTransfer.document.sha256,
    await sha256Hex(new ArrayBuffer(0)),
    "a document must never be identified by the empty-input digest"
  );

  const detached = new TextEncoder().encode("detached PDF").buffer;
  structuredClone(detached, { transfer: [detached] });
  await assert.rejects(
    () => binder.prepare(transferFile, detached, { pageCount: 2, pathOptions: HIDDEN }),
    /empty PDF bytes/,
    "detached PDF bytes are rejected instead of hashing to the empty digest"
  );

  console.log("document binding smoke test passed");
}

void main();
