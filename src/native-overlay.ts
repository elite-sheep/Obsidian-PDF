/**
 * native-overlay.ts — EXPERIMENTAL annotation mode layered onto Obsidian's
 * NATIVE PDF view (view type "pdf"), instead of replacing it.
 *
 * Approach / isolation guarantees:
 *  - We never call leaf.setViewState, never patch Obsidian internals, and never
 *    touch the native viewer's pdf.js objects. The ONLY native surface we rely
 *    on is stable pdf.js DOM (".page[data-page-number]", ".textLayer",
 *    ".canvasWrapper") plus Obsidian's ".pdf-toolbar" for control injection
 *    (with a ".view-actions" fallback).
 *  - Coordinate mapping is done with OUR bundled pdf.js: the overlay opens the
 *    same file (geometry only, nothing rendered) and converts DOM fractions of
 *    a native page box through a scale-1 viewport → PDF user space. This yields
 *    the exact same sidecar geometry the custom annotator view produces, so
 *    both modes read/write one format.
 *  - Marks are positioned in % of the page box, so native zoom keeps them
 *    aligned even between repaints; a MutationObserver re-attaches our layers
 *    whenever the native viewer re-renders a page.
 *  - Notes are read and edited in place: click a mark for the edit popover, and
 *    browse the whole document from the annotation list (see below). There are
 *    deliberately NO margin note cards here. An earlier version mirrored the
 *    custom view's side rails into a ".lpa-native-margins" overlay, but cards
 *    for every annotation on a visible page meant new panels sliding in on every
 *    scroll, and keeping them readable meant driving the native zoom control on
 *    the user's behalf. The sidebar list covers the same need without either.
 *    Sidecar fields the rails used (`marginSide`, `isPinned`) are still written
 *    and never rewritten, because the custom view still lays out with them.
 *  - Everything injected is namespaced "lpa-native-*" and removed when the
 *    mode is toggled off, the leaf changes file or closes, or the plugin
 *    unloads.
 *
 * Known limitation: pages rotated by the user inside the native viewer can't be
 * mapped reliably (the native view does not expose its rotation publicly), so
 * painting/creating marks is skipped on aspect-mismatched pages instead of
 * placing them wrong.
 */
import { App, Notice, Plugin, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { pdfjsLib, initPdfEngine, createDedicatedWorker, LOG_TAG } from "./pdf-engine";
import { copyForPdfJs } from "./pdf-bytes";
import {
  AnnotationStore,
  DEFAULT_COLOR,
  PALETTE,
  resolvePalette,
  MARK_STYLES,
  MARK_STYLE_LABELS,
  markStyleOf,
  newId,
  allSidecarPathsFor,
  legacySidecarPathFor,
  parseAnnotations,
  sidecarPathFor,
  type AnnotationPathOptions,
  type AnnotationStoreOptions,
  type Highlight,
  type MarkStyle,
  type PdfRect,
} from "./annotations";
import {
  annotationColor,
  annotationKindLabel,
  annotationTypeOf,
  filterForList,
  listPrimaryText,
  FLASH_MS,
  listSecondaryText,
  normalizeSearch,
  shortAnnotationText,
  sortForList,
  tagPreview,
  widthBandFor,
  type ListWidthBand,
} from "./annotation-list";
import { buildDocIndex, anchorQuote } from "./anchor";
import { parseLegacyNote, targetBasename, type LegacyAnnotation } from "./legacy-import";
import { DocumentBinder } from "./document-binding";
import { resolveDocumentChange } from "./document-change";

const MAX_HIGHLIGHT_ALPHA = 0.46;
/** DOM that belongs to us; mutations inside it must not re-trigger syncing. */
const OWN_DOM_SELECTOR =
  ".lpa-native-hl-layer, .lpa-native-note-layer, .lpa-native-reveal-layer, .lpa-native-sidebar-view, .lpa-native-controls";
/** Marks the native sidebar as currently showing our annotation list. */
const SIDEBAR_MARKER_CLASS = "lpa-annotations-view";
/**
 * Obsidian mirrors pdf.js's "sidebarviewchanged" event onto this attribute of
 * .pdf-sidebar-container ("0" ⇔ closed). Watching it is how we notice the user
 * switching to Thumbnails/Outline without touching the private pdf.js sidebar.
 */
const SIDEBAR_VIEW_ATTR = "data-view";
interface PageGeom {
  vp1: any; // pdf.js viewport at scale 1 (the page's own /Rotate applied)
  w: number;
  h: number;
}

interface BaseRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PaintRect extends BaseRect {
  color: string;
  order: number;
  ids: Set<string>;
  notes: Set<string>;
}

interface LineMetrics {
  weight: number;
  dash: number;
  dashGap: number;
  dot: number;
  dotGap: number;
}

interface PageBox {
  idx: number;
  pageEl: HTMLElement;
  box: DOMRect;
}

function nativeViewFile(leaf: WorkspaceLeaf): TFile | null {
  const file = (leaf.view as { file?: unknown }).file;
  return file instanceof TFile && file.extension === "pdf" ? file : null;
}

/**
 * Owns the per-leaf toggle buttons in native PDF toolbars and the lifecycle of
 * the active overlays. `refresh()` is cheap and idempotent; the plugin calls it
 * on layout-change / active-leaf-change / file-open.
 */
export class NativeOverlayManager {
  private overlays = new Map<WorkspaceLeaf, NativePdfOverlay>();
  private retryTimer: number | null = null;
  private retryCount = 0;
  /** leaf → file path whose auto-attach has already been decided. */
  private autoConsidered = new Map<WorkspaceLeaf, string>();

  constructor(
    private plugin: Plugin,
    private enabled: () => boolean,
    private autoEnable: () => boolean,
    private getAnnotationPathOptions: () => AnnotationPathOptions,
    private binder?: DocumentBinder
  ) {}

  private get app(): App {
    return this.plugin.app;
  }

  refresh(): void {
    if (!this.enabled()) {
      this.disable();
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType("pdf");
    const live = new Set(leaves);

    // GC overlays whose leaf closed, changed view type, or changed file.
    for (const [leaf, overlay] of Array.from(this.overlays)) {
      const file = live.has(leaf) ? nativeViewFile(leaf) : null;
      if (!file || file.path !== overlay.file.path) {
        overlay.destroy();
        this.overlays.delete(leaf);
      }
    }

    for (const leaf of Array.from(this.autoConsidered.keys())) {
      if (!live.has(leaf)) this.autoConsidered.delete(leaf);
    }

    let missingBar = false;
    for (const leaf of leaves) {
      const file = nativeViewFile(leaf);
      if (!file) continue;
      if (!this.ensureControls(leaf)) missingBar = true;
      // Decide once per (leaf, file). Recorded BEFORE the async check so the
      // rapid refreshes around file-open cannot queue duplicate attaches.
      if (!this.overlays.has(leaf) && this.autoConsidered.get(leaf) !== file.path) {
        this.autoConsidered.set(leaf, file.path);
        void this.autoAttach(leaf, file);
      }
    }
    // The native toolbar renders asynchronously after file-open; retry briefly.
    this.scheduleRetry(missingBar);
  }

  /**
   * Turn annotation mode on by itself for a PDF that already has annotations,
   * so reopening a paper shows the work you left on it.
   *
   * Gated on a sidecar existing because attaching opens a second pdf.js
   * document for geometry — too costly to do for every PDF opened. That gate is
   * path-based, so it deliberately misses the case where annotations are only
   * findable by content hash (a PDF re-downloaded to a new path); clicking
   * Annotate still recovers those, since prepare() does the full lookup.
   */
  private async autoAttach(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    try {
      if (!this.autoEnable() || !(await this.hasExistingAnnotations(file))) return;
      // The world may have moved during the await.
      if (!this.enabled() || this.overlays.has(leaf)) return;
      const current = nativeViewFile(leaf);
      if (!current || current.path !== file.path) return;
      await this.attach(leaf, current);
    } catch (e) {
      console.error(`${LOG_TAG} auto-enabling annotation mode failed`, e);
    }
  }

  /** Cheap path-only probe: does any storage mode hold marks for this PDF? */
  private async hasExistingAnnotations(file: TFile): Promise<boolean> {
    const { storageFolder } = this.getAnnotationPathOptions();
    for (const path of allSidecarPathsFor(file.path, storageFolder)) {
      try {
        if (!(await this.app.vault.adapter.exists(path))) continue;
        const parsed = parseAnnotations(await this.app.vault.adapter.read(path));
        // An empty sidecar is not a reason to open annotation mode.
        if (parsed?.highlights.length) return true;
      } catch {
        /* An unreadable candidate is simply not a reason to attach. */
      }
    }
    return false;
  }

  /** Tear everything down (setting turned off / plugin unload). */
  disable(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const overlay of this.overlays.values()) overlay.destroy();
    this.overlays.clear();
    this.autoConsidered.clear();
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      leaf.view.containerEl
        .querySelectorAll<HTMLElement>(".lpa-native-controls")
        .forEach((el) => el.remove());
    }
    this.app.workspace.containerEl
      .querySelectorAll<HTMLElement>(".lpa-native-controls")
      .forEach((el) => el.remove());
  }

  overlayFor(leaf: WorkspaceLeaf | null): NativePdfOverlay | null {
    return leaf ? this.overlays.get(leaf) ?? null : null;
  }

  activeOverlay(): NativePdfOverlay | null {
    return this.overlayFor(this.app.workspace.activeLeaf);
  }

  async toggle(leaf: WorkspaceLeaf): Promise<void> {
    const existing = this.overlays.get(leaf);
    if (existing) {
      existing.destroy();
      this.overlays.delete(leaf);
      // Turning annotation mode off is a decision about this file; auto-attach
      // must not immediately undo it on the next refresh.
      const file = nativeViewFile(leaf);
      if (file) this.autoConsidered.set(leaf, file.path);
      this.refresh();
      return;
    }
    const file = nativeViewFile(leaf);
    if (!file) return;
    await this.attach(leaf, file);
  }

  private async attach(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    const overlay = new NativePdfOverlay(
      this.plugin,
      leaf,
      file,
      this.getAnnotationPathOptions,
      this.binder
    );
    this.overlays.set(leaf, overlay);
    this.refresh();
    try {
      await overlay.init();
      // init() self-destructs when the user declines to open annotation mode
      // for a changed PDF; drop it so the toggle does not read as active.
      if (overlay.isDestroyed && this.overlays.get(leaf) === overlay) {
        this.overlays.delete(leaf);
      }
    } catch (e) {
      if (!overlay.isDestroyed) {
        console.error(`${LOG_TAG} native overlay attach failed`, e);
        new Notice("PDF Annotator: could not attach the annotation overlay (see console).");
      }
      overlay.destroy();
      if (this.overlays.get(leaf) === overlay) this.overlays.delete(leaf);
    }
    this.refresh();
  }

  syncPdfPath(file: TFile, sidecar?: { sidecarPath: string; sidecarBackupPath: string }): void {
    for (const overlay of this.overlays.values()) overlay.syncPdfPath(file, sidecar);
  }

  /** Inject/sync the control group in one native PDF leaf. False if no bar yet. */
  private ensureControls(leaf: WorkspaceLeaf): boolean {
    const container = leaf.view.containerEl;
    const bar =
      container.querySelector<HTMLElement>(".pdf-toolbar-right") ??
      container.querySelector<HTMLElement>(".pdf-toolbar") ??
      container.querySelector<HTMLElement>(".view-header .view-actions, .view-actions");
    if (!bar) return false;

    let group =
      Array.from(container.querySelectorAll<HTMLElement>(".lpa-native-controls")).find(
        (el) => el.parentElement === bar
      ) ?? null;
    // Sweep strays left behind if the native toolbar was rebuilt around us.
    container.querySelectorAll<HTMLElement>(".lpa-native-controls").forEach((el) => {
      if (el !== group) el.remove();
    });

    if (!group) {
      group = bar.ownerDocument.createElement("div");
      group.className = "lpa-native-controls";
      if (bar.hasClass("view-actions")) bar.insertBefore(group, bar.firstChild);
      else bar.appendChild(group);

      const toggle = group.createEl("button", {
        cls: "lpa-native-toggle clickable-icon",
        attr: { type: "button" },
      });
      setIcon(toggle, "highlighter");
      toggle.createSpan({ cls: "lpa-native-toggle-label", text: "Annotate" });
      toggle.onclick = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.toggle(leaf);
      };
    }

    const overlay = this.overlays.get(leaf) ?? null;
    const toggle = group.querySelector<HTMLElement>(".lpa-native-toggle");
    if (toggle) {
      const on = !!overlay;
      toggle.toggleClass("is-active", on);
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
      const label = on
        ? "Annotation mode is on. Click to turn it off."
        : "Annotate this PDF in place (keeps the native viewer)";
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("title", label);
    }
    overlay?.ensureToolbarButtons(group);
    return true;
  }

  private scheduleRetry(needed: boolean): void {
    if (!needed) {
      this.retryCount = 0;
      return;
    }
    if (this.retryTimer !== null || this.retryCount >= 5) return;
    this.retryCount++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.refresh();
    }, 350);
  }
}

