// NEO — main process
// Owns the window and all file-system access. The renderer talks to this
// through the IPC handlers below (see preload.js for the exposed API).

const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.setName('NEO'); // menu items read "Quit NEO" etc. (the packaged app already carries this)

// ---------------------------------------------------------------------------
// Library location: a folder of plain files the user can inspect, sync, back up.
// ---------------------------------------------------------------------------
// The library path is user-configurable (File → Library Location…). The choice
// is remembered in a tiny config file under userData — which is never in a
// TCC-protected place like ~/Documents — so an unsigned/ad-hoc build can read it
// with no macOS permission prompt, even before the library itself is reachable.
// Keeping the library out of Documents/Desktop/Downloads avoids those prompts.
const CONFIG_FILE = path.join(app.getPath('userData'), 'neo-config.json');
const DEFAULT_LIBRARY_DIR = path.join(os.homedir(), 'Documents', 'NEO Library');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (err) { logError('config', err); }
  return cfg;
}

let LIBRARY_DIR = readConfig().libraryDir || DEFAULT_LIBRARY_DIR;
let LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');

function ensureLibrary() {
  if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  if (!fs.existsSync(LIBRARY_FILE)) {
    const seed = {
      authorName: '',
      penNames: [],
      firstRunDone: false,
      shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
    };
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(seed, null, 2));
  }
}

function bookDir(bookId) {
  return path.join(LIBRARY_DIR, bookFolderName(bookId));
}

// ---------------------------------------------------------------------------
// Human-readable book folders. A book keeps its stable id, but on disk it lives
// in a "Title - Author" folder. A small main-owned index maps id -> folder,
// kept out of library.json so the renderer's library writes can't clobber it.
//   .bookfolders.json: { "book-abc": "The Scum Kings - Jake" }
// ---------------------------------------------------------------------------
let BOOK_FOLDERS_FILE = path.join(LIBRARY_DIR, '.bookfolders.json');
let _bfCache = { mtimeMs: -1, data: {} };

// Repoint every library-derived path after the user moves the library.
function applyLibraryDir(dir) {
  LIBRARY_DIR = dir;
  LIBRARY_FILE = path.join(dir, 'library.json');
  BOOK_FOLDERS_FILE = path.join(dir, '.bookfolders.json');
  _bfCache = { mtimeMs: -1, data: {} }; // cache belonged to the old dir — force a reread
}

// Move the whole library folder to a new location, keeping every file. Fast path
// is a rename (same volume); across volumes it copies then removes the original.
function moveLibrary(from, to) {
  const fromR = path.resolve(from);
  const toR = path.resolve(to);
  if (fromR === toR) return;
  const rel = path.relative(fromR, toR);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error('Can’t put the library inside itself — choose a different folder.');
  }
  if (fs.existsSync(toR) && fs.readdirSync(toR).length) {
    throw new Error('That folder already contains files. Choose an empty or new folder.');
  }
  if (!fs.existsSync(fromR)) { fs.mkdirSync(toR, { recursive: true }); return; } // nothing to move yet
  fs.mkdirSync(path.dirname(toR), { recursive: true });
  try {
    fs.renameSync(fromR, toR);
  } catch (err) {
    if (err.code === 'EXDEV') {            // different volume: copy across, then drop the original
      fs.cpSync(fromR, toR, { recursive: true });
      fs.rmSync(fromR, { recursive: true, force: true });
    } else { throw err; }
  }
}

function readBookFolders() {
  try {
    const st = fs.statSync(BOOK_FOLDERS_FILE);
    if (st.mtimeMs !== _bfCache.mtimeMs) {
      _bfCache = { mtimeMs: st.mtimeMs, data: readJSON(BOOK_FOLDERS_FILE, {}) || {} };
    }
    return _bfCache.data;
  } catch { return {}; }
}

function writeBookFolders(map) {
  ensureLibrary();
  writeJSON(BOOK_FOLDERS_FILE, map);
  try { _bfCache = { mtimeMs: fs.statSync(BOOK_FOLDERS_FILE).mtimeMs, data: map }; } catch { /* ignore */ }
}

// Current on-disk folder for a book; unmapped (legacy) books fall back to the id.
function bookFolderName(bookId) {
  const map = readBookFolders();
  return map[bookId] || bookId;
}

// "Title - Author", filesystem-safe (safeBase(), defined below, strips illegal chars).
function bookFolderBase(meta) {
  const title = safeBase(meta && meta.title) || 'Untitled';
  const author = safeBase(meta && meta.author);
  let s = author ? `${title} - ${author}` : title;
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s;
}

// Two-phase directory rename so a name-swap can't clobber.
function applyFolderRenames(root, plan) {
  const staged = [];
  plan.forEach((r, k) => {
    if (r.from === r.to || !fs.existsSync(path.join(root, r.from))) return;
    const tmp = path.join(root, `.neo-book-tmp-${k}`);
    fs.renameSync(path.join(root, r.from), tmp);
    staged.push({ tmp, to: path.join(root, r.to) });
  });
  staged.forEach((s) => { if (!fs.existsSync(s.to)) fs.renameSync(s.tmp, s.to); });
}

