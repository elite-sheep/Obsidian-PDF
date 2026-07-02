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
import { Plugin, TFile, WorkspaceLeaf, Notice, PluginSettingTab, Setting } from "obsidian";
import { PdfAnnotatorView, VIEW_TYPE_PDF_ANNOTATOR } from "./view";
import { initPdfEngine, disposePdfEngine, LOG_TAG } from "./pdf-engine";
import { NativeOverlayManager } from "./native-overlay";

interface LpaSettings {
  /** Override Obsidian's core PDF viewer so clicking a PDF opens this view. */
  registerAsDefaultPdfHandler: boolean;
  /** Inject annotation mode into the native PDF view (experimental). */
  enableNativeOverlay: boolean;
}

const DEFAULT_SETTINGS: LpaSettings = {
  registerAsDefaultPdfHandler: false,
  enableNativeOverlay: true,
};

export default class LocalPdfAnnotatorPlugin extends Plugin {
  settings!: LpaSettings;
  nativeOverlays!: NativeOverlayManager;
  private replacingCorePdfView = false;
  private nativePdfRefreshRaf: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Configure + self-verify our bundled pdf.js worker up front so the console
    // shows the version match before any PDF is opened.
    const status = initPdfEngine();
    if (!status.ok) {
      new Notice("PDF Annotator: pdf.js version self-check failed — see console.");
    }

    this.registerView(
      VIEW_TYPE_PDF_ANNOTATOR,
      (leaf: WorkspaceLeaf) => new PdfAnnotatorView(leaf)
    );

    this.nativeOverlays = new NativeOverlayManager(this, () => this.settings.enableNativeOverlay);

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
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
        "The command “Open current PDF in annotator” remains available as a stable custom-view fallback.",
    });
  }
}