/**
 * One active annotation overlay bound to (leaf, file). Reads/writes the same
 * managed document bundle as the custom annotator view.
 */
export class NativePdfOverlay {
  private destroyed = false;
  private store: AnnotationStore | null = null;
  private pdfDoc: any | null = null;
  private pdfWorker: any | null = null;
  private geoms = new Map<number, PageGeom>();
  private geomPromises = new Map<number, Promise<PageGeom | null>>();
  private contentRoot: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private syncQueued = false;
  private cleanups: Array<() => void> = [];

  private currentColor = DEFAULT_COLOR;
  private currentStyle: MarkStyle = "highlight";
  private tagMode = false;
  private warnedRotated = false;

  private pendingSelection: { text: string; byPage: Map<number, PdfRect[]> } | null = null;
  private selectionPopoverEl: HTMLElement | null = null;
  private editPopoverCleanup: (() => void) | null = null;

  private tagBtn: HTMLButtonElement | null = null;
  private listBtn: HTMLButtonElement | null = null;
  private countEl: HTMLElement | null = null;
  private listSearchQuery = "";

  // Annotation list hosted in Obsidian's native PDF sidebar.
  private sidebarPanel: AnnotationListPanel | null = null;
  private sidebarViewEl: HTMLElement | null = null;
  private sidebarListActive = false;
  /** Non-zero while we are the ones changing the native sidebar view. */
  private suppressSidebarViewWatch = 0;

  // Hover/active emphasis on the marks painted over the native pages.
  private pointerRaf: number | null = null;
  private lastPointer: { x: number; y: number; pageEl: HTMLElement | null } | null = null;
  private hoverId: string | null = null;
  private activeId: string | null = null;
  private hoverClearTimer: number | null = null;
  private revealCueTimer: number | null = null;

  constructor(
    private plugin: Plugin,
    private leaf: WorkspaceLeaf,
    readonly file: TFile,
    private getAnnotationPathOptions: () => AnnotationPathOptions,
    private binder?: DocumentBinder
  ) {}

  private get app(): App {
    return this.plugin.app;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  async init(): Promise<void> {
    initPdfEngine();
    const container = this.leaf.view.containerEl;
    this.contentRoot = container.querySelector<HTMLElement>(".view-content") ?? container;

    // Geometry-only document via OUR bundled pdf.js (no rendering, no globals).
    const data = await this.app.vault.readBinary(this.file);
    if (this.destroyed) return;
    this.pdfWorker = createDedicatedWorker();
    // pdf.js transfers the buffer it is given to its worker; `data` must stay
    // intact for the managed bundle below (see pdf-bytes.ts).
    const params: any = { data: copyForPdfJs(data), useSystemFonts: true };
    if (this.pdfWorker) params.worker = this.pdfWorker;
    this.pdfDoc = await pdfjsLib.getDocument(params).promise;
    if (this.destroyed) {
      this.releasePdf();
      return;
    }

    const fingerprint = Array.isArray(this.pdfDoc.fingerprints)
      ? this.pdfDoc.fingerprints[0]
      : this.pdfDoc.fingerprint;
    const pathOptions = this.getAnnotationPathOptions();
    let storeOptions: AnnotationStoreOptions = {
      adapter: this.app.vault.adapter,
      sidecarPath: sidecarPathFor(this.file.path, pathOptions),
      pdfBasename: this.file.basename,
      pdfVaultPath: this.file.path,
      fingerprint,
      loadFallbackPaths: [legacySidecarPathFor(this.file.path)],
    };
    if (this.binder) {
      const binding = await this.binder.prepare(this.file, data, {
        fingerprint,
        pageCount: this.pdfDoc.numPages,
        pathOptions,
      });
      // The PDF may no longer be the one these annotations describe; only the
      // user can settle that (see document-change.ts).
      if (!(await resolveDocumentChange(this.app, this.file, binding))) {
        this.destroy();
        return;
      }
      if (this.destroyed) return;
      storeOptions = {
        ...storeOptions,
        sidecarPath: binding.sidecarPath,
        loadFallbackPaths: binding.fallbackPaths,
        migrateFallbackOnLoad: true,
        sidecarBackupPath: binding.sidecarBackupPath,
        document: binding.document,
      };
    }
    this.store = new AnnotationStore(storeOptions);
    await this.store.load();
    if (this.destroyed) return;
    this.notifyStoreChanged();

    const doc = this.contentRoot.ownerDocument;
    this.listen(this.contentRoot, "mouseup", (evt) => this.onMouseUp(evt as MouseEvent));
    this.listen(this.contentRoot, "click", (evt) => this.onClick(evt as MouseEvent));
    this.listen(
      this.contentRoot,
      "mousemove",
      (evt) => this.onPointerMove(evt as MouseEvent),
      { passive: true }
    );
    this.listen(doc, "selectionchange", () => this.onSelectionChange());
    this.listen(doc, "keydown", (evt) => this.onKeyDown(evt as KeyboardEvent));

    this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
    this.observer.observe(this.contentRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-loaded", SIDEBAR_VIEW_ATTR],
    });

    this.scheduleSync();
    console.log(`${LOG_TAG} native annotation overlay attached: ${this.file.path}`);
  }

