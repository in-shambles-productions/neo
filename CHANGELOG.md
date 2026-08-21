# Changelog

Notable changes to this fork of NEO.

## 0.2.4 — 2026-08-21

NEO is now maintained as an **independent fork** — free to borrow good fixes from
upstream without chasing feature parity. This release ports several fixes across
from Hugh Howey's line and stops the fork from trying to update itself into it.

### Fixed
- **Windows builds open a window again.** Startup built the macOS-only `appMenu`
  before creating the window, with no error handling, so on Windows the whole app
  launched invisibly. The menu is now platform-gated and the window is created
  first, inside a guarded startup.
- **No more duplicated characters** when you Backspace or Delete right beside a
  placeholder mark or a darling anchor — a Chromium quirk, now handled by doing
  that single-character delete by hand.
- **Tab stays in the manuscript.** Tab inserts two spaces (Shift+Tab removes
  them) instead of yanking focus out to the toolbar.
- **Backspace clears an empty chapter.** Pressing Backspace in a chapter you've
  just emptied removes it and drops you at the end of the previous one, instead
  of stranding an empty shell.

### Changed
- **Cross-platform shortcut labels.** The hint bar and shortcuts panel now show
  `Ctrl` on Windows and Linux, and `⌘` only on macOS.
- **Updates come from this fork.** The in-app updater pointed at the upstream
  repository, which could have quietly replaced your build with upstream's. It
  now tracks this fork's own releases.

## 0.2.3 — 2026-08-21

### Added
- **Current-chapter word count.** The bottom status bar now shows a live
  "*N* this chapter" counter beside the daily "today" total, so you can see how
  long the chapter you're writing in is at a glance. It updates as you type and
  follows the caret from chapter to chapter.

## 0.2.2 — 2026-08-17

### Fixed
- Chapter filenames no longer repeat the chapter number. A title that already
  carried its ordering number — e.g. a Scrivener binder document named
  `7.09 The Last of the Great Dragons` — produced files like
  `7.09 7.09 The Last of the Great Dragons.html`. NEO now strips an ordering
  prefix from the title before adding its own number. Existing books heal
  themselves when reopened: the files are renamed and the stored titles tidied,
  removing only NEO's own number so genuine titles like `1984` or
  `3 Body Problem` are left alone.
- Scrivener import now strips leading order numbers from binder titles, matching
  the files/folder importer.

### Added
- **Library location.** Choose where your library folder lives, and move it
  whenever you like — **Goals & Settings** (⌘,) → *Library folder* → **Move…**,
  or **File → Library Location…**. NEO relocates every book and remembers the
  choice. Keeping the library outside Documents, Desktop and Downloads stops
  macOS from repeatedly asking an unsigned build for folder access. A
  **Show in Finder** button opens it directly.
