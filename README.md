<div align="center">
  <img src="assets/icon.png" width="120" alt="NEO">
  <h1>NEO</h1>
  <p><strong>A distraction-free word processor for authors</strong><br>forked to make your files first-class on disk and to import your work from anywhere.</p>
</div>

A fork of [NEO](https://github.com/hughhowey/neo) by Hugh Howey — the same quiet, book-first writing experience, with readable files, series tooling, and importers layered on top. MIT-licensed, like the original.

## Highlights

### Readable files on disk

NEO keeps your books as plain files. This fork names them so you — and other apps — can actually use them:

- Book folders become `The Mountain Kings — Jake/`, not `book-a8f3d2…`
- Chapters become `007 - The Dragon.html`, renamed as you retitle or reorder
- Right-click a chapter → **Reveal in Finder**; deletes go to the Trash, never gone

### Your library, anywhere you like

Your whole library is just a folder — and now you choose where it sits. Open **Goals & Settings** (⌘,) → **Library folder → Move…**, or **File → Library Location…**, pick a spot, and NEO moves every book there and remembers it. **Show in Finder** opens it any time.

Keeping the library outside **Documents**, **Desktop**, and **Downloads** — say in your home folder, Dropbox, or an external drive — also stops macOS from repeatedly asking an unsigned build for folder access.

### Series-aware naming

Give a book its number in a series, and every chapter names itself `series.chapter — title`:

```
1.01 The First Chapter.html
1.02 A Turn for the Worse.html
2.01 Book Two Begins.html
```

Perfect for anything that reads ordered files.

### Import from anywhere

- **Files or a folder → chapters.** One chapter per file, sorted by name, with leading order numbers (`7.01 `, `01 - `, `Chapter 3 - `) trimmed from the title automatically.
- **Scrivener projects.** Open a `.scriv` and a preview lets you map each part of the binder to _new book_, _notes_, or _skip_. A multi-book Draft splits into numbered books, Research becomes Notes, and the RTF is converted to clean prose — smart quotes, em dashes, and scene breaks intact.

### A custom icon

A letterpress drop-cap **N**.

## Download

Installers live on the [**Releases**](../../releases) page — `.dmg` for macOS, `.exe` for Windows. Both are unsigned personal builds, so on first launch: macOS → right-click the app → **Open**; Windows → _More info → Run anyway_.

## Build from source

Requires [Node.js](https://nodejs.org).

```sh
git clone git@github.com:in-shambles-productions/neo.git
cd neo
npm install
npm start
```

Package it yourself with `npm run package` (macOS) or `npm run package:win` (Windows); output lands in `dist/`.

## Credits

Built on [NEO](https://github.com/hughhowey/neo) by Hugh Howey. The original and this fork are both [MIT](LICENSE) licensed. Now go write.