  /** Follow a vault rename. `sidecar` is set once the files have been moved. */
  syncPdfPath(file: TFile, sidecar?: { sidecarPath: string; sidecarBackupPath: string }): void {
    if (this.file !== file && this.file.path !== file.path) return;
    if (sidecar) this.store?.setSidecarPaths(sidecar.sidecarPath, sidecar.sidecarBackupPath);
    this.store?.setPdfPath(file.path, file.basename);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.closeEditPopover();
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    this.teardownSidebarList();
    this.contentRoot?.removeClass("lpa-native-tag-mode");

    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }

    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.pointerRaf !== null) {
      win.cancelAnimationFrame(this.pointerRaf);
      this.pointerRaf = null;
    }
    this.lastPointer = null;
    this.clearRevealCue(win);
    if (this.hoverClearTimer !== null) {
      win.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }

    this.contentRoot
      ?.querySelectorAll<HTMLElement>(
        ".lpa-native-hl-layer, .lpa-native-note-layer, .lpa-native-reveal-layer"
      )
      .forEach((el) => el.remove());
    this.removeToolbarButtons();

    const store = this.store;
    this.store = null;
    if (store) {
      void store.flush().catch((e) => console.error(`${LOG_TAG} failed to save annotations`, e));
    }
    this.releasePdf();
    this.geoms.clear();
    this.geomPromises.clear();
    this.contentRoot = null;
  }

  private releasePdf(): void {
    try {
      this.pdfDoc?.destroy();
    } catch {}
    try {
      this.pdfWorker?.destroy();
    } catch {}
    this.pdfDoc = null;
    this.pdfWorker = null;
  }

  private listen(
    target: EventTarget,
    type: string,
    handler: (evt: Event) => void,
    options?: AddEventListenerOptions
  ): void {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  // ---- toolbar controls (inside the manager-owned group) -------------------

  ensureToolbarButtons(group: HTMLElement): void {
    if (this.destroyed) return;
    if (this.tagBtn && this.tagBtn.isConnected && this.tagBtn.parentElement === group) {
      this.syncToolbarState();
      return;
    }
    this.removeToolbarButtons();

    this.tagBtn = group.createEl("button", {
      cls: "lpa-native-btn clickable-icon",
      attr: { type: "button", "aria-label": "Place a page note tag", title: "Place a page note tag" },
    });
    setIcon(this.tagBtn, "sticky-note");
    this.tagBtn.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.setTagMode(!this.tagMode);
    };

    this.listBtn = group.createEl("button", {
      cls: "lpa-native-btn clickable-icon",
      attr: { type: "button", "aria-label": "Show annotations", title: "Show annotations" },
    });
    setIcon(this.listBtn, "list");
    this.listBtn.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.toggleList();
    };

    this.countEl = group.createSpan({ cls: "lpa-native-count", text: "0" });
    this.syncToolbarState();
    this.updateCount();
  }

  private removeToolbarButtons(): void {
    this.tagBtn?.remove();
    this.tagBtn = null;
    this.listBtn?.remove();
    this.listBtn = null;
    this.countEl?.remove();
    this.countEl = null;
  }

  private syncToolbarState(): void {
    this.tagBtn?.toggleClass("is-active", this.tagMode);
    this.tagBtn?.setAttribute("aria-pressed", this.tagMode ? "true" : "false");
    const listOpen = this.isListOpen();
    this.listBtn?.toggleClass("is-active", listOpen);
    this.listBtn?.setAttribute("aria-pressed", listOpen ? "true" : "false");
  }

  private setTagMode(on: boolean): void {
    this.tagMode = on;
    this.contentRoot?.toggleClass("lpa-native-tag-mode", on);
    this.syncToolbarState();
  }

  private updateCount(): void {
    const n = this.store?.doc.highlights.length ?? 0;
    this.countEl?.setText(String(n));
    this.countEl?.setAttribute("title", `${n} ${n === 1 ? "annotation" : "annotations"}`);
  }

  private notifyStoreChanged(): void {
    this.updateCount();
    this.renderListItems();
  }

  // ---- page sync / painting -------------------------------------------------

  private onMutations(mutations: MutationRecord[]): void {
    let sync = false;
    for (const m of mutations) {
      const target = m.target instanceof HTMLElement ? m.target : m.target.parentElement;
      // Obsidian mirrors pdf.js's "sidebarviewchanged" onto this attribute of
      // .pdf-sidebar-container; it is our only public signal that the user
      // switched or closed the sidebar. Scoped to that element because
      // "data-view" is a generic enough name to appear elsewhere.
      if (m.attributeName === SIDEBAR_VIEW_ATTR && target?.hasClass("pdf-sidebar-container")) {
        this.onNativeSidebarViewChanged();
        // Opening or closing the sidebar shifts every page box sideways.
        sync = true;
        continue;
      }
      if (target?.closest(OWN_DOM_SELECTOR)) continue;
      sync = true;
    }
    if (sync) this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.destroyed || this.syncQueued) return;
    this.syncQueued = true;
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => {
      this.syncQueued = false;
      this.syncPages();
    });
  }

  private syncPages(): void {
    if (this.destroyed || !this.contentRoot || !this.store) return;
    const store = this.store;
    const pageEls = this.contentRoot.querySelectorAll<HTMLElement>(".page[data-page-number]");
    for (const pageEl of Array.from(pageEls)) {
      const num = Number(pageEl.getAttribute("data-page-number"));
      if (!Number.isFinite(num) || num < 1) continue;
      const idx = num - 1;
      // Skip untouched placeholder pages so a 500-page PDF doesn't load
      // geometry for every page up front; selection capture loads on demand.
      const active =
        pageEl.hasAttribute("data-loaded") ||
        !!pageEl.querySelector(":scope > .textLayer, :scope > .canvasWrapper, :scope > .lpa-native-hl-layer");
      if (!active && store.byPage(idx).length === 0) continue;
      void this.syncPage(idx, pageEl);
    }
    // A window migration rebuilds the whole viewer DOM, taking our sidebar view
    // with it; put it back rather than silently losing the list.
    if (this.sidebarListActive) this.reensureSidebarList();
  }

  private async syncPage(idx: number, pageEl: HTMLElement): Promise<void> {
    const geom = await this.ensureGeom(idx);
    if (!geom || this.destroyed || !pageEl.isConnected) return;

    const textLayer = pageEl.querySelector<HTMLElement>(":scope > .textLayer");
    let layer = pageEl.querySelector<HTMLElement>(":scope > .lpa-native-hl-layer");
    if (!layer) {
      layer = pageEl.ownerDocument.createElement("div");
      layer.className = "lpa-highlight-layer lpa-native-hl-layer";
      // Below the text layer in paint order so native selection stays crisp.
      if (textLayer) pageEl.insertBefore(layer, textLayer);
      else pageEl.appendChild(layer);
    } else if (textLayer && layer.compareDocumentPosition(textLayer) & Node.DOCUMENT_POSITION_PRECEDING) {
      // A native re-render put the text layer before our fills; restore order.
      pageEl.insertBefore(layer, textLayer);
    }
    let noteLayer = pageEl.querySelector<HTMLElement>(":scope > .lpa-native-note-layer");
    if (!noteLayer) {
      noteLayer = pageEl.ownerDocument.createElement("div");
      noteLayer.className = "lpa-note-layer lpa-native-note-layer";
      pageEl.appendChild(noteLayer);
    }
    this.paintPage(idx, pageEl, layer, noteLayer, geom);
  }

  private ensureGeom(idx: number): Promise<PageGeom | null> {
    const cached = this.geoms.get(idx);
    if (cached) return Promise.resolve(cached);
    let promise = this.geomPromises.get(idx);
    if (!promise) {
      promise = (async () => {
        try {
          if (!this.pdfDoc) return null;
          const page = await this.pdfDoc.getPage(idx + 1);
          const vp1 = page.getViewport({ scale: 1 });
          const geom: PageGeom = { vp1, w: vp1.width, h: vp1.height };
          if (!this.destroyed) this.geoms.set(idx, geom);
          return geom;
        } catch (e) {
          console.error(`${LOG_TAG} native overlay: failed to load geometry for page ${idx + 1}`, e);
          return null;
        }
      })();
      this.geomPromises.set(idx, promise);
    }
    return promise;
  }

  private paintPage(
    idx: number,
    pageEl: HTMLElement,
    layer: HTMLElement,
    noteLayer: HTMLElement,
    geom: PageGeom
  ): void {
    layer.empty();
    noteLayer.empty();
    const store = this.store;
    if (!store) return;

    // A page shown at a different rotation than our geometry would misplace
    // every mark — skip painting rather than paint wrong.
    const box = pageContentBox(pageEl);
    if (box && !aspectMatches(box, geom)) {
      this.warnRotatedOnce();
      return;
    }
    const pxScale = box && geom.w > 0 ? box.width / geom.w : 1;

    const marks = store.byPage(idx).filter((h) => annotationTypeOf(h) === "highlight");

    // Fill highlights: coalesce + occlude (same policy as the custom view) so
    // overlapping fills never compound into a dark patch.
    const fillRects: PaintRect[] = [];
    let order = 0;
    for (const h of marks) {
      if (markStyleOf(h) !== "highlight") continue;
      order++;
      for (const r of rectsToBase(geom, h.rects)) {
        if (r.right - r.left < 0.25 || r.bottom - r.top < 0.25) continue;
        fillRects.push({
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          color: h.color,
          order,
          ids: new Set([h.id]),
          notes: h.note ? new Set([h.note]) : new Set<string>(),
        });
      }
    }
    for (const r of occludePaintRects(coalescePaintRects(fillRects))) {
      const div = layer.createDiv({ cls: "lpa-highlight lpa-mark--highlight" });
      applyPctBox(div, r, geom);
      div.style.setProperty("--lpa-hl-color", highlightPaintColor(r.color));
      const ids = Array.from(r.ids);
      div.dataset.hlIds = ids.join(" ");
      if (ids.length === 1) div.dataset.hlId = ids[0];
      if (r.notes.size === 1) div.setAttribute("aria-label", Array.from(r.notes)[0]);
      div.toggleClass("is-active", !!this.activeId && ids.includes(this.activeId));
      div.toggleClass("is-hover", !!this.hoverId && ids.includes(this.hoverId));
    }

    // Decorative styles: one continuous stroke per visual line.
    const metrics = lineMetricsFor(pxScale);
    for (const h of marks) {
      const st = markStyleOf(h);
      if (st === "highlight") continue;
      for (const lr of mergeLineRects(rectsToBase(geom, h.rects))) {
        this.paintDecorativeLine(layer, h, st, lr, metrics, geom);
      }
    }

    for (const tag of store.byPage(idx).filter((h) => annotationTypeOf(h) === "tag")) {
      this.paintTag(noteLayer, tag);
    }
  }

  private paintDecorativeLine(
    layer: HTMLElement,
    h: Highlight,
    st: MarkStyle,
    lr: BaseRect,
    m: LineMetrics,
    geom: PageGeom
  ): void {
    const el = layer.createDiv({ cls: `lpa-highlight lpa-mark lpa-mark--${st}` });
    applyPctBox(el, lr, geom);
    const pal = resolvePalette(h.color);
    const ink = pal?.ink ?? markInkColor(h.color);
    el.style.setProperty("--lpa-ink", ink);
    el.style.setProperty("--lpa-w", `${m.weight}px`);
    if (st === "dashed") {
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${ink} 0 ${m.dash}px, transparent ${m.dash}px ${m.dash + m.dashGap}px)`
      );
    } else if (st === "dotted") {
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${ink} 0 ${m.dot}px, transparent ${m.dot}px ${m.dot + m.dotGap}px)`
      );
    } else if (st === "comment") {
      const faint = withAlpha(ink, 0.5);
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${faint} 0 ${m.dot}px, transparent ${m.dot}px ${m.dot + m.dotGap}px)`
      );
    } else {
      el.style.setProperty("--lpa-deco", ink);
    }
    el.dataset.hlIds = h.id;
    el.dataset.hlId = h.id;
    if (h.note) el.setAttribute("aria-label", h.note);
    el.toggleClass("is-active", h.id === this.activeId);
    el.toggleClass("is-hover", h.id === this.hoverId);
  }

  private paintTag(noteLayer: HTMLElement, tag: Highlight): void {
    if (!Number.isFinite(tag.tagX) || !Number.isFinite(tag.tagY)) return;
    const x = clamp(0, tag.tagX ?? 0, 100);
    const y = clamp(0, tag.tagY ?? 0, 100);
    const el = noteLayer.createDiv({ cls: "lpa-page-tag" });
    el.dataset.hlId = tag.id;
    el.dataset.annotationId = tag.id;
    el.setCssProps({ left: `${x}%`, top: `${y}%` });
    el.style.setProperty(
      "--lpa-accent",
      resolvePalette(annotationColor(tag))?.ink ?? markInkColor(annotationColor(tag))
    );
    el.toggleClass("is-pinned", !!tag.isPinned);
    el.toggleClass("is-active", tag.id === this.activeId);
    el.toggleClass("is-hover", tag.id === this.hoverId);
    el.createSpan({ cls: "lpa-tag-dot", attr: { "aria-hidden": "true" } });
    el.createSpan({ cls: "lpa-tag-preview", text: tagPreview(tag) });
    this.bindMarkHover(el, tag.id);
    el.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.openEditPopover(tag.id, evt.clientX, evt.clientY, { focusNote: true });
    });
  }

  /** Tags accept pointer events directly; highlight fills are
   * pointer-events:none (so text selection stays native) and get their hover
   * from the mousemove hit test instead. */
  private bindMarkHover(el: HTMLElement, id: string | undefined): void {
    if (!id) return;
    el.addEventListener("mouseenter", () => this.setHoveredAnnotation(id));
    el.addEventListener("mouseleave", () => this.clearHoveredAnnotationSoon(id));
  }

  private repaintPage(idx: number): void {
    const root = this.contentRoot;
    if (!root) return;
    const pageEl = root.querySelector<HTMLElement>(`.page[data-page-number="${idx + 1}"]`);
    if (pageEl) void this.syncPage(idx, pageEl);
  }

  private warnRotatedOnce(): void {
    if (this.warnedRotated) return;
    this.warnedRotated = true;
    new Notice(
      "PDF Annotator: this page is rotated in the native viewer — annotations are hidden there to avoid misplacement."
    );
  }

  // ---- geometry: DOM ↔ PDF user space ---------------------------------------

  private collectPageBoxes(): PageBox[] {
    const root = this.contentRoot;
    if (!root) return [];
    const out: PageBox[] = [];
    for (const pageEl of Array.from(root.querySelectorAll<HTMLElement>(".page[data-page-number]"))) {
      const num = Number(pageEl.getAttribute("data-page-number"));
      if (!Number.isFinite(num) || num < 1) continue;
      const box = pageContentBox(pageEl);
      if (!box) continue;
      out.push({ idx: num - 1, pageEl, box });
    }
    return out;
  }

  private pageBoxAtPoint(x: number, y: number): PageBox | null {
    return (
      this.collectPageBoxes().find(
        (b) => x >= b.box.left && x <= b.box.right && y >= b.box.top && y <= b.box.bottom
      ) ?? null
    );
  }

  private annotationAtPoint(x: number, y: number): Highlight | null {
    const store = this.store;
    if (!store) return null;
    const hit = this.pageBoxAtPoint(x, y);
    if (!hit) return null;
    const geom = this.geoms.get(hit.idx);
    if (!geom || !aspectMatches(hit.box, geom)) return null;
    const [px, py] = clientToPdfPoint(x, y, hit.box, geom);
    const matches = store.byPage(hit.idx).filter(
      (h) =>
        annotationTypeOf(h) === "highlight" &&
        h.rects.some(
          (r) =>
            px >= Math.min(r.x1, r.x2) &&
            px <= Math.max(r.x1, r.x2) &&
            py >= Math.min(r.y1, r.y2) &&
            py <= Math.max(r.y1, r.y2)
        )
    );
    return matches[matches.length - 1] ?? null;
  }

  // ---- selection → highlight -------------------------------------------------

  private onMouseUp(evt: MouseEvent): void {
    if (this.destroyed || !this.store || this.tagMode) return;
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".lpa-selection-popover, .lpa-mark-popover, .lpa-native-controls, .lpa-native-sidebar-view")) return;
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      void this.captureSelection(sel, evt.clientX, evt.clientY);
    }
  }

  private async captureSelection(sel: Selection, anchorX: number, anchorY: number): Promise<void> {
    const text = sel.toString().trim();
    if (!text) return;
    const boxes = this.collectPageBoxes();
    if (!boxes.length) return;

    const rawByPage = new Map<number, { box: DOMRect; rects: DOMRect[] }>();
    for (let ri = 0; ri < sel.rangeCount; ri++) {
      const range = sel.getRangeAt(ri);
      for (const cr of Array.from(range.getClientRects())) {
        if (cr.width < 1 || cr.height < 1) continue;
        const cx = cr.left + cr.width / 2;
        const cy = cr.top + cr.height / 2;
        const hit = boxes.find(
          (b) => cx >= b.box.left && cx <= b.box.right && cy >= b.box.top && cy <= b.box.bottom
        );
        if (!hit) continue;
        const entry = rawByPage.get(hit.idx) ?? { box: hit.box, rects: [] };
        entry.rects.push(cr);
        rawByPage.set(hit.idx, entry);
      }
    }
    if (rawByPage.size === 0) return;

    const byPage = new Map<number, PdfRect[]>();
    let rotated = false;
    for (const [idx, entry] of rawByPage) {
      const geom = await this.ensureGeom(idx);
      if (this.destroyed) return;
      if (!geom) continue;
      if (!aspectMatches(entry.box, geom)) {
        rotated = true;
        continue;
      }
      const rects: PdfRect[] = [];
      for (const cr of entry.rects) {
        const p1 = clientToPdfPoint(cr.left, cr.top, entry.box, geom);
        const p2 = clientToPdfPoint(cr.right, cr.bottom, entry.box, geom);
        rects.push({ x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] });
      }
      if (rects.length) byPage.set(idx, rects);
    }
    if (rotated) this.warnRotatedOnce();
    if (byPage.size === 0) return;

    this.pendingSelection = { text, byPage };
    this.showSelectionPopover(anchorX, anchorY);
  }

  private showSelectionPopover(x: number, y: number): void {
    this.selectionPopoverEl?.remove();
    const root = this.contentRoot;
    if (!root) return;
    const doc = root.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-selection-popover is-right lpa-native-selection-popover" });
    this.selectionPopoverEl = pop;
    pop.style.setProperty(
      "--lpa-accent",
      resolvePalette(this.currentColor)?.ink ?? markInkColor(this.currentColor)
    );
    pop.onmousedown = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    };

    const swatches = pop.createDiv({ cls: "lpa-selection-swatches", attr: { "aria-label": "Highlight color" } });
    for (const p of PALETTE) {
      const sw = swatches.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name, title: p.name } });
      sw.setCssProps({ background: p.fill });
      sw.dataset.color = p.fill;
      sw.toggleClass("is-active", p.fill === this.currentColor);
      sw.onclick = (evt) => {
        evt.preventDefault();
        this.currentColor = p.fill;
        pop.style.setProperty("--lpa-accent", p.ink);
        for (const candidate of Array.from(swatches.querySelectorAll<HTMLElement>(".lpa-swatch"))) {
          candidate.toggleClass("is-active", candidate.dataset.color === p.fill);
        }
      };
    }

    const highlightBtn = pop.createEl("button", { cls: "lpa-selection-action", text: "Highlight" });
    highlightBtn.onclick = (evt) => {
      evt.preventDefault();
      this.commitSelection("highlight", x, y);
    };
    const annotateBtn = pop.createEl("button", {
      cls: "lpa-selection-action lpa-selection-action-primary",
      text: "Annotate",
    });
    annotateBtn.onclick = (evt) => {
      evt.preventDefault();
      this.commitSelection("annotate", x, y);
    };
    const copyBtn = pop.createEl("button", { cls: "lpa-selection-action lpa-selection-action-quiet", text: "Copy" });
    copyBtn.onclick = async (evt) => {
      evt.preventDefault();
      await navigator.clipboard.writeText(this.pendingSelection?.text ?? "");
      new Notice("Copied selected text");
    };

    pop.setCssProps({ visibility: "hidden" });
    const pr = pop.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const px = clamp(8, x + 8, Math.max(8, vw - pr.width - 8));
    const py = clamp(8, y + 14, Math.max(8, vh - pr.height - 8));
    pop.setCssProps({ left: `${px}px`, top: `${py}px`, visibility: "visible" });
  }

  private hideSelectionPopover(clearNativeSelection: boolean): void {
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    if (clearNativeSelection) {
      this.contentRoot?.ownerDocument.getSelection()?.removeAllRanges();
    }
  }

  private onSelectionChange(): void {
    if (!this.selectionPopoverEl) return;
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      this.hideSelectionPopover(false);
    }
  }

  private commitSelection(mode: "highlight" | "annotate", anchorX: number, anchorY: number): void {
    const pending = this.pendingSelection;
    const store = this.store;
    if (!pending || !store) return;
    const created: Highlight[] = [];
    for (const [pageIndex, rects] of pending.byPage) {
      const h: Highlight = {
        id: newId(),
        type: "highlight",
        page: pageIndex,
        color: this.currentColor,
        style: this.currentStyle,
        text: pending.text,
        rects,
        created: new Date().toISOString(),
        source: "manual",
        marginSide: "auto",
        isPinned: false,
      };
      if (mode === "annotate") h.note = "";
      store.add(h);
      created.push(h);
    }
    this.hideSelectionPopover(true);
    for (const h of created) this.repaintPage(h.page);
    this.notifyStoreChanged();
    if (mode === "annotate" && created[0]) {
      this.openEditPopover(created[0].id, anchorX, anchorY, { focusNote: true });
    }
  }

  // ---- clicks: tags + mark editing --------------------------------------------

  private onClick(evt: MouseEvent): void {
    if (this.destroyed || !this.store) return;
    const target = evt.target as HTMLElement | null;
    if (
      target?.closest(
        ".pdf-toolbar, .pdf-sidebar-container, .lpa-page-tag, .lpa-native-controls, .lpa-native-sidebar-view, .lpa-mark-popover, .lpa-selection-popover"
      )
    ) {
      return;
    }
    if (this.tagMode) {
      const created = this.createTagAt(evt.clientX, evt.clientY);
      if (created) {
        evt.preventDefault();
        evt.stopPropagation();
        this.setTagMode(false);
        this.openEditPopover(created.id, evt.clientX, evt.clientY, { focusNote: true });
      }
      return;
    }
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed) return;
    // Never hijack native PDF link/annotation clicks.
    if (target?.closest("a, .annotationLayer")) return;
    const hit = this.annotationAtPoint(evt.clientX, evt.clientY);
    if (hit) {
      evt.preventDefault();
      this.openEditPopover(hit.id, evt.clientX, evt.clientY, {});
    } else {
      this.setActiveAnnotation(null);
    }
  }

  private createTagAt(clientX: number, clientY: number): Highlight | null {
    const store = this.store;
    if (!store) return null;
    const hit = this.pageBoxAtPoint(clientX, clientY);
    if (!hit) return null;
    const xPct = clamp(0, ((clientX - hit.box.left) / Math.max(1, hit.box.width)) * 100, 100);
    const yPct = clamp(0, ((clientY - hit.box.top) / Math.max(1, hit.box.height)) * 100, 100);
    const tag: Highlight = {
      id: newId(),
      type: "tag",
      page: hit.idx,
      color: this.currentColor,
      tagColor: this.currentColor,
      tagX: xPct,
      tagY: yPct,
      text: "",
      note: "",
      rects: [],
      created: new Date().toISOString(),
      source: "manual",
      marginSide: "auto",
      isPinned: false,
    };
    store.add(tag);
    this.repaintPage(hit.idx);
    this.notifyStoreChanged();
    return tag;
  }

  private onKeyDown(evt: KeyboardEvent): void {
    if (evt.key !== "Escape") return;
    if (this.tagMode) {
      this.setTagMode(false);
      return;
    }
    if (this.selectionPopoverEl) this.hideSelectionPopover(false);
  }

  /** Style + color + note editor for an existing mark or tag. */
  private openEditPopover(
    id: string,
    x: number,
    y: number,
    options: { focusNote?: boolean }
  ): void {
    const store = this.store;
    const initial = store?.get(id);
    if (!store || !initial) return;
    this.closeEditPopover();
    this.setActiveAnnotation(id);
    const root = this.contentRoot;
    if (!root) return;
    const doc = root.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-mark-popover lpa-native-edit-popover" });
    const type = annotationTypeOf(initial);

    const repaint = () => {
      const cur = store.get(id);
      this.repaintPage((cur ?? initial).page);
      this.notifyStoreChanged();
    };

    let styleRow: HTMLElement | null = null;
    if (type === "highlight") {
      styleRow = pop.createDiv({ cls: "lpa-styles", attr: { role: "radiogroup", "aria-label": "Mark style" } });
      const syncStyleChecks = () => {
        const cur = markStyleOf(store.get(id));
        for (const b of Array.from(styleRow!.children) as HTMLElement[]) {
          b.toggleClass("is-active", b.dataset.style === cur);
        }
      };
      for (const st of MARK_STYLES) {
        const btn = styleRow.createEl("button", {
          cls: "lpa-style-btn",
          attr: { "aria-label": MARK_STYLE_LABELS[st], title: MARK_STYLE_LABELS[st] },
        });
        btn.dataset.style = st;
        const pal = resolvePalette(store.get(id)?.color ?? initial.color);
        btn.createSpan({ cls: `lpa-style-sample lpa-style-sample--${st}`, text: "A", attr: { "aria-hidden": "true" } });
        btn.style.setProperty("--lpa-ink", pal?.ink ?? initial.color);
        btn.style.setProperty("--lpa-fill", pal?.fill ?? initial.color);
        btn.onclick = () => {
          store.update(id, { style: st });
          repaint();
          syncStyleChecks();
        };
      }
      syncStyleChecks();
    }

    const colorRow = pop.createDiv({ cls: "lpa-swatches" });
    const syncColorChecks = () => {
      const cur = store.get(id);
      const active = cur ? annotationColor(cur) : null;
      for (const sw of Array.from(colorRow.children) as HTMLElement[]) {
        sw.toggleClass("is-active", sw.dataset.color === active);
      }
    };
    for (const p of PALETTE) {
      const sw = colorRow.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name } });
      sw.setCssProps({ background: p.fill });
      sw.dataset.color = p.fill;
      sw.onclick = () => {
        const patch: Partial<Highlight> =
          type === "tag" ? { color: p.fill, tagColor: p.fill } : { color: p.fill };
        store.update(id, patch);
        repaint();
        if (styleRow) {
          for (const b of Array.from(styleRow.children) as HTMLElement[]) {
            b.style.setProperty("--lpa-ink", p.ink);
            b.style.setProperty("--lpa-fill", p.fill);
          }
        }
        syncColorChecks();
      };
    }
    syncColorChecks();

    if (type === "highlight" && initial.text) {
      pop.createDiv({ cls: "lpa-native-popover-source", text: shortAnnotationText(initial.text, 160) });
    }

    const note = pop.createEl("textarea", {
      cls: "lpa-native-note",
      attr: {
        placeholder: type === "tag" ? "Page note" : "Note",
        rows: "3",
        "aria-label": type === "tag" ? "Page note" : "Annotation note",
      },
    });
    note.value = initial.note ?? "";
    note.oninput = () => {
      store.update(id, { note: note.value });
      repaint();
    };

    const sideNote = pop.createEl("textarea", {
      cls: "lpa-native-note lpa-native-side-note",
      attr: { placeholder: "Side note", rows: "2", "aria-label": "Side note" },
    });
    sideNote.value = initial.noteContentCJK ?? "";
    sideNote.oninput = () => {
      store.update(id, { noteContentCJK: sideNote.value.trim() ? sideNote.value : undefined });
      this.notifyStoreChanged();
    };

    const actions = pop.createDiv({ cls: "lpa-popover-actions" });
    const copyBtn = actions.createEl("button", { text: "Copy" });
    copyBtn.onclick = async () => {
      const cur = store.get(id);
      await navigator.clipboard.writeText((cur?.note || cur?.text || tagPreview(cur ?? initial)).trim());
      new Notice("Copied annotation text");
    };
    const delBtn = actions.createEl("button", { cls: "lpa-danger", text: "Delete" });
    delBtn.onclick = () => {
      const page = store.get(id)?.page ?? initial.page;
      store.remove(id);
      this.closeEditPopover();
      this.repaintPage(page);
      this.notifyStoreChanged();
    };

    // Position near the click, clamped into the window.
    pop.setCssProps({ visibility: "hidden" });
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const pr = pop.getBoundingClientRect();
    let px = x + 6;
    let py = y + 10;
    if (px + pr.width > vw - 8) px = Math.max(8, vw - pr.width - 8);
    if (py + pr.height > vh - 8) py = Math.max(8, y - pr.height - 10);
    pop.setCssProps({ left: `${px}px`, top: `${py}px`, visibility: "visible" });

    const onDocPointer = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node)) this.closeEditPopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeEditPopover();
    };
    // Defer so the opening click doesn't immediately dismiss it.
    window.setTimeout(() => doc.addEventListener("mousedown", onDocPointer, true), 0);
    doc.addEventListener("keydown", onKey, true);
    this.editPopoverCleanup = () => {
      doc.removeEventListener("mousedown", onDocPointer, true);
      doc.removeEventListener("keydown", onKey, true);
      pop.remove();
    };

    if (options.focusNote) {
      window.setTimeout(() => {
        note.focus();
        note.selectionStart = note.selectionEnd = note.value.length;
      }, 0);
    }
  }

  private closeEditPopover(): void {
    this.editPopoverCleanup?.();
    this.editPopoverCleanup = null;
  }

  // ---- hover / active emphasis on the painted marks ----------------------------

  /** Highlight fills are pointer-events:none so native text selection stays
   * intact — hover comes from hit-testing the pointer against the page under
   * it (rAF-throttled; only the hovered page's rects are checked). */
  private onPointerMove(evt: MouseEvent): void {
    if (this.destroyed || this.tagMode || !this.store) return;
    const target = evt.target as HTMLElement | null;
    if (
      target?.closest(
        ".lpa-native-sidebar-view, .lpa-native-controls, .lpa-mark-popover, .lpa-selection-popover, .lpa-page-tag"
      )
    ) {
      return;
    }
    this.lastPointer = {
      x: evt.clientX,
      y: evt.clientY,
      pageEl: target?.closest<HTMLElement>(".page[data-page-number]") ?? null,
    };
    if (this.pointerRaf !== null) return;
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    this.pointerRaf = win.requestAnimationFrame(() => {
      this.pointerRaf = null;
      if (this.destroyed || !this.lastPointer) return;
      const hit = this.hoveredHighlightAt(this.lastPointer);
      if (hit) this.setHoveredAnnotation(hit.id);
      else if (this.hoverId) this.clearHoveredAnnotationSoon(this.hoverId);
    });
  }

  private hoveredHighlightAt(p: { x: number; y: number; pageEl: HTMLElement | null }): Highlight | null {
    const store = this.store;
    if (!store || !p.pageEl || !p.pageEl.isConnected) return null;
    const num = Number(p.pageEl.getAttribute("data-page-number"));
    if (!Number.isFinite(num) || num < 1) return null;
    const idx = num - 1;
    const geom = this.geoms.get(idx);
    const box = pageContentBox(p.pageEl);
    if (!geom || !box || !aspectMatches(box, geom)) return null;
    const [px, py] = clientToPdfPoint(p.x, p.y, box, geom);
    const matches = store.byPage(idx).filter(
      (h) =>
        annotationTypeOf(h) === "highlight" &&
        h.rects.some(
          (r) =>
            px >= Math.min(r.x1, r.x2) &&
            px <= Math.max(r.x1, r.x2) &&
            py >= Math.min(r.y1, r.y2) &&
            py <= Math.max(r.y1, r.y2)
        )
    );
    return matches[matches.length - 1] ?? null;
  }

  private setHoveredAnnotation(id: string | null): void {
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.hoverClearTimer !== null) {
      win.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
    const next = id && this.store?.get(id) ? id : null;
    if (this.hoverId === next) return;
    this.hoverId = next;
    this.syncBindingState();
  }

  private clearHoveredAnnotationSoon(id?: string): void {
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.hoverClearTimer !== null) win.clearTimeout(this.hoverClearTimer);
    this.hoverClearTimer = win.setTimeout(() => {
      this.hoverClearTimer = null;
      if (!id || this.hoverId === id) this.setHoveredAnnotation(null);
    }, 120);
  }

  private setActiveAnnotation(id: string | null): void {
    const next = id && this.store?.get(id) ? id : null;
    if (this.activeId === next) return;
    this.activeId = next;
    this.syncBindingState();
  }

  private syncBindingState(): void {
    const root = this.contentRoot;
    if (!root) return;
    for (const mark of Array.from(root.querySelectorAll<HTMLElement>(".lpa-native-hl-layer .lpa-highlight"))) {
      const ids = (mark.dataset.hlIds ?? "").split(/\s+/).filter(Boolean);
      mark.toggleClass("is-active", !!this.activeId && ids.includes(this.activeId));
      mark.toggleClass("is-hover", !!this.hoverId && ids.includes(this.hoverId));
    }
    for (const tag of Array.from(root.querySelectorAll<HTMLElement>(".lpa-native-note-layer .lpa-page-tag"))) {
      const id = tag.dataset.hlId ?? "";
      tag.toggleClass("is-active", !!id && id === this.activeId);
      tag.toggleClass("is-hover", !!id && id === this.hoverId);
    }
  }

  // ---- annotation list ---------------------------------------------------------
  //
  // One home: Obsidian's native PDF sidebar, as a third view beside Thumbnails
  // and Outline. That is where a reader looks for it, and where it can be
  // resized and scrolled by controls the user already knows.

  private isListOpen(): boolean {
    return this.sidebarListActive;
  }

  private toggleList(): void {
    if (this.isListOpen()) this.closeList();
    else this.openList();
  }

  private openList(): void {
    if (this.destroyed || !this.store) return;
    if (this.setSidebarListActive(true)) return;
    // No native sidebar to host it — a PDF embed, or Obsidian having renamed
    // those classes. Say so rather than leaving a dead toolbar button.
    new Notice("PDF Annotator: this view has no PDF sidebar to show the annotation list in.");
  }

  private closeList(): void {
    this.setSidebarListActive(false);
  }

  private renderListItems(): void {
    const store = this.store;
    if (!store || !this.sidebarListActive) return;
    this.sidebarPanel?.render(store.doc.highlights);
  }

  private listPanelOptions(): AnnotationListPanelOptions {
    return {
      query: this.listSearchQuery,
      onQueryChange: (q) => {
        this.listSearchQuery = q;
      },
      onReveal: (id) => void this.revealAnnotation(id),
      accentFor: (h) => resolvePalette(annotationColor(h))?.ink ?? markInkColor(annotationColor(h)),
    };
  }

  // ---- the native sidebar view -------------------------------------------------

  /**
   * Obsidian builds the native sidebar as
   *   .pdf-content-container > .pdf-sidebar-container
   *     > .pdf-sidebar-content-wrapper > .pdf-sidebar-content
   *        > .pdf-thumbnail-view + .pdf-outline-view
   * and we add a third sibling. Resolved fresh each time rather than cached: a
   * window migration rebuilds this whole tree underneath us.
   */
  private sidebarContentEl(): HTMLElement | null {
    return this.contentRoot?.querySelector<HTMLElement>(".pdf-sidebar-content") ?? null;
  }

  private sidebarContainerEl(): HTMLElement | null {
    return this.contentRoot?.querySelector<HTMLElement>(".pdf-sidebar-container") ?? null;
  }

  /** Build (or rebuild) our sidebar view. Null when the native DOM isn't there. */
  private ensureSidebarView(): HTMLElement | null {
    if (this.destroyed) return null;
    if (this.sidebarViewEl?.isConnected && this.sidebarPanel) return this.sidebarViewEl;

    this.sidebarPanel?.destroy();
    this.sidebarPanel = null;
    this.sidebarViewEl?.remove();
    this.sidebarViewEl = null;

    const host = this.sidebarContentEl();
    if (!host) return null;
    // Sweep strays a rebuild may have left behind before adding ours.
    host.querySelectorAll<HTMLElement>(".lpa-native-sidebar-view").forEach((el) => el.remove());

    const view = host.createDiv({ cls: "lpa-native-sidebar-view" });
    this.sidebarViewEl = view;
    this.sidebarPanel = new AnnotationListPanel(view, this.listPanelOptions());
    return view;
  }

  /** True if the list is now showing in the native sidebar. */
  private setSidebarListActive(on: boolean): boolean {
    if (!on) {
      if (!this.sidebarListActive) return false;
      this.sidebarListActive = false;
      this.sidebarContainerEl()?.removeClass(SIDEBAR_MARKER_CLASS);
      this.syncToolbarState();
      return false;
    }

    const container = this.sidebarContainerEl();
    if (!container || !this.ensureSidebarView()) return false;
    // pdf.js opens synchronously inside the click, so this reads the result
    // rather than a hope. Refusing here means openList() reports the failure
    // instead of leaving the toolbar button pressed over a closed sidebar.
    if (!this.openNativeSidebar()) return false;
    container.addClass(SIDEBAR_MARKER_CLASS);
    this.sidebarListActive = true;
    this.renderListItems();
    this.syncToolbarState();
    return true;
  }

  /**
   * Put our view back after the viewer DOM was rebuilt under us. Called from
   * syncPages(), i.e. on every mutation batch — including the page-by-page
   * churn of scrolling a long PDF — so the healthy path must stay cheap and in
   * particular must NOT re-render: paint() empties the list container, which
   * would clamp its scrollTop to 0 and snap the list back to the top each time
   * a page loaded.
   */
  private reensureSidebarList(): void {
    if (this.destroyed || !this.sidebarListActive) return;
    const container = this.sidebarContainerEl();
    if (!container) {
      // The sidebar itself is gone (a rebuild we lost, or a PDF embed). Drop
      // the list rather than leave the toolbar button reading as pressed.
      this.sidebarListActive = false;
      this.syncToolbarState();
      return;
    }
    if (this.sidebarViewEl?.isConnected && this.sidebarPanel) {
      // Cheap and idempotent: only the marker class can have been lost.
      container.addClass(SIDEBAR_MARKER_CLASS);
      return;
    }
    if (!this.ensureSidebarView()) return;
    container.addClass(SIDEBAR_MARKER_CLASS);
    this.renderListItems();
  }

  /**
   * Open the native sidebar the way a user would: by clicking Obsidian's own
   * toggle. `pdfSidebar.open()` is private and there is no public event bus.
   *
   * This is the only native control the overlay drives, and it stays justified
   * because the user asked for it by pressing our list button. Contrast the
   * removed margin rails, which drove native zoom-out on their own initiative.
   *
   * Returns whether the sidebar is open afterwards.
   */
  private openNativeSidebar(): boolean {
    const contentContainer = this.contentRoot?.querySelector<HTMLElement>(
      ".pdf-content-container"
    );
    if (!contentContainer) return false;
    if (contentContainer.hasClass("sidebarOpen")) return true;
    const toggle = this.contentRoot?.querySelector<HTMLElement>(
      ".pdf-toolbar-left > .clickable-icon"
    );
    if (!toggle) return false;

    // Opening dispatches "sidebarviewchanged", so Obsidian writes data-view —
    // which is exactly the mutation onNativeSidebarViewChanged() reads as "the
    // user switched away". Ignore our own. MutationObserver callbacks are
    // microtasks, so they have all run by the next animation frame.
    this.suppressSidebarViewWatch++;
    toggle.click();
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => {
      this.suppressSidebarViewWatch = Math.max(0, this.suppressSidebarViewWatch - 1);
    });
    return contentContainer.hasClass("sidebarOpen");
  }

  /**
   * The user picked Thumbnails or Outline from the native menu, or closed the
   * sidebar. Yield: drop our marker class and pdf.js's own `hidden` handling —
   * which we never touched — restores the native view with no bookkeeping.
   */
  private onNativeSidebarViewChanged(): void {
    if (this.destroyed || this.suppressSidebarViewWatch > 0) return;
    if (!this.sidebarListActive) return;
    this.setSidebarListActive(false);
  }

  private teardownSidebarList(): void {
    this.sidebarListActive = false;
    this.sidebarPanel?.destroy();
    this.sidebarPanel = null;
    this.sidebarViewEl?.remove();
    this.sidebarViewEl = null;
    const container = this.sidebarContainerEl();
    container?.removeClass(SIDEBAR_MARKER_CLASS);
    // Sweep any view a rebuild orphaned before we could drop our reference.
    this.contentRoot
      ?.querySelectorAll<HTMLElement>(".lpa-native-sidebar-view")
      .forEach((el) => el.remove());
  }

  private async revealAnnotation(id: string): Promise<void> {
    const h = this.store?.get(id);
    const root = this.contentRoot;
    if (!h || !root) return;
    const pageEl = root.querySelector<HTMLElement>(`.page[data-page-number="${h.page + 1}"]`);
    if (!pageEl) return;
    // Get the page on screen first so the native viewer starts rendering it;
    // once the mark itself exists we scroll again, to the mark.
    pageEl.scrollIntoView({ block: "center" });
    // Revealing is navigation, not selection: the box says "here it is" and
    // the text is left exactly as it was painted. Deliberately no
    // setActiveAnnotation(id) — that repaints the passage under the active
    // wash, leaving it recoloured long after the box has faded. Any mark left
    // active by an open popover is released for the same reason: navigating
    // away should not leave a tinted passage behind on another page.
    this.closeEditPopover();
    this.setActiveAnnotation(null);
    // The native viewer renders lazily; poll briefly for the painted mark.
    for (let i = 0; i < 12; i++) {
      await sleep(150);
      if (this.destroyed || !pageEl.isConnected) return;
      const els = this.markElementsFor(pageEl, h, id);
      if (!els.length) continue;
      // Centre the mark, not the page: on a tall page `block: "center"` above
      // can leave the mark off-screen, and an animation nobody sees is no
      // animation at all. Instant, not smooth — the page jump above was already
      // instant, and a glide still running underneath would swallow the first
      // hop of the bounce.
      els[0].scrollIntoView({ block: "center" });
      this.showRevealCue(els, pageEl, h);
      return;
    }
  }

  /**
   * Every painted element belonging to one annotation. A multi-line passage is
   * several rects, and flashing only the first would draw the eye to a fragment
   * of the sentence rather than the sentence.
   */
  private markElementsFor(pageEl: HTMLElement, h: Highlight, id: string): HTMLElement[] {
    if (annotationTypeOf(h) === "tag") {
      const tag = pageEl.querySelector<HTMLElement>(
        `.lpa-native-note-layer .lpa-page-tag[data-hl-id="${cssEscape(id)}"]`
      );
      return tag ? [tag] : [];
    }
    return Array.from(
      pageEl.querySelectorAll<HTMLElement>(".lpa-native-hl-layer .lpa-highlight")
    ).filter((cand) => (cand.dataset.hlIds ?? "").split(/\s+/).includes(id));
  }

  /**
   * The reveal cue is a single bouncing box around the passage, and it lives in
   * its OWN layer rather than riding the marks.
   *
   * The marks cannot carry it: paintPage() calls layer.empty() and rebuilds
   * every mark element from scratch, and a repaint is exactly what the scroll
   * we just did provokes — the native viewer renders the page lazily. An
   * animation class put on a mark is therefore liable to be thrown away
   * milliseconds after it is set, which is why the earlier mark-based flash was
   * so easy to miss. A layer paintPage() never touches is immune to that.
   */
  private showRevealCue(els: HTMLElement[], pageEl: HTMLElement, h: Highlight): void {
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    // Cancel a cue still in flight. Its timer would otherwise fire partway
    // through this one and cut it off mid-hop — precisely the repeat-click case.
    this.clearRevealCue(win);
    if (!this.drawRevealBox(els, pageEl, h)) return;
    this.revealCueTimer = win.setTimeout(() => {
      this.revealCueTimer = null;
      this.clearRevealCue(win);
    }, FLASH_MS);
  }

  /**
   * One box around the WHOLE annotation — the union of its line rects, not a
   * box per line. A multi-line passage is one sentence, and per-line boxes both
   * misrepresent that and read as a table of rows. It is a transient reveal
   * cue, deliberately not the same language as hover/active emphasis (which
   * stays outline-free so an engaged underline can't masquerade as a box mark).
   */
  private drawRevealBox(els: HTMLElement[], pageEl: HTMLElement, h: Highlight): boolean {
    if (!els.length) return false;
    // Our own layer, a sibling of the mark layers and inset:0 like them, so the
    // box shares their coordinate basis (percentages of the page box) without
    // depending on whether the native .page carries a border.
    let layer = pageEl.querySelector<HTMLElement>(":scope > .lpa-native-reveal-layer");
    if (!layer) layer = pageEl.createDiv({ cls: "lpa-native-reveal-layer" });
    const base = layer.getBoundingClientRect();
    if (base.width <= 0 || base.height <= 0) return false;

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return false;

    // Breathing room, so the border sits around the passage rather than on it.
    const pad = 3;
    left -= pad;
    top -= pad;
    right += pad;
    bottom += pad;

    const box = layer.createDiv({ cls: "lpa-reveal-box" });
    // Percentages of the page box, like every other mark, so native zoom keeps
    // it aligned for the second it is alive.
    box.setCssProps({
      left: `${((left - base.left) / base.width) * 100}%`,
      top: `${((top - base.top) / base.height) * 100}%`,
      width: `${((right - left) / base.width) * 100}%`,
      height: `${((bottom - top) / base.height) * 100}%`,
    });
    box.style.setProperty(
      "--lpa-reveal-ink",
      resolvePalette(annotationColor(h))?.ink ?? markInkColor(annotationColor(h))
    );
    return true;
  }

  private clearRevealCue(win: Window): void {
    if (this.revealCueTimer !== null) {
      win.clearTimeout(this.revealCueTimer);
      this.revealCueTimer = null;
    }
    // Sweep by selector, not by reference: a native re-render can replace the
    // page subtree, orphaning the handle while a box is still on screen.
    this.contentRoot
      ?.querySelectorAll<HTMLElement>(".lpa-native-reveal-layer")
      .forEach((el) => el.remove());
  }

  // ---- legacy import (same behavior as the custom annotator view) --------------

  async importLegacyAnnotations(): Promise<void> {
    const store = this.store;
    if (!this.pdfDoc || !store) {
      new Notice("The annotation overlay is still loading — try again in a moment.");
      return;
    }
    const pdfName = this.file.name.normalize("NFC").toLowerCase();
    const notes = this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      const tgt = fm?.["annotation-target"];
      if (!tgt) return false;
      const tval = Array.isArray(tgt) ? tgt[0] : tgt;
      return targetBasename(String(tval)) === pdfName;
    });
    if (notes.length === 0) {
      new Notice("No obsidian-annotator notes target this PDF.");
      return;
    }

    const legacy: LegacyAnnotation[] = [];
    for (const n of notes) {
      legacy.push(...parseLegacyNote(await this.app.vault.read(n)).annotations);
    }
    if (legacy.length === 0) {
      new Notice("Found note(s) but no highlights to import.");
      return;
    }

    const notice = new Notice(`Indexing ${this.pdfDoc.numPages} pages…`, 0);
    let docIndex;
    try {
      docIndex = await buildDocIndex(this.pdfDoc, (d, t) => {
        if (d % 25 === 0 || d === t) notice.setMessage(`Indexing pages ${d}/${t}…`);
      });
    } catch (e) {
      notice.hide();
      console.error(`${LOG_TAG} legacy import indexing failed`, e);
      new Notice("Import failed while indexing the PDF (see console).");
      return;
    }
    if (this.destroyed) {
      notice.hide();
      return;
    }

    const seen = new Set(store.doc.highlights.map((h) => `${h.page}|${dedupeKey(h.text)}`));
    const created: Highlight[] = [];
    const affected = new Set<number>();
    let matched = 0;
    const unmatched: string[] = [];

    for (const a of legacy) {
      const results = anchorQuote(docIndex, a.exact, a.prefix, a.suffix);
      if (results.length === 0) {
        unmatched.push(a.exact);
        continue;
      }
      matched++;
      const cleanText = a.exact.replace(/\s+/g, " ").trim();
      for (const r of results) {
        const key = `${r.page}|${dedupeKey(cleanText)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        created.push({
          id: newId(),
          type: "highlight",
          page: r.page,
          color: this.currentColor,
          text: cleanText,
          note: a.note,
          rects: r.rects,
          created: a.created ?? new Date().toISOString(),
          source: "import",
          marginSide: "auto",
          isPinned: false,
          context: { prefix: a.prefix, suffix: a.suffix },
        });
        affected.add(r.page);
      }
    }

    notice.hide();
    if (created.length === 0) {
      new Notice(`Nothing new to import (matched ${matched}/${legacy.length}; already present).`);
      return;
    }
    store.addMany(created);
    await store.flush();
    for (const p of affected) this.repaintPage(p);
    this.notifyStoreChanged();
    new Notice(
      `Imported ${created.length} highlight(s) from ${notes.length} note(s). ` +
        `Matched ${matched}/${legacy.length}` +
        (unmatched.length ? `, ${unmatched.length} unmatched (see console).` : ".")
    );
    if (unmatched.length) {
      console.warn(`${LOG_TAG} ${unmatched.length} legacy quote(s) could not be anchored:`);
      unmatched.forEach((u) => console.warn("  •", u.slice(0, 90).replace(/\s+/g, " ")));
    }
  }
}

