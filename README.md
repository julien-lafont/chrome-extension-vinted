# Vinted Favoris

A Chrome extension (Manifest V3) that saves Vinted listings locally and brings them back
in a side panel: collections, sorting, price tracking.

No server, no account — everything is stored on your machine. The only thing that ever
leaves the site is something you ask for: a "Chercher ailleurs" (search elsewhere)
button that runs a reverse image search (Google Lens) or a text search built from the
listing. The interface itself is in French, like the site it plugs into. See
`docs/specs/recherche-inversee.md`. Works on `vinted.fr`.

![Side panel showing collections, sorting by condition and price history](docs/screenshots/1.png)

More screenshots: [price history](docs/screenshots/2.png) ·
[catalogue filters](docs/screenshots/3.png) ·
[filing into a collection from the page](docs/screenshots/4.png) ·
[photo gallery](docs/screenshots/5.png).

## Installation

### From a published release

1. Download the `.zip` from the [latest release][releases] and unpack it
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** → pick the unpacked folder
5. Pin the extension to the toolbar

The extension is not on the Chrome Web Store — manual installation is how it is meant to
be distributed.

[releases]: ../../releases/latest

### From source

```bash
pnpm install
pnpm build
```

Then load the **`dist/`** folder (not the repository root), following steps 2 to 5
above.

After every code change: `pnpm build`, hit ↻ on the extension card in
`chrome://extensions`, **then reload the Vinted tab**. Skip that last reload and
`chrome.storage` throws "Extension context invalidated" — clicks then fail silently.

## Usage

- **Search results** — a bookmark button appears in the top-right corner of each listing
  card (Vinted's own favourite button stays in the bottom-right, so the two never
  collide).
- **Listing page** — an "Enregistrer" (save) button floats in the bottom-right of the
  screen, and the same bookmark button shows up on the cards further down the page
  ("Member's wardrobe", "Similar items").
- **Side panel** — click the extension icon.
- **Long-press** (about half a second) on either button — or `Alt`+click — opens the
  collection picker: the listing is saved as usual, then filed straight into the
  collection you pick, without a detour through the panel. You can create a collection
  on the spot from that menu. `Esc` closes it without filing anything.

Buttons stay in sync across every open Vinted tab.

### Collections

The tabs at the top of the panel group your listings. Unless you file it with a
long-press (above), every new listing lands in **Mes favoris**, the default collection,
which cannot be deleted.

- `+` creates a collection ("Jeans", "Shirts", "Gift for Julien"…)
- right-click a tab to rename it
- to file a listing: drag its handle onto the target tab, or use the folder icon on its
  row
- a **cross** appears on a tab as soon as its collection is empty, and deletes it. A
  collection that still holds listings shows no cross — you have to empty it first,
  which keeps you from moving listings around by accident. **Mes favoris** never shows
  one.

### Photos

Clicking a listing's thumbnail opens **every photo from its page** without leaving the
panel. The badge in the corner of the thumbnail tells you how many there are.

Navigate with the arrows on either side of the image, the ←/→ keys, a swipe, or the
thumbnail strip. `Esc` or a click outside closes it.

Each photo loads at 600×800 first, then switches to 1200×1600 once the full-resolution
version arrives. Listings saved before 0.3 have no gallery: their thumbnail opens the
Vinted tab, as it used to. Saving them again gives them one.

At the bottom of the viewer, **"Chercher cette photo"** runs a Google Lens search on the
image currently on screen (including the brand when it is known) — see
[docs/specs/recherche-inversee.md](docs/specs/recherche-inversee.md). Overlaid in the
bottom-left of the image, an expand icon **opens the photo at 1200×1600 in a new browser
tab**, outside the panel.

### The seller

The seller's username sits next to the price and links to their wardrobe. That is who
you negotiate with, and the first place to look for a second piece — shipping costs are
shared across several items from the same seller.

It only shows up on listings whose page has been read since 0.3. The others keep their
price line as it is until you save them again.

### Sorting and manual order

Six modes: **Personnalisé** (custom), **Date d'ajout** (date added), **Prix** (price),
**État** (condition), **Likes**, **Taille** (size). The button to the right of the
selector flips the direction, with a label that matches the mode ("Moins cher" —
cheapest — rather than a bare "ascending").

Custom order is set by dragging the `⠿` handle on the left of a listing. Dragging works
whatever mode is active: starting from an automatic sort simply switches to custom order
and freezes the order currently on screen. Each collection has its own order.

Reordering **while a search is active** only moves the listings you can see — the ones
hidden by the filter keep their position in the full order.

Scales used:

| Sort      | Order                                                              |
| --------- | ------------------------------------------------------------------ |
| Condition | Satisfactory → Good → Very good → New without tags → New with tags |
| Size      | Letter sizes first (XXXS → XXXL), then numeric ones (34, 36, 38…)  |

