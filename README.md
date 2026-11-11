# IPYNB Viewer (Chrome extension)

Open Jupyter notebooks in Chrome - code, Markdown, math and the outputs saved in the file - with no kernel.
Edit or delete cells, clear outputs, and export to PDF or Word.

## Install (unpacked)
1. Unzip into a folder (the folder must contain `manifest.json`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder.
3. On the extension card: **Details** -> turn on **Allow access to file URLs** (Chrome requires this to read local files).

## Open notebooks by double-click
Make Chrome the default app for `.ipynb` (right-click a notebook -> Open with -> Chrome -> always).
You can also drag a file into a Chrome tab, or click the toolbar icon and drop/choose a file.

## Editing (turn on **Edit mode** in the toolbar)
- Hover a cell: **Edit** (Ctrl/Cmd+Enter saves, Esc cancels), **Clear output**, **Delete** (with Undo).
- **Clear all outputs**, **Reset** (restores the notebook as it was opened), **Save .ipynb** (downloads `<name>-edited.ipynb`).
- Nothing is executed and the original file is never modified; edits live in the open tab until you save a copy.

## Export
- **Export PDF** (or Ctrl/Cmd+P): choose "Save as PDF" as the destination.
- **Export Word**: a real .docx (headings, lists, tables, syntax-coloured code, images).
- The Code / Outputs / In-Out labels checkboxes and your edits apply to both exports.

## Notes
- Everything is bundled (marked, DOMPurify, highlight.js, KaTeX, docx); no network is needed.
- Notebook HTML is sanitized; scripts never run. Interactive outputs (Plotly, widgets, Bokeh) show a placeholder unless a static image was saved.
- Images referenced by relative path (not embedded) may not load from local folders.