// ---- module helpers (ported from the custom view; base-viewport space) --------

/** The box the PDF content actually occupies inside a native ".page" div.
 * Prefer the native text layer (absolute, inset 0 — where selection rects
 * live), then the canvas wrapper, then our own inset-0 layer. */
function pageContentBox(pageEl: HTMLElement): DOMRect | null {
  const ref =
    pageEl.querySelector<HTMLElement>(":scope > .textLayer") ??
    pageEl.querySelector<HTMLElement>(":scope > .canvasWrapper") ??
    pageEl.querySelector<HTMLElement>(":scope > .lpa-native-hl-layer") ??
    pageEl;
  const box = ref.getBoundingClientRect();
  return box.width >= 2 && box.height >= 2 ? box : null;
}

function aspectMatches(box: DOMRect, geom: PageGeom): boolean {
  if (geom.w <= 0 || geom.h <= 0 || box.height <= 0) return false;
  const dom = box.width / box.height;
  const base = geom.w / geom.h;
  return Math.abs(dom - base) / base <= 0.04;
}

function clientToPdfPoint(clientX: number, clientY: number, box: DOMRect, geom: PageGeom): [number, number] {
  const bx = ((clientX - box.left) / box.width) * geom.w;
  const by = ((clientY - box.top) / box.height) * geom.h;
  const p = geom.vp1.convertToPdfPoint(bx, by) as number[];
  return [p[0], p[1]];
}

