/**
 * document-binding.ts — decide WHICH sidecar belongs to the PDF being opened,
 * and whether it still describes that PDF.
 *
 * The design splits two jobs that used to be conflated into a content-addressed
 * folder tree:
 *
 *   - the PDF's vault path LOCATES its sidecar (see sidecarPathFor)
 *   - the sidecar's stored `sha256` PROVES the sidecar belongs to it
 *
 * Locating by path is what makes the storage obvious: annotations sit beside
 * the PDF, move with it in Finder, and are deleted with it. Proving by hash is
 * what keeps the old guarantee that replacing a file with different bytes at
 * the same path can never silently inherit somebody else's annotations —
 * `prepare()` reports that as a `changed` verdict and refuses to decide alone.
 *
 * Nothing here copies the PDF. An earlier design kept a verified byte-for-byte
 * backup per document; it doubled vault size for re-downloadable papers and is
 * now migrated away by migrateLegacyBundle()/reclaimLegacyBackups().
 */
import { App, TFile, normalizePath } from "obsidian";
import {
  HIDDEN_ANNOTATION_FOLDER,
  allSidecarPathsFor,
  parseAnnotations,
  sidecarBackupPathFor,
  sidecarPathFor,
  type AnnotationDoc,
  type AnnotationPathOptions,
  type DocumentMetadata,
} from "./annotations";
import { sha256Hex } from "./pdf-bytes";

export { sha256Hex } from "./pdf-bytes";

/** Where the retired bundle system kept its data; read-only, for migration. */
export const LEGACY_BUNDLE_LIBRARY = ".pdf-annotator/bundles/sha256";

/**
 * What opening this PDF means for the annotations found for it.
 *
 * `changed` is the interesting one: the sidecar was written against different
 * bytes. `samePageCount` grades it — an equal page count is almost always a
 * re-download or re-encode of the same document, where the stored user-space
 * geometry still lands correctly and the user can confirm visually. A differing
 * page count means a genuinely different document.
 */
export type DocumentChange =
  | { kind: "new" }
  | { kind: "unchanged" }
  | { kind: "first-stamp"; highlightCount: number }
  | { kind: "changed"; samePageCount: boolean; highlightCount: number; storedPath: string };

export interface DocumentBinding {
  /** Canonical sidecar for this PDF under the current storage mode. */
  sidecarPath: string;
  sidecarBackupPath: string;
  /** Older/other-mode locations to import from, in priority order. */
  fallbackPaths: string[];
  /** Identity of the file on disk right now. */
  document: DocumentMetadata;
  change: DocumentChange;
}

export interface PrepareOptions {
  fingerprint?: string;
  /** From the already-open pdf.js document, so the verdict is complete here. */
  pageCount?: number;
  pathOptions: AnnotationPathOptions;
}

export interface LegacyBundle {
  hash: string;
  rootPath: string;
  annotationPath: string;
  documentPath: string;
  originalName: string;
  currentPath: string | null;
  hasAnnotations: boolean;
  backupBytes: number;
}

export type MigrationOutcome =
  | { kind: "migrated"; from: string; to: string }
  | { kind: "skipped"; reason: string };

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(new Set(paths.filter((path): path is string => !!path).map(normalizePath)));
}

export class DocumentBinder {
  /** Built once per session; only used to recover sidecars orphaned by a move
   * made outside Obsidian, which is rare and costs a full markdown scan. */
  private sidecarIndex: { bySha: Map<string, string[]>; byFingerprint: Map<string, string[]> } | null =
    null;

  constructor(private app: App) {}

