# Sci-Hub Opener (Firefox)

> [!CAUTION]
> This project's code is 100% AI-generated.

This extension opens the PDF of a scientific article **directly from Sci-Hub
storage** (`https://<mirror>/storage/…/….pdf` or `/downloads/…/….pdf`), without the
Sci-Hub bottom panel. The DOI is extracted from any page the same way the Zotero
Connector does it: meta tags (`citation_doi`, `dc.identifier`, `prism.doi`, …),
JSON-LD, canonical link/URL, links to `doi.org`, and as a last resort the page text.

## Features

- **Address-bar button** — on article pages (journals, databases, conference
  proceedings and the like) it opens the PDF. On list pages (search results, tables
  of contents, book chapters) it shows a folder icon, like the Zotero connector, and
  opens a window listing the articles found: tick the ones you need and press "Open"
  to get each PDF in its own tab. Hidden on all other pages.
- **Toolbar button** — opens a popup with the DOI of the current article (editable),
  an "Open PDF" button and all settings. On list pages the popup has a
  "Select articles…" button that opens the same selection window. On article pages
  the icon shows a "DOI" badge (the DOI itself is in the tooltip). The same page
  serves as the options page in the Add-ons Manager.
- **Keyboard shortcut** `Ctrl+Shift+L` — same as the address-bar button (change it
  under "Manage Extension Shortcuts").
- **Context menu** (items appear only where a DOI is present):
  - on a DOI link (`doi.org/…`, `…/doi/10.…` or a DOI in the link text) — "Open DOI link in Sci-Hub";
  - on selected text containing a DOI — "Open selected DOI in Sci-Hub";
  - on a page with a detected DOI / on the extension button — "Open this article in Sci-Hub".
- **Mirror selection** from an editable list or a custom mirror; availability check.
- **Fallback**: if Sci-Hub did not return a PDF (article missing, robot check, mirror
  down), the plain page `https://<mirror>/<doi>` is opened instead.
- Opens in a new tab (next to the current one) or in the current tab — configurable.
- UI languages: English and Russian.

## Installation

### Temporarily (for development)

1. Open `about:debugging#/runtime/this-firefox`.
2. "Load Temporary Add-on…" → pick `manifest.json` from this folder.
3. The button appears on the toolbar; the extension lives until Firefox restarts.

### Permanently

1. Install [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):
   `npm install --global web-ext`.
2. Build the package: `web-ext build` (produces `web-ext-artifacts/*.zip`).
3. Sign it on AMO (`web-ext sign --channel unlisted --api-key … --api-secret …`)
   or install the unsigned `.xpi` in Firefox Developer Edition / Nightly with
   `xpinstall.signatures.required = false`.

## How it works

1. The content script `content/doi-finder.js` finds the page DOI (priority:
   metadata → JSON-LD → canonical/URL → links → text). A DOI from links/text counts
   as the article DOI only if it is the only one on the page; several distinct DOIs
   there mean a list page, and the selection window is offered instead. Titles for
   that window are taken from the page around each DOI.
2. The background page `background/background.js` requests
   `https://<mirror>/<doi>` (with the user's cookies), and `lib/scihub.js` looks for
   `meta[name=citation_pdf_url]`, `object[type=application/pdf]`, `#pdf`
   (`embed`/`iframe`), `onclick="location.href='…pdf'"` or any URL of the form
   `/storage/…pdf` / `/downloads/…pdf`, normalises it (drops `#…` and
   `?download=true`) and opens it in a tab.
3. If the mirror responds with `application/pdf` right away, the final response URL
   is opened.

## "Are you a robot?" check

Sci-Hub shows new sessions a robot-check page (ALTCHA) and remembers the result in
a cookie. The first run on a new mirror usually goes like this:

1. The extension finds no PDF and opens the plain Sci-Hub page.
2. You click "No" on the "Are you a robot?" question. The page reloads with the article.
3. The extension notices the embedded PDF in that tab and navigates to the direct
   storage PDF URL by itself.

Subsequent clicks open the PDF immediately for as long as the cookie is valid.

## Limitations

- Mirrors change and not all of them are reachable from every network; the default
  list can be edited in the settings, and availability can be checked with a button.
- Articles newer than 2021–2022 are usually missing from Sci-Hub.

## Tests

```
node test/doi.test.js
npx web-ext lint --ignore-files "test/**"
```

## Layout

```
manifest.json
background/background.js   menus, buttons, commands, tab handling, badge
content/doi-finder.js      DOI extraction from the page
lib/doi.js                 DOI regex, cleanDOI, extraction from URL/text
lib/scihub.js              mirror request and PDF link parsing
lib/settings.js            settings (storage.sync), mirror list
popup/                     toolbar popup: open PDF + settings (also the options page)
select/                    selection window for list pages
_locales/{en,ru}/          localisation
icons/                     icons
```