// Rename one book's folder to match its title/author, updating the index.
// A no-op (no disk write) when the folder is already correctly named.
function reconcileOneBookFolder(meta) {
  if (!meta || !meta.id) return;
  const map = readBookFolders();
  const curFolder = map[meta.id] || meta.id;
  const base = bookFolderBase(meta);
  const taken = new Set(
    Object.keys(map).filter((k) => k !== meta.id).map((k) => String(map[k]).toLowerCase())
  );
  let name = base, n = 2;
  while (taken.has(name.toLowerCase())) name = `${base} (${n++})`;
  if (name === curFolder && map[meta.id]) return;
  if (name !== curFolder && fs.existsSync(path.join(LIBRARY_DIR, curFolder))
      && !fs.existsSync(path.join(LIBRARY_DIR, name))) {
    fs.renameSync(path.join(LIBRARY_DIR, curFolder), path.join(LIBRARY_DIR, name));
  }
  writeBookFolders({ ...map, [meta.id]: name });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic-ish: never leave a half-written file
}

// ---------------------------------------------------------------------------
// IPC — the renderer's whole view of the disk
// ---------------------------------------------------------------------------

ipcMain.handle('library:read', () => {
  ensureLibrary();
  return readJSON(LIBRARY_FILE, null);
});

ipcMain.handle('library:write', (_e, data) => {
  ensureLibrary();
  writeJSON(LIBRARY_FILE, data);
  return true;
});

// A book is a folder: book.json + chapters/*.html + notes.html + outline.html + darlings.json
ipcMain.handle('book:create', (_e, meta) => {
  ensureLibrary();
  const id = 'book-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const dir = bookDir(id);
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  const book = {
    id,
    title: meta.title || 'Untitled',
    subtitle: '',
    series: '',
    author: meta.author || 'Anonymous',
    wordGoal: 0,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    chapterOrder: [],
    tabNames: { notes: 'Notes', outline: 'Outline' }
  };
  writeJSON(path.join(dir, 'book.json'), book);
  fs.writeFileSync(path.join(dir, 'notes.html'), '');
  fs.writeFileSync(path.join(dir, 'outline.html'), '');
  writeJSON(path.join(dir, 'darlings.json'), []);
  writeJSON(path.join(dir, 'stickies.json'), []);
  reconcileOneBookFolder(book); // name the folder "Untitled - Author" from the start
  return book;
});

ipcMain.handle('book:readMeta', (_e, bookId) => {
  return readJSON(path.join(bookDir(bookId), 'book.json'), null);
});

ipcMain.handle('book:writeMeta', (_e, bookId, meta) => {
  meta.modified = new Date().toISOString();
  writeJSON(path.join(bookDir(bookId), 'book.json'), meta);
  reconcileOneBookFolder(meta); // keep the folder name matching the title
  return true;
});

// Normalize every book folder on disk to its human name (startup migration).
// Rebuilt from a scan, so it self-heals and drops entries for deleted books.
ipcMain.handle('books:reconcileFolders', () => {
  ensureLibrary();
  let entries;
  try { entries = fs.readdirSync(LIBRARY_DIR, { withFileTypes: true }); }
  catch { return {}; }
  const skip = new Set(['Backups', 'Exports']);
  const books = [];
  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.') || skip.has(d.name)) continue;
    const meta = readJSON(path.join(LIBRARY_DIR, d.name, 'book.json'), null);
    if (meta && meta.id) books.push({ id: meta.id, curFolder: d.name, meta });
  }
  const map = {};
  const taken = new Set();
  const plan = [];
  for (const b of books) {
    const base = bookFolderBase(b.meta);
    let name = base, n = 2;
    while (taken.has(name.toLowerCase())) name = `${base} (${n++})`;
    taken.add(name.toLowerCase());
    map[b.id] = name;
    if (name !== b.curFolder) plan.push({ from: b.curFolder, to: name });
  }
  applyFolderRenames(LIBRARY_DIR, plan);
  writeBookFolders(map);
  return map;
});

// ---------------------------------------------------------------------------
// First-class files: chapters live on disk under human-readable names, so the
// chapters folder is a clean, Finder-native set of files other tools can read
// directly — no export step. NEO still keys chapters by a stable internal id;
// this layer just maps that id to a pretty filename.
//   book.json.chapterFiles: { [chapterId]: "007 - The Dragon.html" }
// ---------------------------------------------------------------------------
function chaptersDir(bookId) {
  return path.join(bookDir(bookId), 'chapters');
}

function bookMeta(bookId) {
  return readJSON(path.join(bookDir(bookId), 'book.json'), null);
}

// Current on-disk filename for a chapter (legacy books fall back to id.html).
function chapterFileName(bookId, chapterId) {
  const meta = bookMeta(bookId);
  const map = (meta && meta.chapterFiles) || {};
  return map[chapterId] || (chapterId + '.html');
}

// A filesystem-safe, human-readable base derived from a chapter title.
function safeBase(name) {
  let s = (name == null ? '' : String(name));
  s = s.replace(/[\/:]/g, ' ');       // '/' and ':' are illegal in macOS/Finder names
  s = s.replace(/[\x00-\x1f]/g, ' '); // control characters
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[ .]+$/, ''); // no leading dots, no trailing dot/space
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

// Desired filename base (no extension) for the chapter at 0-based index i.
// A numeric prefix keeps Finder's sort matching NEO's order and stays unique
// even when two chapters share a title. When the book has a series number
// (its "Book #"), chapters are named "{book}.{episode} Title" — e.g. a Book 7
// gives "7.01 Title", "7.02 Title" — matching a podcast season.episode scheme.
function chapterBase(i, title, seriesNumber) {
  // A title sometimes already carries an ordering prefix (e.g. an imported
  // "7.09 Foo"); strip it so the numeric prefix we add below can't double it
  // into "7.09 7.09 Foo". stripOrderingPrefix leaves real titles ("1984") alone.
  let t = safeBase(title);
  if (t) t = stripOrderingPrefix(t);
  const season = Number(seriesNumber);
  if (Number.isFinite(season) && season > 0) {
    const ep = String(i + 1).padStart(2, '0');
    return t ? `${season}.${ep} ${t}` : `${season}.${ep}`;
  }
  const prefix = String(i + 1).padStart(3, '0');
  return t ? `${prefix} - ${t}` : `${prefix} - Chapter ${i + 1}`;
}