  /** Resolve the sidecar and judge whether it still describes this PDF. */
  async prepare(
    file: TFile,
    pdfData: ArrayBuffer,
    options: PrepareOptions
  ): Promise<DocumentBinding> {
    // A detached ArrayBuffer (e.g. one already transferred to a pdf.js worker)
    // reports byteLength 0 and hashes to the empty-input digest, which would
    // make every document look identical to every other. Refuse instead.
    if (!pdfData.byteLength) {
      throw new Error(
        `Refusing to bind annotations for ${file.path} from empty PDF bytes ` +
          `(the buffer is empty or was already handed to another consumer).`
      );
    }
    const document: DocumentMetadata = {
      sha256: await sha256Hex(pdfData),
      pageCount: options.pageCount,
      byteLength: pdfData.byteLength,
    };

    const sidecarPath = sidecarPathFor(file.path, options.pathOptions);
    const sidecarBackupPath = sidecarBackupPathFor(sidecarPath);
    const stored = await this.readSidecar(sidecarPath);

    const fallbackPaths = stored
      ? []
      : await this.fallbackCandidates(file.path, document, options, sidecarPath);
    const source = stored
      ? { path: sidecarPath, doc: stored }
      : await this.firstReadable([sidecarBackupPath, ...fallbackPaths]);

    return {
      sidecarPath,
      sidecarBackupPath,
      fallbackPaths: uniquePaths([
        (await this.app.vault.adapter.exists(sidecarBackupPath)) ? sidecarBackupPath : null,
        ...fallbackPaths,
      ]),
      document,
      change: this.judge(document, source),
    };
  }

  private judge(
    actual: DocumentMetadata,
    source: { path: string; doc: AnnotationDoc } | null
  ): DocumentChange {
    if (!source || !source.doc.highlights.length) return { kind: "new" };
    const stored = source.doc;
    if (!stored.sha256) return { kind: "first-stamp", highlightCount: stored.highlights.length };
    if (stored.sha256 === actual.sha256) return { kind: "unchanged" };
    return {
      kind: "changed",
      // Unknown page counts must not masquerade as agreement.
      samePageCount:
        typeof stored.pageCount === "number" &&
        typeof actual.pageCount === "number" &&
        stored.pageCount === actual.pageCount,
      highlightCount: stored.highlights.length,
      storedPath: source.path,
    };
  }

  /**
   * Sidecars written by an older layout or the other storage mode, filtered to
   * those that plausibly describe THIS document. A candidate that disagrees on
   * hash or fingerprint belongs to a different PDF and is never imported.
   */
  private async fallbackCandidates(
    pdfPath: string,
    document: DocumentMetadata,
    options: PrepareOptions,
    canonicalPath: string
  ): Promise<string[]> {
    const direct = uniquePaths([
      // The retired bundle layout, keyed by this document's hash.
      document.sha256 ? `${LEGACY_BUNDLE_LIBRARY}/${document.sha256}/annotations.md` : null,
      // Every other storage mode, so switching modes never strands anything.
      ...allSidecarPathsFor(pdfPath, options.pathOptions.storageFolder),
    ]).filter((path) => path !== canonicalPath);

    const existing: string[] = [];
    for (const path of direct) {
      if (await this.candidateMatches(path, document, options.fingerprint)) existing.push(path);
    }

    // A unique hash/fingerprint match recovers a sidecar orphaned when its PDF
    // was moved outside Obsidian, where no rename event ever reached us.
    const index = await this.getSidecarIndex();
    for (const matches of [
      document.sha256 ? index.bySha.get(document.sha256) : undefined,
      options.fingerprint ? index.byFingerprint.get(options.fingerprint) : undefined,
    ]) {
      if (existing.length) break;
      const candidates = (matches ?? []).filter((path) => path !== canonicalPath);
      if (candidates.length === 1) existing.push(candidates[0]);
    }
    return existing;
  }

  private async candidateMatches(
    path: string,
    document: DocumentMetadata,
    fingerprint: string | undefined
  ): Promise<boolean> {
    const parsed = await this.readSidecar(path);
    if (!parsed) return false;
    if (parsed.sha256 && document.sha256 && parsed.sha256 !== document.sha256) return false;
    return !fingerprint || !parsed.fingerprint || parsed.fingerprint === fingerprint;
  }

