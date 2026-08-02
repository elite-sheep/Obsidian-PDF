# PDF Annotator

PDF Annotator is a desktop-only Obsidian plugin for reading PDFs, highlighting
passages, and keeping local notes beside the page you are reading.

Open a PDF normally, turn on **Annotate** in the native PDF toolbar, and work in
the same Obsidian PDF view. The plugin does not replace Obsidian's PDF toolbar,
thumbnail/sidebar area, zoom controls, or page navigation.

Every PDF opened for annotation is protected by a managed, vault-local document
bundle. The plugin stores a verified byte-for-byte PDF backup, its Markdown
annotations, and identity metadata together. The working PDF is not modified.

![Text selection popup with highlight, annotate, and copy actions](docs/screenshots/selection-popover.png)

## What You Can Do

- Highlight selected PDF text in Obsidian's native PDF viewer.
- Add a note to a highlight without leaving the PDF tab.
- Keep annotation cards in the left or right rail beside the PDF page.
- Edit notes directly from the side card or from the annotation popover.
- Use different mark styles and colors for emphasis.
- Add page-level notes for thoughts that are not tied to selected text.
- Search highlights, notes, and page tags from the annotation list.
- Pin important side cards so they remain visible.
- Move a card to the left rail, right rail, or automatic placement from the
  card context menu.
- Import legacy `obsidian-annotator` highlights for the current PDF.

![Annotation card in the side rail with the edit popover open](docs/screenshots/side-rail-card.png)

## Native PDF Workflow

1. Open a PDF normally in Obsidian.
2. Click **Annotate** in the native PDF toolbar.
3. Select text. Selection alone does not create an annotation.
4. Use the popup to choose **Highlight**, **Annotate**, or **Copy**.
5. Click an existing mark to edit its style, color, note, or side note.
6. Use the side card for quick reading and note editing while the PDF stays in
   the normal Obsidian viewer.

When the PDF is too wide for a readable side card, PDF Annotator uses the native
zoom-out control to create rail space before showing the card. Cards should stay
in the side rails rather than floating over the PDF page.

## Side Cards

Side cards are the margin notes for your PDF. They appear beside the source
highlight at roughly the same vertical position, with a connector line back to
the marked text.

Right-click a side card to:

- pin or unpin it;
- move it to the left rail;
- move it to the right rail;
- return it to automatic placement;
- delete the annotation.

Drag-and-drop between rails is not currently a plugin interaction; use the
right-click card menu to move cards.

## Fallback Annotator View

The original bundled `pdf.js` annotator view is still included as a stable
fallback. Use the command palette action:

```text
Open current PDF in annotator
```

You can also make the fallback annotator the default PDF viewer from plugin
settings. This redirects ordinary `.pdf` clicks into PDF Annotator. The setting
is opt-in for fresh installs.

## Data Format

The visible PDF path is not the document identity. Identity comes from a SHA-256
hash of the PDF bytes, and the canonical bundle is stored at:

```text
.pdf-annotator/bundles/sha256/<hash>/
  document.pdf
  annotations.md
  annotations.previous.md
  manifest.json
```

`document.pdf` is a verified recovery copy. `annotations.md` is the canonical
annotation sidecar, and `annotations.previous.md` is a rolling last-known-good
copy used if a save is interrupted or corrupted. `manifest.json` records the
current working path, previous path aliases, checksum, original filename,
timestamps, and PDF fingerprint.

The bundle is created the first time annotation mode opens for that PDF. This
intentionally uses roughly one additional PDF's worth of vault storage in
exchange for deletion recovery.

Moving or renaming a working PDF does not move the bundle and cannot disconnect
its annotations. Replacing a PDF with different bytes at the same path creates a
different bundle, so annotations cannot silently attach to the wrong document.
Deleting the working copy leaves the bundle intact. Use **Restore a PDF from
annotation backup** in the command palette to verify the checksum and restore a
copy into `Recovered PDFs/`.

Existing central or same-folder `<pdf-name>.annotations.md` sidecars are imported
on first open. A unique PDF-fingerprint match can also recover a sidecar that was
already orphaned by a rename. Legacy files are retained as recovery snapshots.

The canonical sidecar contains a readable Markdown summary and a fenced JSON
block that is used as the machine-readable source of truth. Use **Export
annotations for current PDF** to create a user-visible snapshot under
`PDF annotations/Exports/` (or the configured legacy annotation folder).

Highlight geometry is stored in PDF user-space coordinates, so highlights and
tags remain anchored across zoom changes.

Use **Verify all PDF annotation backups** to checksum every managed recovery
copy. Backups are also verified when created and periodically when their PDFs
are opened. The managed library protects against moving, renaming, replacing,
or deleting a working copy; it is still part of the same vault, so the vault
itself should remain covered by iCloud, Obsidian Sync, or another backup system.
If your sync tool excludes hidden folders, explicitly include `.pdf-annotator/`.

## Privacy

PDF Annotator does not use telemetry and does not send PDF contents or
annotation contents to any remote service. Data is stored locally in your vault.

## Legacy Import

If you previously used `obsidian-annotator`, open the target PDF in this plugin
and run:

```text
Import legacy obsidian-annotator highlights for this PDF
```

The importer searches notes with `annotation-target:` frontmatter, re-anchors
quoted text in the PDF, and creates PDF Annotator highlights. Legacy notes are
left untouched.

## Development

```bash
npm install     # or: yarn install
npm run typecheck
npm test
npm run build
```

`npm run build` type-checks the plugin, bundles it, and writes the three release
files (`main.js`, `manifest.json`, `styles.css`) into `dist/`. No vault is
required to build.

### Installing into a vault while developing

To have every build install itself into Obsidian, tell the build where your
plugin folder is — either copy `.plugin-dir.example` to `.plugin-dir` and put the
path on one line:

```text
/absolute/path/to/YourVault/.obsidian/plugins/local-pdf-annotator
```

…or set `LOCAL_PDF_ANNOTATOR_PLUGIN_DIR`, which takes precedence:

```bash
LOCAL_PDF_ANNOTATOR_PLUGIN_DIR=/tmp/staging npm run build
```

`.plugin-dir` and `dist/` are gitignored, so no machine-specific path is ever
committed. With neither configured the build simply produces `dist/` and says so.

The configured folder's **parent** must already exist — the build creates the
plugin folder itself but never invents a vault around it, so a stale path from
another machine fails immediately with a readable message.

`npm run dev` runs the same pipeline in watch mode, reinstalling on every rebuild.

## Release Files

Obsidian installs community plugin releases from GitHub release assets. A
release must include:

- `main.js`
- `manifest.json`
- `styles.css`

`npm run build` puts exactly these three files in `dist/`, so the release assets
are whatever `dist/` contains after a production build.

The release tag must match the `version` field in `manifest.json` (and the entry
added to `versions.json`).