/** PDF-space rects → base-viewport (scale 1) rects, origin top-left. */
function rectsToBase(geom: PageGeom, rects: PdfRect[]): BaseRect[] {
  const out: BaseRect[] = [];
  for (const r of rects) {
    const a = geom.vp1.convertToViewportPoint(r.x1, r.y1) as number[];
    const b = geom.vp1.convertToViewportPoint(r.x2, r.y2) as number[];
    out.push({
      left: Math.min(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      right: Math.max(a[0], b[0]),
      bottom: Math.max(a[1], b[1]),
    });
  }
  return out;
}

/** Position a mark as a % of the page box so native zoom keeps it aligned. */
function applyPctBox(el: HTMLElement, r: BaseRect, geom: PageGeom): void {
  el.setCssProps({
    left: `${(r.left / geom.w) * 100}%`,
    top: `${(r.top / geom.h) * 100}%`,
    width: `${((r.right - r.left) / geom.w) * 100}%`,
    height: `${((r.bottom - r.top) / geom.h) * 100}%`,
  });
}

function lineMetricsFor(s: number): LineMetrics {
  return {
    weight: clamp(1.4, s * 1.35, 3),
    dash: Math.max(4, Math.round(s * 5)),
    dashGap: Math.max(3, Math.round(s * 4)),
    dot: Math.max(1.4, +(s * 1.6).toFixed(2)),
    dotGap: Math.max(2.4, +(s * 2.8).toFixed(2)),
  };
}

function coalescePaintRects(rects: PaintRect[]): PaintRect[] {
  const out: PaintRect[] = [];
  const sorted = [...rects].sort(
    (a, b) => a.color.localeCompare(b.color) || a.top - b.top || a.left - b.left || a.order - b.order
  );
  for (const rect of sorted) {
    let cur = clonePaintRect(rect);
    for (;;) {
      const i = out.findIndex((candidate) => canMergePaintRects(cur, candidate));
      if (i < 0) break;
      cur = mergePaintRects(cur, out[i]);
      out.splice(i, 1);
    }
    out.push(cur);
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left);
}

function clonePaintRect(r: PaintRect): PaintRect {
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    color: r.color,
    order: r.order,
    ids: new Set(r.ids),
    notes: new Set(r.notes),
  };
}

