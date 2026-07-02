# PDF Annotator

PDF Annotator is a desktop-only Obsidian plugin for reading PDFs, marking
passages, and keeping searchable annotations next to the document.

It stores annotation data in a local Markdown sidecar beside each PDF. The PDF
file itself is not modified, and the annotation source remains readable and
portable.

## Features

- Annotate inside Obsidian's native PDF viewer without replacing its toolbar,
  sidebar, zoom, or page navigation.
- Keep the original bundled `pdf.js` annotator view available as a stable
  fallback.
- Select text without creating anything by accident.
- Use the contextual selection popup to create either:
  - a highlight only, or
  - an annotation with a highlight and note.
- Keep text crisp: highlight color is painted behind selectable PDF text.
- View annotation cards in left and right margins at the level of their source
  passage in the fallback annotator view.
- Search highlights, notes, and page tags from the annotation list.
- Add page-level tags for notes that are not tied to a text selection.
- Move margin cards between left and right margins.
- Import legacy `obsidian-annotator` highlights for the current PDF.

## Opening PDFs

Open a PDF normally in Obsidian. The native PDF toolbar gets an **Annotate**
toggle. Turning it on layers annotation tools onto the current native PDF view,
without opening a duplicate tab or replacing the page.

The command palette action **Open current PDF in annotator** remains available
as a stable fallback for the custom PDF Annotator view.

You can also make it the default PDF viewer from plugin settings. This redirects
ordinary `.pdf` clicks into PDF Annotator. The setting is opt-in for fresh
installs.

## Basic Use

1. Open a PDF normally in Obsidian.
2. Click **Annotate** in the native PDF toolbar.
3. Drag-select text. Selection alone creates nothing.
4. Use the selection popup when it opens.
5. Choose **Highlight** to save only a text mark.
6. Choose **Annotate** to save a text mark plus a note.
7. Use the note button in the toolbar to place a page note at a specific
   location on the PDF.
8. Use the list button in the toolbar to open searchable annotations.

## Data Format

Each PDF gets a companion file named:

```text
<pdf-name>.annotations.md
```

The sidecar lives in the same folder as the PDF. It contains a readable Markdown
summary and a fenced JSON block that is used as the machine-readable source of
truth.

Highlight geometry is stored in PDF user-space coordinates, so highlights and
tags remain anchored across zoom changes.

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
quoted text in the PDF, and creates PDF Annotator highlights. Legacy notes
are left untouched.

## Development

```bash
npm install
npm run typecheck
npm run build
```

`npm run build` type-checks the plugin, bundles `main.js`, and copies
`main.js`, `manifest.json`, and `styles.css` into the configured local vault
plugin directory used by this checkout.

## Release Files

Obsidian installs community plugin releases from GitHub release assets. A release
must include:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag must match the `version` field in `manifest.json`.
