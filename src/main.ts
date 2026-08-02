/**
 * main.ts — PDF Annotator plugin entry point.
 *
 * Triggers (all public, documented API):
 *   - command "Open current PDF in annotator" (stable custom-view fallback)
 *   - file-open bridge: ordinary .pdf clicks are redirected into this view
 *   - native overlay (experimental): an "Annotate" toggle injected into the
 *     native PDF view's toolbar layers annotation tools onto Obsidian's own
 *     viewer without replacing it (see native-overlay.ts)
 */
import {
  App,
  Modal,
  Plugin,
  TFile,
  WorkspaceLeaf,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { PdfAnnotatorView, VIEW_TYPE_PDF_ANNOTATOR } from "./view";
import { initPdfEngine, disposePdfEngine, LOG_TAG } from "./pdf-engine";
import { NativeOverlayManager } from "./native-overlay";
import {
  DEFAULT_ANNOTATION_FOLDER,
  normalizeAnnotationStorageFolder,
  type AnnotationPathOptions,
  type AnnotationStorageMode,
} from "./annotations";
import { DocumentBinder } from "./document-binding";

interface LpaSettings {
  /** Override Obsidian's core PDF viewer so clicking a PDF opens this view. */
  registerAsDefaultPdfHandler: boolean;
  /** Inject annotation mode into the native PDF view (experimental). */
  enableNativeOverlay: boolean;
  /** Where sidecars live: beside each PDF, or mirrored under one folder. */
  annotationStorageMode: AnnotationStorageMode;
  /** Vault-relative folder used by "folder" mode and for exports. */
  annotationStorageFolder: string;
}

const DEFAULT_SETTINGS: LpaSettings = {
  registerAsDefaultPdfHandler: false,
  enableNativeOverlay: true,
  // A ".annotations" folder in the PDF's own directory: same locality as the
  // PDF (a folder moved in Finder takes both), without a stray Markdown file
  // appearing in the file explorer next to every paper.
  annotationStorageMode: "hidden-beside",
  annotationStorageFolder: DEFAULT_ANNOTATION_FOLDER,
};

function coerceAnnotationStorageMode(value: string): AnnotationStorageMode {
  if (value === "folder") return "folder";
  if (value === "beside-pdf") return "beside-pdf";
  return "hidden-beside";
}

export default class LocalPdfAnnotatorPlugin extends Plugin {
  settings!: LpaSettings;
  nativeOverlays!: NativeOverlayManager;
  binder!: DocumentBinder;
  private replacingCorePdfView = false;
  private nativePdfRefreshRaf: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.binder = new DocumentBinder(this.app);

    // Configure + self-verify our bundled pdf.js worker up front so the console
    // shows the version match before any PDF is opened.
    const status = initPdfEngine();
    if (!status.ok) {
      new Notice("PDF Annotator: pdf.js version self-check failed — see console.");
    }

    this.registerView(
      VIEW_TYPE_PDF_ANNOTATOR,
      (leaf: WorkspaceLeaf) =>
        new PdfAnnotatorView(leaf, () => this.annotationPathOptions(), this.binder)
    );

    this.nativeOverlays = new NativeOverlayManager(
      this,
      () => this.settings.enableNativeOverlay,
      () => this.annotationPathOptions(),
      this.binder
    );

    // Trigger 1: command palette.
    this.addCommand({
      id: "open-current-pdf-in-annotator",
      name: "Open current PDF in annotator",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const isPdf = !!file && file.extension === "pdf";
        if (isPdf && !checking) this.openInAnnotator(file as TFile, "tab");
        return isPdf;
      },
    });

    // Toggle the experimental annotation overlay on the native PDF view.
    this.addCommand({
      id: "toggle-native-annotation-mode",
      name: "Toggle annotation mode on the native PDF view",
      checkCallback: (checking: boolean) => {
        if (!this.settings.enableNativeOverlay) return false;
        const leaf = this.app.workspace.activeLeaf;
        const ready = !!leaf && leaf.view.getViewType() === "pdf";
        if (ready && !checking) void this.nativeOverlays.toggle(leaf!);
        return ready;
      },
    });

    // Migrate highlights from the old obsidian-annotator notes for the open PDF.
    // Works in the custom annotator view AND in native overlay mode.
    this.addCommand({
      id: "import-legacy-annotations",
      name: "Import legacy obsidian-annotator highlights for this PDF",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PdfAnnotatorView);
        if (view && view.file) {
          if (!checking) void view.importLegacyAnnotations();
          return true;
        }
        const overlay = this.nativeOverlays.activeOverlay();
        if (overlay) {
          if (!checking) void overlay.importLegacyAnnotations();
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "export-current-pdf-annotations",
      name: "Export annotations for current PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "pdf") return false;
        if (!checking) {
          void this.binder
            .exportAnnotations(
              file,
              `${this.settings.annotationStorageFolder}/Exports`,
              this.annotationPathOptions()
            )
            .then((path) => new Notice(`PDF Annotator: exported ${path}`))
            .catch((e: any) => {
              console.error(`${LOG_TAG} failed to export PDF annotations`, e);
              new Notice(`PDF Annotator: export failed — ${e?.message ?? e}`);
            });
        }
        return true;
      },
    });

    // Migration off the retired bundle layout. Deliberately two commands: no
    // duplicated PDF is deleted until its annotations are provably out.
    this.addCommand({
      id: "migrate-annotations-out-of-bundles",
      name: "Migrate annotations out of managed bundles",
      callback: () => void this.migrateLegacyBundles(),
    });

    this.addCommand({
      id: "reclaim-annotation-backup-space",
      name: "Reclaim space from annotation backups",
      callback: () => void this.reclaimLegacyBackups(),
    });

    // Trigger 2: ordinary file clicks. Obsidian's core PDF view owns the "pdf"
    // extension, so registerExtensions cannot override it safely. Instead, use
    // the public file-open event and replace the active core PDF leaf.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.scheduleNativePdfRefresh();
        if (file instanceof TFile && file.extension === "pdf") {
          void this.openPdfClickInAnnotator(file);
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.scheduleNativePdfRefresh())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.scheduleNativePdfRefresh())
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || file.extension !== "pdf") return;
        void this.onPdfRenamed(file, oldPath);
      })
    );
    // Deleting a PDF trashes its annotations. This must stay bound to the
    // DELETE EVENT and never to a "file is missing" check: a half-synced vault
    // or a move made in Finder is indistinguishable from a deletion, and this
    // is the only irreversible operation in the plugin.
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile) || file.extension !== "pdf") return;
        void this.binder
          .onPdfDeleted(file.path, this.annotationPathOptions())
          .then((trashed) => {
            if (trashed.length) {
              new Notice(`PDF Annotator: moved annotations for ${file.name} to trash.`);
            }
          })
          .catch((e) => console.error(`${LOG_TAG} failed to trash annotations`, e));
      })
    );
    this.app.workspace.onLayoutReady(() => this.scheduleNativePdfRefresh());

    this.addSettingTab(new LpaSettingTab(this));

    console.log(`${LOG_TAG} loaded.`);
  }

  onunload(): void {
    if (this.nativePdfRefreshRaf !== null) {
      window.cancelAnimationFrame(this.nativePdfRefreshRaf);
      this.nativePdfRefreshRaf = null;
    }
    // Detach native overlays (removes injected DOM, observers, listeners) …
    this.nativeOverlays.disable();
    // … tear down our views (cancels pdf.js tasks, destroys docs) …
    this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR).forEach((leaf) => leaf.detach());
    // … then revoke the worker Blob URL.
    disposePdfEngine();
    console.log(`${LOG_TAG} unloaded.`);
  }

  async openInAnnotator(file: TFile, paneType: "tab" | "split" | false = "tab"): Promise<void> {
    const leaf = this.findExistingLeafForFile(file) ?? this.app.workspace.getLeaf(paneType);
    await this.setLeafToAnnotator(leaf, file);
  }

  private async setLeafToAnnotator(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    await leaf.setViewState({
      type: VIEW_TYPE_PDF_ANNOTATOR,
      state: { file: file.path },
      active: true,
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private findExistingLeafForFile(file: TFile): WorkspaceLeaf | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf && this.leafContainsFile(activeLeaf, file)) {
      return activeLeaf;
    }

    for (const viewType of ["pdf", VIEW_TYPE_PDF_ANNOTATOR]) {
      for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
        if (this.leafContainsFile(leaf, file)) return leaf;
      }
    }

    return null;
  }

  private leafContainsFile(leaf: WorkspaceLeaf, file: TFile): boolean {
    const leafFile = (leaf.view as { file?: unknown }).file;
    return leafFile instanceof TFile && leafFile.path === file.path;
  }

  private async openPdfClickInAnnotator(file: TFile): Promise<void> {
    if (!this.settings.registerAsDefaultPdfHandler || this.replacingCorePdfView) return;
    for (const delayMs of [-1, 0, 16, 64]) {
      if (delayMs < 0) {
        await Promise.resolve();
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }

      const leaf = this.app.workspace.activeLeaf;
      if (!leaf) continue;
      if (leaf.view.getViewType() === VIEW_TYPE_PDF_ANNOTATOR) return;
      if (this.app.workspace.getActiveFile()?.path !== file.path) continue;

      this.replacingCorePdfView = true;
      try {
        await this.setLeafToAnnotator(leaf, file);
      } finally {
        this.replacingCorePdfView = false;
      }
      return;
    }
  }

  /** Debounced sync of the native-PDF-view integration (toolbar controls +
   * overlay lifecycle). The overlay itself never calls setViewState. */
  private scheduleNativePdfRefresh(): void {
    if (this.nativePdfRefreshRaf !== null) return;
    this.nativePdfRefreshRaf = window.requestAnimationFrame(() => {
      this.nativePdfRefreshRaf = null;
      this.nativeOverlays.refresh();
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.annotationStorageMode = coerceAnnotationStorageMode(
      this.settings.annotationStorageMode
    );
    this.settings.annotationStorageFolder = normalizeAnnotationStorageFolder(
      this.settings.annotationStorageFolder
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  annotationPathOptions(): AnnotationPathOptions {
    return {
      storageMode: this.settings.annotationStorageMode,
      storageFolder: this.settings.annotationStorageFolder,
    };
  }

  /** Move the sidecars with the PDF, then re-point any open store at them. */
  private async onPdfRenamed(file: TFile, oldPath: string): Promise<void> {
    let sidecar: { sidecarPath: string; sidecarBackupPath: string } | undefined;
    try {
      sidecar = (await this.binder.onPdfRenamed(file, oldPath, this.annotationPathOptions())) ?? undefined;
    } catch (e: any) {
      // The sidecar stays at the old path and is still discoverable there, so
      // this is recoverable — but the user needs to know it did not follow.
      console.error(`${LOG_TAG} failed to move annotations with the renamed PDF`, e);
      new Notice(`PDF Annotator: annotations did not follow ${file.name} — ${e?.message ?? e}`);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR)) {
      const view = leaf.view;
      if (view instanceof PdfAnnotatorView) view.syncPdfPath(file, sidecar);
    }
    this.nativeOverlays.syncPdfPath(file, sidecar);
    this.scheduleNativePdfRefresh();
  }

  private async migrateLegacyBundles(): Promise<void> {
    try {
      const bundles = (await this.binder.listLegacyBundles()).filter((b) => b.hasAnnotations);
      if (!bundles.length) {
        new Notice("PDF Annotator: no bundled annotations left to migrate.");
        return;
      }
      const skipped: string[] = [];
      let migrated = 0;
      for (const bundle of bundles) {
        const result = await this.binder.migrateLegacyBundle(bundle, this.annotationPathOptions());
        if (result.kind === "migrated") migrated++;
        else skipped.push(result.reason);
      }
      for (const reason of skipped) console.warn(`${LOG_TAG} bundle not migrated: ${reason}`);
      new Notice(
        skipped.length
          ? `PDF Annotator: migrated ${migrated} of ${bundles.length}; ${skipped.length} skipped — see console.`
          : `PDF Annotator: migrated ${migrated} annotation file${migrated === 1 ? "" : "s"}.`
      );
    } catch (e: any) {
      console.error(`${LOG_TAG} bundle migration failed`, e);
      new Notice(`PDF Annotator: migration failed — ${e?.message ?? e}`);
    }
  }

  private async reclaimLegacyBackups(): Promise<void> {
    try {
      const bundles = await this.binder.listLegacyBundles();
      const withBackups = bundles.filter((b) => b.backupBytes > 0);
      if (!withBackups.length) {
        new Notice("PDF Annotator: no duplicated PDF copies to reclaim.");
        return;
      }
      // Refuse while any bundle still holds the only copy of its annotations.
      const unmigrated = bundles.filter((b) => b.hasAnnotations);
      if (unmigrated.length) {
        new Notice(
          `PDF Annotator: ${unmigrated.length} bundle(s) still hold annotations. ` +
            `Run “Migrate annotations out of managed bundles” first.`
        );
        return;
      }
      const total = withBackups.reduce((sum, b) => sum + b.backupBytes, 0);
      const confirmed = await new Promise<boolean>((resolve) => {
        new ConfirmModal(
          this.app,
          "Reclaim space from annotation backups",
          `Delete ${withBackups.length} duplicated PDF cop${withBackups.length === 1 ? "y" : "ies"} ` +
            `(${formatBytes(total)})? Your original PDFs and annotations are not touched.`,
          "Delete copies",
          resolve
        ).open();
      });
      if (!confirmed) return;
      const reclaimed = await this.binder.reclaimLegacyBackups(withBackups);
      new Notice(`PDF Annotator: reclaimed ${formatBytes(reclaimed)}.`);
    } catch (e: any) {
      console.error(`${LOG_TAG} reclaiming backup space failed`, e);
      new Notice(`PDF Annotator: could not reclaim space — ${e?.message ?? e}`);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

class ConfirmModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private titleText: string,
    private bodyText: string,
    private confirmText: string,
    private resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.titleText });
    contentEl.createEl("p", { text: this.bodyText });
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(() => this.finish(true))
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)));
  }

  private finish(confirmed: boolean): void {
    this.decided = true;
    this.resolve(confirmed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve(false);
  }
}