// Pure: desired rename plan + resulting id->file map. The executor below makes
// it collision-safe, so this only states intent.
function planReconcile(order, titles, existing, seriesNumber) {
  existing = existing || {};
  titles = titles || {};
  const newMap = {};
  const renames = [];
  order.forEach((id, i) => {
    const to = chapterBase(i, titles[id], seriesNumber) + '.html';
    const from = existing[id] || (id + '.html');
    newMap[id] = to;
    if (from !== to) renames.push({ id, from, to });
  });
  return { renames, newMap };
}

// Two-phase rename so an order-swap can't clobber: stage each source under a
// unique temp name, then move every temp into place.
function applyRenames(dir, renames) {
  const staged = [];
  renames.forEach((r, k) => {
    const tmp = path.join(dir, `.neo-reconcile-${k}.html`);
    const has = fs.existsSync(path.join(dir, r.from));
    if (has) fs.renameSync(path.join(dir, r.from), tmp);
    staged.push({ tmp, has, to: r.to });
  });
  staged.forEach((s) => {
    if (s.has) fs.renameSync(s.tmp, path.join(dir, s.to));
  });
}

ipcMain.handle('chapter:read', (_e, bookId, chapterId) => {
  try {
    return fs.readFileSync(path.join(chaptersDir(bookId), chapterFileName(bookId, chapterId)), 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('chapter:write', (_e, bookId, chapterId, html) => {
  const dir = chaptersDir(bookId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, chapterFileName(bookId, chapterId)), html);
  return true;
});

ipcMain.handle('chapter:delete', async (_e, bookId, chapterId) => {
  const p = path.join(chaptersDir(bookId), chapterFileName(bookId, chapterId));
  if (fs.existsSync(p)) {
    try { await shell.trashItem(p); }   // recoverable from Finder's Trash — words are never lost
    catch { try { fs.unlinkSync(p); } catch { /* already gone */ } }
  }
  return true;
});

// Make the chapters folder match NEO's order + titles: rename files to
// human-readable names. Returns the new id->file map for the renderer to
// persist in book.json.
ipcMain.handle('chapters:reconcile', (_e, bookId, order, titles, seriesNumber) => {
  const dir = chaptersDir(bookId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const meta = bookMeta(bookId);
  const existing = (meta && meta.chapterFiles) || {};
  const { renames, newMap } = planReconcile(order || [], titles || {}, existing, seriesNumber);
  applyRenames(dir, renames);
  return newMap;
});

// Reveal a chapter's file in Finder (falls back to the folder) — the file
// another app can pick up directly.
ipcMain.handle('chapter:reveal', (_e, bookId, chapterId) => {
  const dir = chaptersDir(bookId);
  const p = path.join(dir, chapterFileName(bookId, chapterId));
  if (fs.existsSync(p)) { shell.showItemInFolder(p); return true; }
  if (fs.existsSync(dir)) shell.showItemInFolder(dir);
  return true;
});

ipcMain.handle('aux:read', (_e, bookId, name) => {
  // name: 'notes' | 'outline'
  const file = path.join(bookDir(bookId), name + '.html');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('aux:write', (_e, bookId, name, html) => {
  fs.writeFileSync(path.join(bookDir(bookId), name + '.html'), html);
  return true;
});

ipcMain.handle('json:read', (_e, bookId, name, fallback) => {
  return readJSON(path.join(bookDir(bookId), name + '.json'), fallback);
});

ipcMain.handle('json:write', (_e, bookId, name, data) => {
  writeJSON(path.join(bookDir(bookId), name + '.json'), data);
  return true;
});

ipcMain.handle('book:delete', async (_e, bookId, title) => {
  const win = BrowserWindow.getFocusedWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Move to Trash'],
    defaultId: 0,
    cancelId: 0,
    message: `Move “${title}” to the Trash?`,
    detail: 'The book folder will go to your Mac Trash, so you can recover it.'
  });
  if (response === 1) {
    await shell.trashItem(bookDir(bookId));
    const map = readBookFolders();
    if (map[bookId]) { const next = { ...map }; delete next[bookId]; writeBookFolders(next); }
    return true;
  }
  return false;
});

ipcMain.handle('library:path', () => LIBRARY_DIR);

// Reveal the library folder in Finder.
ipcMain.handle('library:reveal', () => {
  try { ensureLibrary(); shell.openPath(LIBRARY_DIR); } catch (err) { logError('library-reveal', err); }
  return true;
});

// Pick a new home for the library and move it there. A tip in the dialog steers
// users away from ~/Documents (and Desktop/Downloads) so macOS stops prompting.
ipcMain.handle('library:pick', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for your NEO library',
    message: 'Your books move here and NEO uses it from now on. Tip: a spot outside Documents, Desktop and Downloads avoids macOS permission prompts.',
    buttonLabel: 'Use This Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return { canceled: true };
  // Drop the library into the chosen folder as "NEO Library" unless they pointed
  // straight at such a folder (so we never nest "NEO Library/NEO Library").
  let target = filePaths[0];
  if (path.basename(target) !== 'NEO Library') target = path.join(target, 'NEO Library');
  if (path.resolve(target) === path.resolve(LIBRARY_DIR)) return { unchanged: true, path: LIBRARY_DIR };
  try {
    moveLibrary(LIBRARY_DIR, target);
  } catch (err) {
    logError('library-move', err);
    return { error: String(err.message || err) };
  }
  applyLibraryDir(target);
  writeConfig({ libraryDir: target });
  return { path: target };
});

// ---------------------------------------------------------------------------
// Fullscreen + The Silo
// ---------------------------------------------------------------------------

// The Silo means it: kiosk mode (no Dock, no menu bar, no hover-reveal)
// plus always-on-top at screen-saver level across every workspace — so even
// app-switching leaves NEO covering the screen. The typed prompt is the way out.
ipcMain.handle('silo:set', (e, on) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  win.__silo = on;
  if (on) {
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setKiosk(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.focus();
  } else {
    win.setAlwaysOnTop(false);
    win.setKiosk(false);
  }
  return true;
});

// Regular fullscreen: Esc walks you out like any civilized app
ipcMain.handle('fullscreen:escape', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && win.isFullScreen()) {
    win.setFullScreen(false);
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Export + email
// ---------------------------------------------------------------------------

async function renderPDF(html) {
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await pdfWin.webContents.printToPDF({
      pageSize: 'Letter',
      margins: { top: 1, bottom: 1, left: 1, right: 1 },
      printBackground: false
    });
  } finally {
    pdfWin.destroy();
  }
}

// zipEntries: [{path, content, base64?, store?}] — order matters (EPUB mimetype first)
async function buildZip(zipEntries) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  for (const e of zipEntries) {
    zip.file(e.path, e.base64 ? Buffer.from(e.content, 'base64') : e.content, {
      compression: e.store ? 'STORE' : 'DEFLATE'
    });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/epub+zip'
  });
}

ipcMain.handle('export:save', async (_e, { format, defaultName, content, zipEntries }) => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(os.homedir(), 'Documents', defaultName + '.' + format),
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  });
  if (canceled || !filePath) return null;
  if (zipEntries) {
    fs.writeFileSync(filePath, await buildZip(zipEntries));
  } else if (format === 'pdf') {
    fs.writeFileSync(filePath, await renderPDF(content));
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return filePath;
});