A listing missing the data being sorted on **always** ends up at the bottom, in both
directions, and the header says how many listings are in that situation. Some sorts are
still incomplete today — see [known limitations](docs/limitations.md).

### Exploring a brand

A listing's **brand**, dotted-underlined in the metadata line, opens the Vinted
catalogue filtered on that brand **within the listing's category**. Nothing else is
filtered: not price, not size, not condition — this is browsing a brand, not hunting for
an equivalent.

When the listing's category is not known for certain, the filter falls back to the brand
alone rather than risk the wrong category.

### Finding a similar listing

The magnifier icon on a listing opens the Vinted catalogue, pre-filtered:

| Criterion | Value                                                        |
| --------- | ------------------------------------------------------------ |
| Brand     | the listing's, filtered by id                                |
| Size      | the listing's, filtered by id                                |
| Category  | the listing's, when it is known for certain                  |
| Price     | from **half** to **double** the saved price (−50 % / +100 %) |
| Condition | New with tags, New without tags, Very good condition         |

The three conditions are **fixed**, whatever the original listing's condition is: the
point is to find a good deal, not a battered twin.

Both bounds can be tuned separately in `src/sidepanel/search.ts`: `PRICE_DOWN` (0.5 =
−50 %) and `PRICE_UP` (1 = +100 %). They round outwards, so a listing sitting exactly on
the boundary is not excluded.

Vinted only filters on numeric ids. Brand and category are read from the listing page;
size, which Vinted writes nowhere, is resolved from its label right after saving. All
three criteria are therefore exact — "42" no longer brings back shoe sizes when you were
after a waist.

Text search remains as a fallback: listings saved before 0.3, a brand Vinted does not
list, or a size that could not be resolved. Saving them again is enough to bring them up
to date. See [known limitations](docs/limitations.md).

### Export and diagnostics

The bottom of the panel offers a **JSON export** of every favourite, plus a
**Diagnostic** to run when something stops working — it tells you at a glance whether
Vinted changed its DOM or whether the click simply never reaches the button.

## Documentation

| Document                                | Contents                                          |
| --------------------------------------- | ------------------------------------------------- |
| [architecture.md](docs/architecture.md) | Files, data model, storage, concurrency           |
| [vinted-dom.md](docs/vinted-dom.md)     | Vinted DOM anchors and what to do when they break |
| [pitfalls.md](docs/pitfalls.md)         | Phantom clicks, repaint loops, drag and drop      |
| [diagnostic.md](docs/diagnostic.md)     | Reading the diagnostic report                     |
| [testing.md](docs/testing.md)           | Running the tests, harness, fixtures              |
| [limitations.md](docs/limitations.md)   | Known limitations                                 |

To contribute: [CONTRIBUTING.md](CONTRIBUTING.md). To work on this repository with an
agent: [CLAUDE.md](CLAUDE.md).

## Development

Node 22+ and pnpm 10+ (`corepack enable` is enough to get the right pnpm).

```bash
pnpm install
pnpm dev        # rebuilds dist/ on every save
```

| Command          | Effect                                                   |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | development build in watch mode (sourcemaps, unminified) |
| `pnpm build`     | production `dist/`, minified                             |
| `pnpm test`      | 88 jsdom tests against real Vinted fixtures (~25 s)      |
| `pnpm typecheck` | `tsc --noEmit`                                           |
| `pnpm lint`      | ESLint + stylelint                                       |
| `pnpm format`    | Prettier, writing in place                               |
| `pnpm check`     | all of the above — what CI replays                       |
| `pnpm package`   | `artifacts/vinted-favoris-<version>.zip`                 |

### What the project enforces mechanically

The traps in this extension are silent — nothing shows up in the console. So three
guardrails are tooled rather than left to code review.

- **Content scripts stay IIFE.** Chrome accepts no runtime `import` there; an ES module
  would fail without a word. `tests/build-output.test.ts` checks it.
- **No `transform` on `:hover`** for injected buttons: the button moves out of its own
  hover area and oscillates, which swallows the click. A homegrown stylelint plugin
  (`tools/stylelint-no-hover-transform.js`) rejects it.
- **No Vinted CSS class in selectors**: they are obfuscated and change with every
  deploy. An ESLint rule forbids them.

### Publishing a release

The version lives in `package.json` alone — `src/manifest.ts` reads it, and the tag has
to match (the workflow fails otherwise).

```bash
pnpm version minor          # updates package.json and creates the tag
git push --follow-tags
```

The `release.yml` workflow replays `pnpm check`, builds the zip and creates the GitHub
Release. Every commit on `main` and every PR already produce a downloadable zip artifact
in the Actions tab, without creating a release.

### A note on TypeScript

TypeScript is deliberately held at **6.x**: `typescript-eslint` does not support TS 7
yet (its bound is `<6.1.0`) and refuses to start beyond it, which breaks `pnpm lint`
completely. Dependabot is told to ignore that major.