  private async readSidecar(path: string): Promise<AnnotationDoc | null> {
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      return parseAnnotations(await this.app.vault.adapter.read(path));
    } catch {
      return null;
    }
  }

  private async firstReadable(
    paths: string[]
  ): Promise<{ path: string; doc: AnnotationDoc } | null> {
    for (const path of paths) {
      const doc = await this.readSidecar(path);
      if (doc) return { path, doc };
    }
    return null;
  }

  private async getSidecarIndex(): Promise<{
    bySha: Map<string, string[]>;
    byFingerprint: Map<string, string[]>;
  }> {
    if (this.sidecarIndex) return this.sidecarIndex;
    const bySha = new Map<string, string[]>();
    const byFingerprint = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, key: string, path: string) => {
      const paths = map.get(key) ?? [];
      paths.push(path);
      map.set(key, paths);
    };
    const visible = this.app.vault
      .getMarkdownFiles()
      .map((file) => file.path)
      .filter((path) => path.toLowerCase().endsWith(".annotations.md"));
    for (const path of uniquePaths([...visible, ...(await this.collectHiddenSidecars())])) {
      const parsed = await this.readSidecar(path);
      if (!parsed) continue;
      if (parsed.sha256) push(bySha, parsed.sha256, path);
      if (parsed.fingerprint) push(byFingerprint, parsed.fingerprint, path);
    }
    this.sidecarIndex = { bySha, byFingerprint };
    return this.sidecarIndex;
  }

  /**
   * Sidecars in hidden ".annotations" folders are absent from the vault index,
   * so finding an orphaned one needs a directory walk. Only reached when no
   * direct candidate matched, and cached for the rest of the session.
   */
  private async collectHiddenSidecars(): Promise<string[]> {
    const found: string[] = [];
    const visit = async (folder: string): Promise<void> => {
      let listing;
      try {
        listing = await this.app.vault.adapter.list(folder);
      } catch {
        return; // An unreadable folder must not abort the whole scan.
      }
      for (const file of listing.files) {
        if (file.toLowerCase().endsWith(".annotations.md")) found.push(file);
      }
      for (const sub of listing.folders) {
        const name = sub.split("/").pop() ?? "";
        // Descend into our own hidden folders, but never into .obsidian,
        // .trash, .git, or the retired bundle library.
        if (name !== HIDDEN_ANNOTATION_FOLDER && name.startsWith(".")) continue;
        await visit(sub);
      }
    };
    await visit("");
    return found;
  }

  /** Sidecars follow their PDF so a rename cannot orphan them. */
  async onPdfRenamed(
    file: TFile,
    oldPath: string,
    pathOptions: AnnotationPathOptions
  ): Promise<{ sidecarPath: string; sidecarBackupPath: string } | null> {
    this.sidecarIndex = null;
    const from = sidecarPathFor(oldPath, pathOptions);
    const to = sidecarPathFor(file.path, pathOptions);
    if (from === to) return null;
    await this.moveIfPresent(from, to);
    await this.moveIfPresent(sidecarBackupPathFor(from), sidecarBackupPathFor(to));
    return { sidecarPath: to, sidecarBackupPath: sidecarBackupPathFor(to) };
  }

  /**
   * Move a sidecar, whether or not it is in the vault index. Sidecars under the
   * hidden ".annotations" folder are NOT TFiles, so vault.rename cannot see
   * them; visible ones still go through the vault so Obsidian's index follows.
   */
  private async moveIfPresent(from: string, to: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(from))) return;
    if (await adapter.exists(to)) {
      // Clobbering an existing sidecar would destroy annotations that belong to
      // a different PDF. Leave ours where it is; it is still discoverable.
      throw new Error(`Cannot move ${from} to ${to} because a file already exists there.`);
    }
    await this.ensureFolder(normalizePath(to).split("/").slice(0, -1).join("/"));
    const source = this.app.vault.getAbstractFileByPath(from);
    if (source instanceof TFile) await this.app.vault.rename(source, to);
    else await adapter.rename(from, to);
  }

  /**
   * Delete a PDF's annotations along with the PDF.
   *
   * Callers MUST only reach this from the vault's `delete` event. Absence of a
   * file is not deletion — a half-synced vault or a move made in Finder looks
   * identical — and this is the only irreversible operation in the plugin. It
   * routes through the user's configured deletion behaviour so it is
   * recoverable from the trash.
   */
  async onPdfDeleted(path: string, pathOptions: AnnotationPathOptions): Promise<string[]> {
    this.sidecarIndex = null;
    const sidecarPath = sidecarPathFor(path, pathOptions);
    const trashed: string[] = [];
    for (const candidate of [sidecarPath, sidecarBackupPathFor(sidecarPath)]) {
      if (!(await this.app.vault.adapter.exists(candidate))) continue;
      const file = this.app.vault.getAbstractFileByPath(candidate);
      if (file instanceof TFile) {
        // Honours the user's configured deletion behaviour.
        await this.app.fileManager.trashFile(file);
      } else {
        // Hidden sidecars are invisible to the vault index; fall back to the
        // adapter, still via a trash so the delete stays recoverable.
        if (!(await this.app.vault.adapter.trashSystem(candidate))) {
          await this.app.vault.adapter.trashLocal(candidate);
        }
      }
      trashed.push(candidate);
    }
    return trashed;
  }

  /** Write a user-visible snapshot without making that path authoritative. */
  async exportAnnotations(
    file: TFile,
    exportFolder: string,
    pathOptions: AnnotationPathOptions
  ): Promise<string> {
    const sidecarPath = sidecarPathFor(file.path, pathOptions);
    if (!(await this.app.vault.adapter.exists(sidecarPath))) {
      throw new Error("No annotations exist for this PDF.");
    }
    const folder = normalizePath(exportFolder).replace(/^\/+|\/+$/g, "");
    await this.ensureFolder(folder);
    const exportPath = normalizePath(`${folder}/${file.basename}.annotations.md`);
    await this.app.vault.adapter.write(
      exportPath,
      await this.app.vault.adapter.read(sidecarPath)
    );
    return exportPath;
  }

  // ---------------------------------------------------------------------------
  // Migration off the retired bundle layout.
  // ---------------------------------------------------------------------------

  async listLegacyBundles(): Promise<LegacyBundle[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(LEGACY_BUNDLE_LIBRARY))) return [];
    const bundles: LegacyBundle[] = [];
    for (const folder of (await adapter.list(LEGACY_BUNDLE_LIBRARY)).folders) {
      const hash = folder.split("/").pop() ?? "";
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      const rootPath = `${LEGACY_BUNDLE_LIBRARY}/${hash}`;
      const annotationPath = `${rootPath}/annotations.md`;
      const documentPath = `${rootPath}/document.pdf`;
      let manifest: any = null;
      try {
        manifest = JSON.parse(await adapter.read(`${rootPath}/manifest.json`));
      } catch {
        /* A bundle without a readable manifest can still be reported. */
      }
      const parsed = await this.readSidecar(annotationPath);
      bundles.push({
        hash,
        rootPath,
        annotationPath,
        documentPath,
        originalName: manifest?.originalName ?? `${hash.slice(0, 12)}.pdf`,
        currentPath: manifest?.currentPath ?? null,
        hasAnnotations: !!parsed?.highlights.length,
        backupBytes: (await adapter.stat(documentPath))?.size ?? 0,
      });
    }
    return bundles;
  }

  /** Copy one bundle's annotations to the sidecar beside its PDF. */
  async migrateLegacyBundle(
    bundle: LegacyBundle,
    pathOptions: AnnotationPathOptions
  ): Promise<MigrationOutcome> {
    if (!bundle.hasAnnotations) return { kind: "skipped", reason: "no annotations" };
    if (!bundle.currentPath) {
      return { kind: "skipped", reason: `${bundle.originalName}: PDF path unknown` };
    }
    const pdf = this.app.vault.getAbstractFileByPath(bundle.currentPath);
    if (!(pdf instanceof TFile)) {
      return { kind: "skipped", reason: `${bundle.currentPath} no longer exists` };
    }
    const target = sidecarPathFor(bundle.currentPath, pathOptions);
    if (await this.app.vault.adapter.exists(target)) {
      return { kind: "skipped", reason: `${target} already exists` };
    }
    await this.ensureFolder(normalizePath(target).split("/").slice(0, -1).join("/"));
    await this.app.vault.adapter.write(
      target,
      await this.app.vault.adapter.read(bundle.annotationPath)
    );
    this.sidecarIndex = null;
    return { kind: "migrated", from: bundle.annotationPath, to: target };
  }

  /** Delete only the duplicated PDF copies, leaving bundle annotations intact. */
  async reclaimLegacyBackups(bundles: LegacyBundle[]): Promise<number> {
    let reclaimed = 0;
    for (const bundle of bundles) {
      if (!bundle.backupBytes) continue;
      await this.app.vault.adapter.remove(bundle.documentPath);
      reclaimed += bundle.backupBytes;
    }
    return reclaimed;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const stat = await this.app.vault.adapter.stat(current);
      if (stat?.type === "folder") continue;
      if (stat) throw new Error(`Cannot create annotation folder because ${current} is a file.`);
      try {
        await this.app.vault.adapter.mkdir(current);
      } catch (error) {
        if ((await this.app.vault.adapter.stat(current))?.type !== "folder") throw error;
      }
    }
  }
}
