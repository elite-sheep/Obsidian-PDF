import assert from "node:assert/strict";
import { AnnotationStore, serializeAnnotations, type AnnotationDoc } from "../src/annotations";
import { PdfBundleManager, sha256Hex } from "../src/bundles";
import { copyForPdfJs } from "../src/pdf-bytes";
import { TFile, normalizePath } from "./obsidian-stub";

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
      return { type: "file", size: new TextEncoder().encode(this.text.get(path)).byteLength, ctime: 0, mtime: 0 };
    }
    if (this.binary.has(path)) {
      return { type: "file", size: this.binary.get(path)!.byteLength, ctime: 0, mtime: 0 };
    }
    return null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    path = normalizePath(path);
    const prefix = path ? `${path}/` : "";
    const direct = (candidate: string) => {
      if (!candidate.startsWith(prefix)) return false;
      return !candidate.slice(prefix.length).includes("/");
    };
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

  async mkdir(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }
}

class MemoryVault {
  adapter = new MemoryAdapter();

  getMarkdownFiles(): TFile[] {
    return [...this.adapter.text.keys()]
      .filter((path) => path.endsWith(".md") && !path.startsWith(".pdf-annotator/"))
      .map((path) => new TFile(path));
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.adapter.binary.has(normalizePath(path)) ? new TFile(path) : null;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (await this.adapter.exists(path)) throw new Error(`Already exists: ${path}`);
    await this.adapter.writeBinary(path, data);
    return new TFile(path);
  }
}

async function main(): Promise<void> {
  const vault = new MemoryVault();
  const app = { vault } as any;
  const manager = new PdfBundleManager(app);
  const file = new TFile("Downloads/paper.pdf") as any;
  const originalBytes = new TextEncoder().encode("original PDF").buffer;
  const replacementBytes = new TextEncoder().encode("replacement PDF").buffer;
  await vault.adapter.writeBinary(file.path, originalBytes);

  const legacyPath = "PDF annotations/Downloads/paper.annotations.md";
  const legacyDoc: AnnotationDoc = {
    version: 1,
    pdf: file.path,
    fingerprint: "fingerprint-a",
    highlights: [
      {
        id: "legacy01",
        page: 0,
        color: "#FBF719",
        text: "survives migration",
        rects: [],
        created: "2026-07-17T00:00:00.000Z",
      },
    ],
  };
  await vault.adapter.write(legacyPath, serializeAnnotations(legacyDoc, file.basename));

  const first = await manager.prepare(
    file,
    originalBytes,
    "fingerprint-a",
    { storageMode: "folder", storageFolder: "PDF annotations" }
  );
  assert.ok(await vault.adapter.exists(first.backupPath), "first annotation open creates a PDF backup");
  assert.deepEqual(first.fallbackAnnotationPaths, [legacyPath]);

  const store = new AnnotationStore(
    vault.adapter as any,
    first.annotationPath,
    file.basename,
    file.path,
    "fingerprint-a",
    first.fallbackAnnotationPaths,
    true,
    first.annotationBackupPath
  );
  await store.load();
  assert.equal(store.doc.highlights.length, 1);
  assert.ok(await vault.adapter.exists(first.annotationPath), "legacy annotations migrate immediately");
  assert.ok(await vault.adapter.exists(legacyPath), "migration retains the legacy recovery snapshot");

  store.update("legacy01", { note: "newer state" });
  await store.flush();
  assert.ok(
    await vault.adapter.exists(first.annotationBackupPath),
    "successful updates retain a last-known-good annotation copy"
  );
  await vault.adapter.write(first.annotationPath, "partially written");
  const recoveryStore = new AnnotationStore(
    vault.adapter as any,
    first.annotationPath,
    file.basename,
    file.path,
    "fingerprint-a",
    [first.annotationBackupPath],
    true,
    first.annotationBackupPath
  );
  await recoveryStore.load();
  assert.equal(recoveryStore.doc.highlights.length, 1, "corrupt canonical state recovers from previous");
  assert.ok(
    (await vault.adapter.read(first.annotationPath)).includes('"highlights"'),
    "recovery repairs the canonical sidecar"
  );

  const oldPath = file.path;
  file.setPath("Library/Philosophy/paper-renamed.pdf");
  await manager.onPdfRenamed(file, oldPath);
  const renamedManifest = JSON.parse(await vault.adapter.read(first.manifestPath));
  assert.equal(renamedManifest.currentPath, file.path);
  assert.ok(renamedManifest.aliases.includes(oldPath));
  assert.ok(renamedManifest.aliases.includes(file.path));

  await manager.onPdfDeleted(file.path);
  const deletedManifest = JSON.parse(await vault.adapter.read(first.manifestPath));
  assert.equal(deletedManifest.currentPath, null);
  assert.ok(await vault.adapter.exists(first.backupPath), "deleting the working copy keeps the backup");

  const restored = await manager.restoreBundle(first);
  assert.equal(restored.path, "Recovered PDFs/paper.pdf");
  assert.deepEqual(
    new Uint8Array(await vault.adapter.readBinary(restored.path)),
    new Uint8Array(originalBytes)
  );

  const replacementFile = new TFile("Downloads/paper.pdf") as any;
  await vault.adapter.writeBinary(replacementFile.path, replacementBytes);
  const replacement = await manager.prepare(
    replacementFile,
    replacementBytes,
    "fingerprint-b",
    { storageMode: "folder", storageFolder: "PDF annotations" }
  );
  assert.notEqual(first.id, replacement.id, "same path with different bytes creates a new bundle");
  assert.deepEqual(
    replacement.fallbackAnnotationPaths,
    [],
    "a replacement PDF cannot inherit a mismatched legacy sidecar"
  );

  // Opening a document must not give away the bytes the bundle still needs.
  // pdf.js transfers the buffer it receives, so passing a plain view over the
  // caller's ArrayBuffer detaches it and prepare() then hashes zero bytes.
  const transferFile = new TFile("Downloads/transferred.pdf") as any;
  const transferBytes = new TextEncoder().encode("transferred PDF").buffer;
  await vault.adapter.writeBinary(transferFile.path, transferBytes);
  const handedToPdfJs = copyForPdfJs(transferBytes);
  structuredClone(handedToPdfJs, { transfer: [handedToPdfJs.buffer] });
  assert.equal(handedToPdfJs.byteLength, 0, "pdf.js keeps the copy it was given");
  assert.notEqual(transferBytes.byteLength, 0, "the caller's PDF bytes survive getDocument");

  const afterTransfer = await manager.prepare(transferFile, transferBytes, "fingerprint-c", {
    storageMode: "folder",
    storageFolder: "PDF annotations",
  });
  assert.notEqual(
    afterTransfer.id,
    await sha256Hex(new ArrayBuffer(0)),
    "a document must never be identified by the empty-input digest"
  );
  assert.deepEqual(
    new Uint8Array(await vault.adapter.readBinary(afterTransfer.backupPath)),
    new Uint8Array(transferBytes),
    "the verified backup holds the real PDF bytes"
  );

  const detached = new TextEncoder().encode("detached PDF").buffer;
  structuredClone(detached, { transfer: [detached] });
  await assert.rejects(
    () =>
      manager.prepare(transferFile, detached, "fingerprint-d", {
        storageMode: "folder",
        storageFolder: "PDF annotations",
      }),
    /empty PDF bytes/,
    "detached PDF bytes are rejected instead of hashing to the empty digest"
  );

  console.log("bundle manager smoke test passed");
}

void main();
