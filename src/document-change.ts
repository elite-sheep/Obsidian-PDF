/**
 * document-change.ts — what to do when a PDF's bytes no longer match the
 * annotations stored for it.
 *
 * Both annotation surfaces (view.ts and native-overlay.ts) must behave
 * identically here, so the whole decision lives in one function rather than
 * being written twice. Deciding is deliberately the USER's call: the plugin
 * cannot tell a re-download of the same paper from a different document that
 * happens to sit at the same path, and guessing wrong either discards real work
 * or paints marks over unrelated text.
 *
 * Geometry is stored in PDF user space, so when the page count is unchanged the
 * marks land where they always did and the user can confirm visually. That
 * visual check is why no text re-anchoring machinery is needed.
 *
 * "Start fresh" never deletes: the superseded sidecar is renamed aside, so the
 * canonical path is free and the old work is still recoverable.
 */
import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import { sidecarBackupPathFor } from "./annotations";
import { LOG_TAG } from "./pdf-engine";
import type { DocumentBinding } from "./document-binding";

type ChangeDecision = "keep" | "fresh" | "cancel";

/**
 * Returns false when annotation mode should not open at all. May archive the
 * superseded sidecar, in which case the caller's subsequent load() correctly
 * finds nothing and starts empty.
 */
export async function resolveDocumentChange(
  app: App,
  file: TFile,
  binding: DocumentBinding
): Promise<boolean> {
  if (binding.change.kind !== "changed") return true;
  const { samePageCount, highlightCount, storedPath } = binding.change;

  const decision = await new Promise<ChangeDecision>((resolve) => {
    new DocumentChangedModal(app, file.name, highlightCount, samePageCount, resolve).open();
  });
  if (decision === "cancel") return false;
  if (decision === "keep") return true;

  try {
    await archiveSidecar(app, storedPath);
    await archiveSidecar(app, sidecarBackupPathFor(storedPath));
  } catch (error: any) {
    // Failing to archive must not lead to silently overwriting the old work.
    console.error(`${LOG_TAG} could not archive superseded annotations`, error);
    new Notice(`PDF Annotator: could not set aside the old annotations — ${error?.message ?? error}`);
    return false;
  }
  return true;
}

/** Rename to a free "…superseded[-n].md" path beside the original. */
async function archiveSidecar(app: App, path: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) return;
  const stem = normalizePath(path).replace(/\.md$/i, "");
  let target = `${stem}.superseded.md`;
  let n = 2;
  while (app.vault.getAbstractFileByPath(target)) target = `${stem}.superseded-${n++}.md`;
  await app.vault.rename(file, target);
}

class DocumentChangedModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private pdfName: string,
    private highlightCount: number,
    private samePageCount: boolean,
    private resolve: (decision: ChangeDecision) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "This PDF has changed" });

    const marks = `${this.highlightCount} annotation${this.highlightCount === 1 ? "" : "s"}`;
    contentEl.createEl("p", {
      text: `${this.pdfName} does not match the ${marks} saved for it.`,
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: this.samePageCount
        ? "The page count is unchanged, so this is most likely the same document " +
          "re-downloaded or re-saved. Keeping the annotations should place them " +
          "correctly — check a few pages to confirm."
        : "The page count is different, so this is likely a different document. " +
          "Keeping the annotations will probably place them on the wrong text.",
    });

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(`Keep ${marks}`)
          .setCta()
          .onClick(() => this.finish("keep"))
      )
      .addButton((b) =>
        b.setButtonText("Start fresh").onClick(() => this.finish("fresh"))
      )
      .addButton((b) => b.setButtonText("Don't open").onClick(() => this.finish("cancel")));

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "“Start fresh” keeps the old annotations in a “.superseded.md” file; nothing is deleted.",
    });
  }

  private finish(decision: ChangeDecision): void {
    this.decided = true;
    this.resolve(decision);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissing without choosing must not risk the annotations.
    if (!this.decided) this.resolve("cancel");
  }
}