function canMergePaintRects(a: PaintRect, b: PaintRect): boolean {
  if (a.color !== b.color) return false;
  const minHeight = Math.min(a.bottom - a.top, b.bottom - b.top);
  const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (verticalOverlap < Math.max(1, minHeight * 0.45)) return false;
  const aCenter = (a.top + a.bottom) / 2;
  const bCenter = (b.top + b.bottom) / 2;
  if (Math.abs(aCenter - bCenter) > Math.max(2, minHeight * 0.6)) return false;
  const horizontalGap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
  return horizontalGap <= Math.max(2, minHeight * 0.25);
}

function mergePaintRects(a: PaintRect, b: PaintRect): PaintRect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
    color: a.color,
    order: Math.min(a.order, b.order),
    ids: new Set([...a.ids, ...b.ids]),
    notes: new Set([...a.notes, ...b.notes]),
  };
}

function occludePaintRects(rects: PaintRect[]): PaintRect[] {
  const out: PaintRect[] = [];
  const painted: PaintRect[] = [];
  const sorted = [...rects].sort((a, b) => a.order - b.order || a.top - b.top || a.left - b.left);
  for (const rect of sorted) {
    let pieces = [clonePaintRect(rect)];
    for (const blocker of painted) {
      const next: PaintRect[] = [];
      for (const piece of pieces) next.push(...subtractPaintRect(piece, blocker));
      pieces = next;
      if (pieces.length === 0) break;
    }
    out.push(...pieces);
    painted.push(...pieces);
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left || a.order - b.order);
}

