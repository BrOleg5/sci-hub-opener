# Sci-Hub Opener

[![Badge Mozilla](https://img.shields.io/amo/v/sci-hub-opener?label=Firefox&logo=firefox)][AMO]

[![Firefox Get The Add-on](https://extensionworkshop.com/assets/img/documentation/publish/get-the-addon-178x60px.dad84b42.png)][AMO]

Open the PDF of a scientific article in Sci-Hub with one click, straight from the
page of a journal, database, conference or any other site that shows the article's
DOI. The PDF opens on its own, without the Sci-Hub bottom panel.

> [!NOTE]
> The code for this extension was written entirely by AI coding agents under the developer’s direction.

## Features

- **One click on article pages.** A button appears in the address bar when you are
  on an article page. Click it (or press `Ctrl+Shift+L`) to open the PDF.
- **Pick from lists.** On search results, tables of contents or book chapter lists
  the address-bar button turns into a folder icon. It opens a window with the
  articles found on the page: tick the ones you need and press **Open** to get each
  PDF in its own tab.
- **Any DOI link or text.** Right-click a DOI link and choose **Open DOI link in
  Sci-Hub**, or select text containing a DOI and choose **Open selected DOI in
  Sci-Hub**. Menu items appear only where there is a DOI.
- **Toolbar popup.** Shows the DOI of the current article (you can edit it or type
  your own) and holds all settings. On article pages the toolbar icon shows a
  "DOI" badge.
- **Mirror of your choice.** Pick a Sci-Hub mirror from the list, add your own,
  and check which mirrors are reachable.
- **Graceful fallback.** If Sci-Hub has no PDF for an article, the regular Sci-Hub
  page opens instead so you can see why.
- English and Russian interface.

## Install

Install from [addons.mozilla.org][AMO], or download the XPI attached to a
[GitHub release][Releases] and open it in Firefox. Both files are the same build
signed by Mozilla, so Firefox installs either one and keeps the add-on up to date
automatically through addons.mozilla.org.

## Usage

1. Open an article page, for example on a publisher's site or PubMed.
2. Click the Sci-Hub Opener button in the address bar, or press `Ctrl+Shift+L`.
3. The PDF opens in a new tab.

On a page with several articles, the same button opens the selection window.

### First use of a mirror: "Are you a robot?"

Sci-Hub asks new visitors to confirm they are not a robot and remembers the answer
for a while. The first time you open an article on a mirror:

1. The regular Sci-Hub page opens with the "Are you a robot?" question.
2. Click **No**. The page reloads with the article.
3. The extension switches that tab to the PDF by itself.

After that, PDFs open right away.

### Settings

Click the Sci-Hub Opener icon on the toolbar:

- **Mirror**: choose a mirror, enter your own, check availability, or edit the
  mirror list.
- **Open PDF in**: a new tab (default) or the current tab.
- **"DOI" badge** on the toolbar icon: on or off.
- **Request timeout**: how long to wait for a mirror.

To change the keyboard shortcut, open the Add-ons Manager, click the gear icon
and choose **Manage Extension Shortcuts**.

### Limitations

- Sci-Hub mirrors change, and not every mirror is reachable from every network.
  If PDFs stop opening, try another mirror in the settings.
- Articles published after 2021–2022 are usually not available in Sci-Hub.

### Permissions and privacy

The add-on asks for access to your data on all websites. It needs this to find the
DOI on any article page and to load pages from the Sci-Hub mirror you chose.

- Pages are scanned only inside your browser; nothing from them is sent anywhere.
- A DOI is sent only to your chosen Sci-Hub mirror, and only when you ask to open
  an article. The availability check just opens each mirror's home page.
- The add-on collects no data and has no analytics.

## Development

### Project layout

```
manifest.json
package.json               npm scripts: build, lint, start, sign, test
web-ext-config.cjs         shared web-ext options (ignored files, package name)
scripts/                   release helper scripts
.github/workflows/         release and signing workflows
background/background.js   menus, buttons, shortcut, tab handling, badge, selection window
content/doi-finder.js      DOI and title extraction from the page
lib/doi.js                 DOI regex, cleanDOI, extraction from URL/text, list-page rules
lib/scihub.js              mirror request and PDF link parsing
lib/settings.js            settings (storage.sync), mirror list
popup/                     toolbar popup: open PDF + settings (also the options page)
select/                    selection window for list pages
_locales/{en,ru}/          localisation
icons/                     icons
test/                      unit tests and saved Sci-Hub pages
```

### How it works

1. **Finding the DOI.** The content script `content/doi-finder.js` looks for DOIs
   in this order: meta tags (`citation_doi`,
   `dc.identifier`, `prism.doi`, …), JSON-LD, canonical link and page URL, links,
   page text.
2. **Article or list page.** A DOI from metadata or the URL is the article DOI.
   A DOI from links or text counts only if it is the only one on the page; several
   distinct DOIs mean a list page. On list pages the address-bar button gets a
   folder icon and opens `select/`, where titles are taken from the list item
   around each DOI (link text, heading or title-like element, short reference
   entry).
3. **Getting the PDF.** The background page requests `https://<mirror>/<doi>`
   with the user's cookies. `lib/scihub.js` looks for `meta[name=citation_pdf_url]`,
   `object[type=application/pdf]`, `#pdf` (`embed`/`iframe`),
   `onclick="location.href='…pdf'"` or any `/storage/…pdf` / `/downloads/…pdf` URL,
   normalises it (drops `#…` and `?download=true`) and opens it. If the mirror
   answers with `application/pdf` directly, the final response URL is opened.
4. **Fallback and robot check.** Without a PDF link (article missing, ALTCHA robot
   check, mirror down) the plain Sci-Hub page opens. The tab is remembered for
   15 minutes: once the content script sees an embedded storage PDF there, the
   background page navigates the tab to it.

Several articles picked in the selection window are resolved at most three at a
time and opened next to the list page in the picked order.

### Setup

Node.js 22 or newer is required. Install the pinned dependencies (`web-ext`):

```
npm ci
```

### Load for development

Either run Firefox with the add-on loaded:

```
npm start
```

or load it by hand:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` from this folder.
3. The add-on stays loaded until Firefox restarts. After code changes, click
   **Reload** on the same page.

### Tests

```
npm test
```

The tests cover DOI parsing, list-page rules, title cleanup and PDF link
extraction, including pages saved from sci-hub.ru in `test/fixtures/`.

### Lint

```
npm run lint
```

### Build

```
npm run build
```

The package is written to `web-ext-artifacts/sci-hub-opener.xpi`. Tests, scripts,
the README and npm files are left out of it. The list of excluded files lives in
`web-ext-config.cjs` and is shared by `build`, `lint`, `start` and `sign`, so the
package uploaded to addons.mozilla.org has exactly the same contents.

### Release

Push a tag matching the version in `manifest.json`. For example, for version
`1.0.0`:

```
git tag v1.0.0
git push origin v1.0.0
```

The **Release XPI** workflow then:

1. runs the tests and the lint;
2. creates a **draft** GitHub release for the tag (if it does not exist yet);
3. uploads the version to addons.mozilla.org (`npm run sign`) without waiting for
   the review;
4. waits up to 20 minutes for Mozilla to sign the version, then downloads the
   signed XPI from AMO, checks its sha256, attaches it to the release and
   publishes the release.

Review on AMO can take days. If the version is not signed within those 20 minutes,
the workflow ends successfully and leaves the release as a draft. The **Attach
signed XPI** workflow runs every 6 hours, finds draft releases with a `v*` tag and
no XPI attached, and finishes the job once Mozilla has signed them. It can also be
started by hand from **Actions** (optionally for a single tag). Both workflows use
`scripts/publish-signed-xpi.mjs`, which takes the add-on ID from `manifest.json`,
so re-running them is safe.

To run a release manually, open **Actions**, select **Release XPI**, click
**Run workflow** and enter an existing tag matching the manifest version. Uploading
a version that AMO already knows is not treated as a failure.

### Repository secrets

Uploading to AMO needs an API credential from
[Developer Hub → Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/),
stored as repository secrets:

- `AMO_JWT_ISSUER` — the JWT issuer (`user:…`), passed as `WEB_EXT_API_KEY`;
- `AMO_JWT_SECRET` — the JWT secret, passed as `WEB_EXT_API_SECRET`.

Downloading the signed XPI and updating releases uses the built-in `GITHUB_TOKEN`.

[AMO]: https://addons.mozilla.org/ru/firefox/addon/sci-hub-opener/
[Releases]: https://github.com/BrOleg5/sci-hub-opener/releases