// Writes a timestamped snapshot to the library's Exports folder, then hands it
// to your email — an outside-the-machine paper trail for provenance.
ipcMain.handle('email:draft', async (_e, { to, subject, body, html, defaultName, method }) => {
  const { shell } = require('electron');
  const exportsDir = path.join(LIBRARY_DIR, 'Exports');
  if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(exportsDir, `${defaultName}-${stamp}.pdf`);
  fs.writeFileSync(file, await renderPDF(html));

  if (method === 'gmail') {
    // Gmail compose in the browser can't take an attachment from outside,
    // so open the draft pre-filled and reveal the PDF right next to it to drag in.
    const url = 'https://mail.google.com/mail/?view=cm&fs=1'
      + '&to=' + encodeURIComponent(to)
      + '&su=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(body);
    await shell.openExternal(url);
    shell.showItemInFolder(file);
    return { ok: true, method: 'gmail', file };
  }

  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
    tell application "Mail"
      set msg to make new outgoing message with properties {subject:"${esc(subject)}", content:"${esc(body)}" & return & return, visible:true}
      tell msg to make new to recipient at end of to recipients with properties {address:"${esc(to)}"}
      tell msg to make new attachment with properties {file name:(POSIX file "${esc(file)}")} at after the last paragraph of content
      activate
    end tell`;
  return new Promise((resolve) => {
    require('child_process').execFile('osascript', ['-e', script], (err) => {
      if (err) {
        // Mail not available — at least reveal the snapshot we saved
        shell.showItemInFolder(file);
        resolve({ ok: false, file });
      } else {
        resolve({ ok: true, method: 'mail', file });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Import: .docx / .txt / .md → chapters
// ---------------------------------------------------------------------------

const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// "Chapter N"-style headings start new chapters; lines of asterisks are scene breaks.
const isChapterHeading = (t) => /^(chapter|prologue|epilogue|part)\b/i.test(t) && t.length < 60;
const isSceneBreak = (t) => /^([*#•~]\s*){1,7}$/.test(t);

// Strip a leading ordering token from a filename-derived title ("7.01 Foo" -> "Foo",
// "Chapter 3 - Bar" -> "Bar"). Files sort by that prefix and NEO numbers chapters itself,
// so it is noise in the title. Leaves real titles ("1984", "The 39 Steps") untouched.
function stripOrderingPrefix(name) {
  const m = String(name).match(/^\s*(?:(?:chapter|chap|ch|part|pt|episode|ep|scene|sc)\b\.?\s*)?\d+(?:[.\-]\d+)*\s*[-–—.:)\]]?\s+(.+)$/i);
  if (m) { const rest = m[1].trim(); if (/[A-Za-z]/.test(rest)) return rest; }
  return String(name).trim();
}

// Read a manuscript file into a flat list of paragraphs ({text}, with pageBreak flags).
async function readParas(fp) {
  const name = path.basename(fp).replace(/\.[^.]+$/, '');
  const ext = path.extname(fp).toLowerCase();
  let paras = [];

  if (ext === '.docx') {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(fp));
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Not a valid .docx: ' + fp);
    const xml = await docFile.async('string');
    paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => {
      const p = m[0];
      const text = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map((t) => decodeEntities(t[1])).join('');
      const pageBreak = /<w:br [^>]*w:type="page"/.test(p) || /<w:pageBreakBefore/.test(p);
      return { text: text.trim(), pageBreak };
    });
  } else {
    const raw = fs.readFileSync(fp, 'utf8');
    paras = raw.split(/\r?\n\s*\r?\n/)
      .map((b) => ({ text: b.replace(/\s*\r?\n\s*/g, ' ').trim(), pageBreak: false }))
      .filter((p) => p.text);
  }
  return { name, paras };
}

// Whole-manuscript import: split ONE file into multiple chapters.
async function importFile(fp) {
  const { name, paras } = await readParas(fp);
  const chapters = [];
  let cur = [];
  for (const p of paras) {
    if (!p.text && !p.pageBreak) continue;
    if ((p.pageBreak || isChapterHeading(p.text)) && cur.length) {
      chapters.push(cur);
      cur = [];
    }
    if (isChapterHeading(p.text)) continue; // the heading line itself becomes the chapter head
    if (isSceneBreak(p.text)) { cur.push({ scene: true }); continue; }
    if (p.text) cur.push({ text: p.text });
  }
  if (cur.length) chapters.push(cur);
  if (!chapters.length) chapters.push([{ text: '' }]);
  return { name, chapters };
}

// Chapter import: one file becomes exactly ONE chapter (scene breaks preserved).
async function fileAsChapter(fp) {
  const { name, paras } = await readParas(fp);
  const body = [];
  for (const p of paras) {
    if (!p.text) continue;
    if (isSceneBreak(p.text)) body.push({ scene: true });
    else body.push({ text: p.text });
  }
  return { title: stripOrderingPrefix(name), paras: body.length ? body : [{ text: '' }] };
}

ipcMain.handle('import:pick', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Bring your manuscripts home',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Manuscripts', extensions: ['docx', 'txt', 'md'] }]
  });
  if (canceled || !filePaths.length) return [];
  const out = [];
  for (const fp of filePaths) {
    try {
      out.push(await importFile(fp));
    } catch (err) {
      logError('import', err);
      out.push({ name: path.basename(fp), error: String(err.message || err) });
    }
  }
  return out;
});

// Extensions accepted for "import as chapters".
const CHAPTER_EXTS = ['docx', 'txt', 'md', 'markdown', 'text'];

// Import picked files as chapters — one chapter per file.
ipcMain.handle('import:filesAsChapters', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import files as chapters',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Text & Word', extensions: CHAPTER_EXTS }]
  });
  if (canceled || !filePaths.length) return { items: [] };
  const items = [];
  for (const fp of [...filePaths].sort()) {
    try { items.push(await fileAsChapter(fp)); }
    catch (err) { logError('import', err); items.push({ title: path.basename(fp), error: String(err.message || err) }); }
  }
  return { items };
});

// Import a folder — every supported file inside (sorted by name) becomes a chapter.
ipcMain.handle('import:folderAsChapters', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import a folder — each file becomes a chapter',
    properties: ['openDirectory']
  });
  if (canceled || !filePaths.length) return { items: [] };
  const dir = filePaths[0];
  const names = fs.readdirSync(dir)
    .filter((n) => !n.startsWith('.') && CHAPTER_EXTS.includes(path.extname(n).toLowerCase().slice(1)))
    .sort();
  const items = [];
  for (const n of names) {
    try { items.push(await fileAsChapter(path.join(dir, n))); }
    catch (err) { logError('import', err); items.push({ title: n, error: String(err.message || err) }); }
  }
  return { items, folderName: path.basename(dir) };
});

// ---------------------------------------------------------------------------
// Scrivener import: parse the .scrivx binder; each document's text is RTF at
// Files/Data/<UUID>/content.rtf. Draft docs become chapters, the rest Notes.
// ---------------------------------------------------------------------------
const CP1252 = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
  0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š', 0x8B: '‹',
  0x8C: 'Œ', 0x8E: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”',
  0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9A: 'š',
  0x9B: '›', 0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ' };
const cp1252 = (code) => CP1252[code] || String.fromCharCode(code);
const RTF_SKIP_DEST = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header',
  'footer', 'expandedcolortbl', 'filetbl', 'listtable', 'listoverridetable', 'rsidtbl',
  'generator', 'datastore', 'themedata', 'colorschememapping', 'latentstyles', 'fldinst']);

// Cocoa/Scrivener RTF -> plain paragraphs (paragraph break = \par, \line, or \-newline).
function rtfToParagraphs(rtf) {
  const paras = [];
  let cur = '';
  const stack = [{ skip: false }];
  const skipping = () => stack.some((g) => g.skip);
  const flush = () => { const t = cur.replace(/[ \t]+/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim(); if (t) paras.push(t); cur = ''; };
  const n = rtf.length;
  let i = 0;
  while (i < n) {
    const c = rtf[i];
    if (c === '{') { stack.push({ skip: false }); i++; continue; }
    if (c === '}') { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === '\\') {
      const nx = rtf[i + 1];
      if (nx === "'") { const code = parseInt(rtf.substr(i + 2, 2), 16); if (!skipping()) cur += cp1252(code); i += 4; continue; }
      if (nx === '\\' || nx === '{' || nx === '}') { if (!skipping()) cur += nx; i += 2; continue; }
      if (nx === '\n' || nx === '\r') { flush(); i += 2; continue; }
      if (nx === '~') { if (!skipping()) cur += ' '; i += 2; continue; }
      if (nx === '*') { stack[stack.length - 1].skip = true; i += 2; continue; }
      let j = i + 1, word = '';
      while (j < n && /[a-zA-Z]/.test(rtf[j])) { word += rtf[j]; j++; }
      let num = '';
      if (rtf[j] === '-') { num += '-'; j++; }
      while (j < n && /[0-9]/.test(rtf[j])) { num += rtf[j]; j++; }
      if (rtf[j] === ' ') j++;
      if (word === 'par' || word === 'line') flush();
      else if (word === 'tab') { if (!skipping()) cur += ' '; }
      else if (word === 'u') {
        let code = parseInt(num, 10);
        if (!skipping() && !isNaN(code)) { if (code < 0) code += 65536; cur += String.fromCodePoint(code); }
        if (rtf[j] && !'\\{}'.includes(rtf[j])) j++;
      } else if (RTF_SKIP_DEST.has(word)) {
        stack[stack.length - 1].skip = true;
      }
      i = j; continue;
    }
    if (c === '\n' || c === '\r') { i++; continue; }
    if (!skipping()) cur += c;
    i++;
  }
  flush();
  return paras;
}

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}

// Read a Scrivener document's RTF into a {title, paras} chapter (scene breaks kept).
function scrivDocToChapter(scrivDir, uuid, title) {
  let paras = [];
  try {
    const rtf = fs.readFileSync(path.join(scrivDir, 'Files', 'Data', uuid, 'content.rtf'), 'latin1');
    paras = rtfToParagraphs(rtf).map((t) => (isSceneBreak(t) ? { scene: true } : { text: t }));
  } catch { /* empty/missing document */ }
  // Match fileAsChapter: drop a leading ordering prefix from the binder title
  // ("7.01 Foo" -> "Foo") — NEO numbers chapters itself, so it is noise here.
  return { title: stripOrderingPrefix(title || 'Untitled'), paras: paras.length ? paras : [{ text: '' }] };
}

// Build the binder as a nested tree of { uuid, type, title, children }.
function scrivBinderTree(scrivDir) {
  const scrivx = fs.readdirSync(scrivDir).find((f) => f.toLowerCase().endsWith('.scrivx'));
  if (!scrivx) throw new Error('Not a Scrivener project (no .scrivx found)');
  const xml = fs.readFileSync(path.join(scrivDir, scrivx), 'utf8');
  const b0 = xml.indexOf('<Binder>');
  const b1 = xml.indexOf('</Binder>');
  const binder = xml.slice(b0 < 0 ? 0 : b0, b1 < 0 ? xml.length : b1);
  const root = { children: [] };
  const stack = [root];
  const re = /<BinderItem\b([^>]*?)(\/?)>|<\/BinderItem>|<Title>([\s\S]*?)<\/Title>/g;
  let m;
  while ((m = re.exec(binder))) {
    if (m[0] === '</BinderItem>') { if (stack.length > 1) stack.pop(); continue; }
    if (m[3] !== undefined) { if (stack.length > 1) stack[stack.length - 1].title = decodeXmlEntities(m[3].trim()); continue; }
    const attrs = m[1] || '';
    const node = {
      uuid: (attrs.match(/UUID="([^"]+)"/) || [])[1] || '',
      type: (attrs.match(/Type="([^"]+)"/) || [])[1] || '',
      title: '', children: []
    };
    stack[stack.length - 1].children.push(node);
    if (m[2] !== '/') stack.push(node);
  }
  return root;
}

// Every Text descendant of a node, in reading order.
function scrivTextDocs(node, out) {
  out = out || [];
  for (const c of node.children) {
    if (c.type === 'Text' && c.uuid) out.push(c);
    if (c.children.length) scrivTextDocs(c, out);
  }
  return out;
}

// Scan a picked project into top-level sections for the import preview (no RTF yet).
ipcMain.handle('scrivener:scan', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import a Scrivener project',
    properties: ['openFile'],
    filters: [{ name: 'Scrivener Project', extensions: ['scriv'] }]
  });
  if (canceled || !filePaths.length) return null;
  try {
    const dir = filePaths[0];
    const root = scrivBinderTree(dir);
    const draft = root.children.find((c) => c.type === 'DraftFolder');
    const sections = [];
    const add = (c, region) => sections.push({ uuid: c.uuid, title: c.title || 'Untitled', type: c.type, textCount: scrivTextDocs(c).length, region });
    if (draft) draft.children.forEach((c) => add(c, 'draft'));
    root.children.forEach((c) => { if (c !== draft && c.type !== 'TrashFolder') add(c, 'other'); });
    const title = (draft && draft.title) || path.basename(dir).replace(/\.scriv$/i, '');
    return { path: dir, title, sections: sections.filter((s) => s.textCount > 0) };
  } catch (err) { logError('import', err); return { error: String(err.message || err) }; }
});

// Extract the user's plan into books + notes, loading RTF only for chosen sections.
ipcMain.handle('scrivener:extract', async (_e, scrivDir, plan) => {
  try {
    const root = scrivBinderTree(scrivDir);
    const byUuid = {};
    (function idx(node) { for (const c of node.children) { if (c.uuid) byUuid[c.uuid] = c; idx(c); } })(root);
    const books = [], notes = [];
    for (const p of (plan || [])) {
      const node = byUuid[p.uuid];
      if (!node || p.action === 'skip') continue;
      const docs = scrivTextDocs(node);
      if (p.action === 'book') books.push({ title: node.title || 'Untitled', chapters: docs.map((d) => scrivDocToChapter(scrivDir, d.uuid, d.title)) });
      else if (p.action === 'notes') docs.forEach((d) => notes.push(scrivDocToChapter(scrivDir, d.uuid, d.title)));
    }
    return { books, notes };
  } catch (err) { logError('import', err); return { error: String(err.message || err) }; }
});

// ---------------------------------------------------------------------------
// AI cover (experiment): chapter 1 -> local Ollama art prompt -> local mflux.
// ---------------------------------------------------------------------------
const OLLAMA_MODEL = 'qwen2.5:7b';
const MFLUX_BIN = '/Users/jake/apps/youtubify/.venv-mflux/bin/mflux-generate-flux2';

function chapterPlainText(bookId, chapterId, max = 1600) {
  try {
    const html = fs.readFileSync(path.join(chaptersDir(bookId), chapterFileName(bookId, chapterId)), 'utf8');
    return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, max);
  } catch { return ''; }
}

function ollamaGenerate(prompt) {
  return new Promise((resolve, reject) => {
    // keep_alive: 0 unloads the LLM right after, freeing memory before mflux paints.
    const data = JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, keep_alive: 0, options: { temperature: 0.8 } });
    const req = require('http').request(
      { hostname: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => { try { resolve((JSON.parse(out).response || '').trim()); } catch (e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function mfluxCover(prompt, outPath) {
  return new Promise((resolve, reject) => {
    const args = ['--model', 'flux2-klein-4b', '--quantize', '8', '--prompt', prompt,
      '--width', '832', '--height', '1216', '--steps', '4', '--guidance', '1.0', '--output', outPath];
    const proc = require('child_process').spawn(MFLUX_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 && fs.existsSync(outPath) ? resolve(outPath) : reject(new Error('mflux exited ' + code + ': ' + err.slice(-160)))));
  });
}

// Read chapter 1, ask the LLM for an art prompt, paint a cover with the title baked in.
ipcMain.handle('cover:generate', async (_e, bookId) => {
  try {
    const meta = bookMeta(bookId);
    if (!meta) return { error: 'book not found' };
    const ch0 = (meta.chapterOrder || [])[0];
    const text = ch0 ? chapterPlainText(bookId, ch0) : '';
    if (text.length < 40) return { error: 'Chapter 1 is too short to inspire a cover.' };
    const instructions = 'You are a book-cover art director. Read this opening passage from a novel and write ONE vivid image-generation prompt for its cover. Describe the setting, mood, main subject, and color palette in 2-3 cinematic sentences, illustrated-book-cover style. Do NOT put any text, letters, or words in the image. Reply with ONLY the prompt.';
    const scene = await ollamaGenerate(`${instructions}\n\nOpening:\n${text}`);
    if (!scene) return { error: 'the model returned no prompt' };
    const title = (meta.title && meta.title !== 'Untitled') ? meta.title : '';
    const typography = title
      ? ` Portrait book cover illustration, painterly, with the title "${title}" in large elegant serif lettering near the top${meta.author ? ` and "${meta.author}" in small letters near the bottom` : ''}, cohesive cinematic color palette, professional book cover design.`
      : ' Portrait book cover illustration, painterly, cinematic, professional book cover design.';
    await mfluxCover(scene + typography, path.join(bookDir(bookId), 'cover.png'));
    return { ok: true, prompt: scene };
  } catch (err) { logError('cover', err); return { error: String(err.message || err) }; }
});

// Current cover as a data URL (resolves the live folder, so it survives renames).
ipcMain.handle('cover:read', (_e, bookId) => {
  try {
    const p = path.join(bookDir(bookId), 'cover.png');
    return fs.existsSync(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : null;
  } catch { return null; }
});

// ---------------------------------------------------------------------------
// Robustness: error log, daily backups, single instance
// ---------------------------------------------------------------------------
const ERROR_LOG = () => path.join(LIBRARY_DIR, 'neo-errors.log');

function logError(source, err) {
  try {
    ensureLibrary();
    const line = `[${new Date().toISOString()}] [${source}] ${err && err.stack ? err.stack : String(err)}\n`;
    fs.appendFileSync(ERROR_LOG(), line);
  } catch { /* never let logging crash the app */ }
}

process.on('uncaughtException', (err) => logError('main', err));
process.on('unhandledRejection', (err) => logError('main-promise', err));
ipcMain.handle('log:error', (_e, msg) => logError('renderer', msg));

// One zip of the whole library per day, keeping the last 14. Cheap insurance.
async function dailyBackup() {
  try {
    ensureLibrary();
    const backupsDir = path.join(LIBRARY_DIR, 'Backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const target = path.join(backupsDir, `neo-backup-${today}.zip`);
    if (fs.existsSync(target)) return;

    const JSZip = require('jszip');
    const zip = new JSZip();
    const skip = new Set(['Backups', 'Exports']);
    const walk = (dir, rel) => {
      for (const name of fs.readdirSync(dir)) {
        if (rel === '' && skip.has(name)) continue;
        const full = path.join(dir, name);
        const relPath = rel ? rel + '/' + name : name;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, relPath);
        else zip.file(relPath, fs.readFileSync(full));
      }
    };
    walk(LIBRARY_DIR, '');
    fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

    // prune old backups
    const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith('neo-backup-')).sort();
    while (backups.length > 14) fs.unlinkSync(path.join(backupsDir, backups.shift()));
  } catch (err) {
    logError('backup', err);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The engine is available, but every editable element starts with
      // spellcheck="false" — NEO never nags. A spellcheck pass is a
      // deliberate act (Edit → Spellcheck Pass), not a klaxon.
      spellcheck: true
    }
  });
  win.loadFile('index.html');

  // The Silo holds the door: if focus escapes (⌘Tab), pull it straight back.
  win.on('blur', () => {
    if (!win.__silo || win.isDestroyed()) return;
    setTimeout(() => {
      if (win.__silo && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    }, 60);
  });

  // Right-click suggestions during a spellcheck pass
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.misspelledWord) return;
    const menu = new Menu();
    for (const s of (params.dictionarySuggestions || []).slice(0, 6)) {
      menu.append(new MenuItem({ label: s, click: () => win.webContents.replaceMisspelling(s) }));
    }
    if (params.dictionarySuggestions && params.dictionarySuggestions.length) {
      menu.append(new MenuItem({ type: 'separator' }));
    }
    menu.append(new MenuItem({
      label: `Add “${params.misspelledWord}” to Dictionary`,
      click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
    }));
    menu.popup();
  });
}

// ---------------------------------------------------------------------------
// Application menu — Help and Format live here, out of the writing room
// ---------------------------------------------------------------------------
function sendToWindow(msg) {
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (w) w.webContents.send('menu', msg);
}

function buildMenu() {
  const bodyFonts = ['Georgia', 'Palatino', 'Baskerville', 'Hoefler Text', 'Iowan Old Style'];
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'Export',
          submenu: [
            { label: 'Plain Text (.txt)', click: () => sendToWindow({ type: 'export', format: 'txt' }) },
            { label: 'Markdown (.md)', click: () => sendToWindow({ type: 'export', format: 'md' }) },
            { label: 'Web Page (.html)', click: () => sendToWindow({ type: 'export', format: 'html' }) },
            { label: 'PDF (.pdf)', click: () => sendToWindow({ type: 'export', format: 'pdf' }) },
            { label: 'Word (.docx)', click: () => sendToWindow({ type: 'export', format: 'docx' }) },
            { label: 'EPUB (.epub)', click: () => sendToWindow({ type: 'export', format: 'epub' }) }
          ]
        },
        { type: 'separator' },
        {
          label: 'Email Draft to Myself',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendToWindow({ type: 'emailDraft' })
        },
        { label: 'Email Settings…', click: () => sendToWindow({ type: 'emailSettings' }) },
        {
          label: 'Goals & Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendToWindow({ type: 'stats' })
        },
        { label: 'Library Location…', click: () => sendToWindow({ type: 'libraryLocation' }) },
        { type: 'separator' },
        {
          label: 'Import Manuscripts…',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => sendToWindow({ type: 'import' })
        },
        { label: 'Import Files as Chapters…', click: () => sendToWindow({ type: 'importChapters', mode: 'files' }) },
        { label: 'Import Folder as Chapters…', click: () => sendToWindow({ type: 'importChapters', mode: 'folder' }) },
        { label: 'Import Scrivener Project…', click: () => sendToWindow({ type: 'importScrivener' }) },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find & Replace',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToWindow({ type: 'find' })
        },
        {
          label: 'Spellcheck Pass',
          accelerator: 'CmdOrCtrl+;',
          click: () => sendToWindow({ type: 'spellcheck' })
        }
      ]
    },
    {
      label: 'Format',
      submenu: [
        {
          label: 'Body Font',
          submenu: bodyFonts.map((f) => ({
            label: f,
            click: () => sendToWindow({ type: 'bodyFont', value: f })
          }))
        },
        {
          label: 'Drop Cap Style',
          submenu: [
            { label: 'Literary', click: () => sendToWindow({ type: 'dropCap', value: 'literary' }) },
            { label: 'Fantasy', click: () => sendToWindow({ type: 'dropCap', value: 'fantasy' }) },
            { label: 'Sci-Fi', click: () => sendToWindow({ type: 'dropCap', value: 'scifi' }) }
          ]
        },
        {
          label: 'Page',
          submenu: [
            { label: 'Paper', click: () => sendToWindow({ type: 'pageTheme', value: 'paper' }) },
            { label: 'Night', click: () => sendToWindow({ type: 'pageTheme', value: 'night' }) }
          ]
        },
        { type: 'separator' },
        { label: 'Larger Text', accelerator: 'CmdOrCtrl+=', click: () => sendToWindow({ type: 'fontSize', value: 1 }) },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: () => sendToWindow({ type: 'fontSize', value: -1 }) },
        { label: 'Reset Text Size', accelerator: 'CmdOrCtrl+0', click: () => sendToWindow({ type: 'fontSize', value: 0 }) },
        { type: 'separator' },
        {
          label: 'Typewriter Scrolling',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => sendToWindow({ type: 'typewriter' })
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Full Screen',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => {
            const w = BrowserWindow.getFocusedWindow();
            if (w && !w.isSimpleFullScreen()) w.setFullScreen(!w.isFullScreen());
          }
        },
        {
          label: 'The Silo',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToWindow({ type: 'silo' })
        }
      ]
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'NEO Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => sendToWindow({ type: 'help' })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Two copies of NEO editing the same library is how words get eaten
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// Auto-update from GitHub releases. Deliberately defensive: any failure is
// logged and swallowed, so an unsigned build or offline machine never notices.
// (macOS auto-update only works once the app is code-signed.)
function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = null;
    autoUpdater.on('error', (err) => logError('updater', err));
    autoUpdater.checkForUpdatesAndNotify().catch((err) => logError('updater', err));
  } catch (err) {
    logError('updater', err);
  }
}

app.whenReady().then(() => {
  // macOS press-and-hold accent picker can open invisibly inside Chromium
  // and re-emit swallowed keys as phantom repeated letters. Within NEO,
  // held keys simply repeat — which is what writers expect anyway.
  if (process.platform === 'darwin') {
    try {
      const { systemPreferences } = require('electron');
      systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false);
    } catch (err) {
      logError('prefs', err);
    }
  }
  ensureLibrary();
  buildMenu();
  createWindow();
  dailyBackup();
  checkForUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