function subtractPaintRect(rect: PaintRect, blocker: PaintRect): PaintRect[] {
  const left = Math.max(rect.left, blocker.left);
  const top = Math.max(rect.top, blocker.top);
  const right = Math.min(rect.right, blocker.right);
  const bottom = Math.min(rect.bottom, blocker.bottom);
  if (right - left <= 0.5 || bottom - top <= 0.5) return [rect];
  const pieces: PaintRect[] = [];
  pushPaintPiece(pieces, rect, rect.left, rect.top, rect.right, top);
  pushPaintPiece(pieces, rect, rect.left, bottom, rect.right, rect.bottom);
  pushPaintPiece(pieces, rect, rect.left, top, left, bottom);
  pushPaintPiece(pieces, rect, right, top, rect.right, bottom);
  return pieces;
}

function pushPaintPiece(
  pieces: PaintRect[],
  source: PaintRect,
  left: number,
  top: number,
  right: number,
  bottom: number
): void {
  if (right - left <= 0.5 || bottom - top <= 0.5) return;
  pieces.push({
    left,
    top,
    right,
    bottom,
    color: source.color,
    order: source.order,
    ids: new Set(source.ids),
    notes: new Set(source.notes),
  });
}

function mergeLineRects(rects: BaseRect[]): BaseRect[] {
  const clean = rects.filter((r) => r.right - r.left >= 0.5 && r.bottom - r.top >= 0.5);
  const lines: BaseRect[] = [];
  for (const r of [...clean].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const rCenter = (r.top + r.bottom) / 2;
    const minH = r.bottom - r.top;
    const line = lines.find((l) => {
      const lCenter = (l.top + l.bottom) / 2;
      const h = Math.min(minH, l.bottom - l.top);
      const overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top);
      return overlap >= h * 0.5 && Math.abs(lCenter - rCenter) <= Math.max(2, h * 0.6);
    });
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ ...r });
    }
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(color: string): Rgba | null {
  const rgb = color.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+)\s*)?\)$/i
  );
  if (rgb) {
    return {
      r: clampCssByte(Number(rgb[1])),
      g: clampCssByte(Number(rgb[2])),
      b: clampCssByte(Number(rgb[3])),
      a: rgb[4] === undefined ? 1 : clampCssAlpha(Number(rgb[4])),
    };
  }
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const value = hex[1].length === 3 ? hex[1].split("").map((ch) => ch + ch).join("") : hex[1];
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
      a: 1,
    };
  }
  return null;
}