class LpaSettingTab extends PluginSettingTab {
  constructor(private plugin: LocalPdfAnnotatorPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Where annotations are stored")
      .setDesc(
        "Hidden folder keeps sidecars in a “.annotations” folder inside the PDF's own " +
          "directory, so nothing extra shows up in the file explorer. Sidecars written " +
          "under any of these settings are still found and imported automatically, so " +
          "switching is safe."
      )
      .addDropdown((d) =>
        d
          .addOption("hidden-beside", "Hidden folder beside the PDF (.annotations)")
          .addOption("beside-pdf", "Visible, next to the PDF")
          .addOption("folder", "In one annotation folder")
          .setValue(this.plugin.settings.annotationStorageMode)
          .onChange(async (v) => {
            this.plugin.settings.annotationStorageMode = coerceAnnotationStorageMode(v);
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.annotationStorageMode === "hidden-beside") {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Hidden files are not indexed by Obsidian: annotation sidecars will not appear " +
          "in search or the graph, and some sync tools skip dot-folders. If yours does, " +
          "include “.annotations” explicitly, or choose a visible location above.",
      });
    }

    if (this.plugin.settings.annotationStorageMode === "folder") {
      new Setting(containerEl)
        .setName("Annotation folder")
        .setDesc("Sidecars mirror each PDF's vault path under this folder.")
        .addText((t) => {
          t
            .setPlaceholder(DEFAULT_ANNOTATION_FOLDER)
            .setValue(this.plugin.settings.annotationStorageFolder)
            .onChange(async (v) => {
              this.plugin.settings.annotationStorageFolder = normalizeAnnotationStorageFolder(v);
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName("Annotate inside the native PDF view (experimental)")
      .setDesc(
        "Adds an “Annotate” toggle to Obsidian's own PDF toolbar. Annotation tools are layered " +
          "onto the native viewer — its toolbar, sidebar, zoom, and navigation stay untouched. " +
          "Uses the same sidecar files as the annotator view."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableNativeOverlay).onChange(async (v) => {
          this.plugin.settings.enableNativeOverlay = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.nativeOverlays.refresh();
          else this.plugin.nativeOverlays.disable();
        })
      );

    new Setting(containerEl)
      .setName("Make this the default PDF viewer")
      .setDesc(
        "When enabled, ordinary .pdf clicks are redirected into this annotator. " +
          "This uses Obsidian's public file-open event and does not patch internal PDF-viewer state."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.registerAsDefaultPdfHandler).onChange(async (v) => {
          this.plugin.settings.registerAsDefaultPdfHandler = v;
          await this.plugin.saveSettings();
          new Notice(v ? "PDF clicks will open in PDF Annotator." : "PDF clicks will use Obsidian's core PDF viewer.");
        })
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The command “Open current PDF in annotator” remains available as a stable custom-view fallback. " +
        "Deleting a PDF moves its annotations to the trash along with it.",
    });
  }
}