function highlightPaintColor(color: string): string {
  const pal = resolvePalette(color);
  const fill = pal?.fill ?? color;
  const c = parseColor(fill);
  if (!c) return fill;
  const a = pal?.highlightAlpha ?? Math.min(c.a === 1 ? MAX_HIGHLIGHT_ALPHA : c.a, MAX_HIGHLIGHT_ALPHA);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(a)})`;
}

function markInkColor(color: string): string {
  const c = parseColor(color);
  if (!c) return color;
  const k = 0.62;
  return `rgba(${Math.round(c.r * k)}, ${Math.round(c.g * k)}, ${Math.round(c.b * k)}, 0.95)`;
}

function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(alpha)})`;
}

function clampCssByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampCssAlpha(value: number): number {
  if (!Number.isFinite(value)) return MAX_HIGHLIGHT_ALPHA;
  return Math.min(1, Math.max(0, value));
}

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface AnnotationListPanelOptions {
  /** Title + close row. The floating panel needs it; the sidebar has its own. */
  query?: string;
  onQueryChange?: (query: string) => void;
  onReveal: (id: string) => void;
  /** Colour machinery lives in the overlay; the panel just paints what it gets. */
  accentFor: (h: Highlight) => string;
}

/**
 * The annotation list, rendered into the host it is handed — currently the
 * view we inject into Obsidian's native PDF sidebar. It is kept host-agnostic
 * (it takes an element and callbacks, and reaches for nothing outside its own
 * subtree) so the sidebar stays a placement decision rather than a fact baked
 * through the renderer.
 *
 * There is no title bar or close button: the sidebar already frames it, and
 * closing it is the toolbar toggle's job.
 *
 * The panel never asks for a width. The native sidebar's width is owned by a
 * pdf.js drag handle (private field, persisted view state) that would overwrite
 * anything we set, so the list observes the room it is given and degrades
 * through `ListWidthBand` instead.
 */
class AnnotationListPanel {
  private rootEl: HTMLElement;
  private metaEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private listEl: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private band: ListWidthBand | null = null;
  private query: string;
  private lastRendered: readonly Highlight[] = [];

  constructor(host: HTMLElement, private opts: AnnotationListPanelOptions) {
    this.query = opts.query ?? "";
    this.rootEl = host.createDiv({ cls: "lpa-annlist" });

    this.metaEl = this.rootEl.createDiv({ cls: "lpa-annlist-meta" });

    this.searchEl = this.rootEl.createEl("input", {
      cls: "lpa-annlist-search",
      attr: { type: "search", placeholder: "Search annotations", "aria-label": "Search annotations" },
    });
    this.searchEl.value = this.query;
    this.searchEl.oninput = () => {
      this.query = this.searchEl?.value ?? "";
      this.opts.onQueryChange?.(this.query);
      this.paint();
    };

    this.listEl = this.rootEl.createDiv({ cls: "lpa-annlist-list" });

    // Obsidian binds its thumbnail context menu to .pdf-sidebar-container, so
    // a right-click on one of our rows would open it over the annotation list.
    this.rootEl.addEventListener("contextmenu", (evt) => evt.stopPropagation());

    const win = host.ownerDocument.defaultView;
    if (win?.ResizeObserver) {
      this.resizeObserver = new win.ResizeObserver(() => this.applyWidthBand());
      this.resizeObserver.observe(this.rootEl);
    }
    this.applyWidthBand();
  }

  render(highlights: readonly Highlight[]): void {
    this.lastRendered = highlights;
    this.paint();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.rootEl.remove();
  }

  focusSearch(): void {
    this.searchEl?.focus();
  }

  private applyWidthBand(): void {
    const width = this.rootEl.getBoundingClientRect().width;
    // A detached or not-yet-laid-out panel measures 0; don't let that force the
    // tight band and then thrash back one frame later.
    if (width <= 0) return;
    const band = widthBandFor(width);
    if (band === this.band) return;
    this.band = band;
    this.rootEl.toggleClass("is-tight", band === "tight");
    this.rootEl.toggleClass("is-compact", band === "compact");
    this.rootEl.toggleClass("is-roomy", band === "roomy");
  }

  private paint(): void {
    const annotations = sortForList(this.lastRendered);
    const filtered = filterForList(annotations, this.query);
    const searching = normalizeSearch(this.query).length > 0;
    this.metaEl?.setText(
      searching ? `${filtered.length}/${annotations.length}` : String(annotations.length)
    );

    this.listEl.empty();
    if (annotations.length === 0) {
      this.listEl.createDiv({ cls: "lpa-annlist-empty", text: "No annotations yet." });
      return;
    }
    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: "lpa-annlist-empty", text: "No matching annotations." });
      return;
    }
    for (const h of filtered) {
      const item = this.listEl.createDiv({ cls: "lpa-annlist-item" });
      item.setCssProps({ "--lpa-accent": this.opts.accentFor(h) });
      const head = item.createDiv({ cls: "lpa-annlist-item-head" });
      head.createSpan({ cls: "lpa-annlist-page", text: `p.${h.page + 1}` });
      head.createSpan({ cls: "lpa-annlist-kind", text: annotationKindLabel(h) });
      item.createDiv({ cls: "lpa-annlist-text", text: listPrimaryText(h) });
      const secondary = listSecondaryText(h);
      if (secondary) item.createDiv({ cls: "lpa-annlist-source", text: secondary });
      item.onclick = () => this.opts.onReveal(h.id);
    }
  }
}

function dedupeKey(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase().slice(0, 80);
}

function cssEscape(value: string): string {
  const escape = typeof CSS !== "undefined" ? (CSS as any).escape : null;
  if (typeof escape === "function") return escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
