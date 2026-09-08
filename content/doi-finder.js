/*
 * Content script: finds the DOI(s) of the current page the same way the
 * Zotero connector does (embedded metadata, JSON-LD, URL, links, page text).
 */
(function () {
  "use strict";

  if (window.__sciHubDoiFinderLoaded) return;
  window.__sciHubDoiFinderLoaded = true;

  const D = globalThis.SciHubDoi;

  // Tier 1: metadata that identifies *this* page's article.
  const META_NAMES = [
    "citation_doi",
    "dc.identifier",
    "dc.identifier.doi",
    "dcterms.identifier",
    "prism.doi",
    "bepress_citation_doi",
    "citation_pdf_url",
    "citation_fulltext_html_url",
    "citation_abstract_html_url",
    "og:url"
  ];

  const JSONLD_KEYS = ["doi", "DOI", "identifier", "@id", "sameAs", "url", "mainEntityOfPage"];

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE", "SVG"]);
  const MAX_TEXT_NODES = 50000;

  function metaDois() {
    const out = [];
    for (const name of META_NAMES) {
      const nodes = document.querySelectorAll(
        'meta[name="' + name + '" i], meta[property="' + name + '" i]'
      );
      for (const el of nodes) {
        const doi = D.extractDoi(el.getAttribute("content"));
        if (doi && !out.includes(doi)) out.push(doi);
      }
    }
    return out;
  }

  function walkJsonLd(value, out, depth) {
    if (depth > 6 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const v of value) walkJsonLd(v, out, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const key of JSONLD_KEYS) {
      const v = value[key];
      if (typeof v === "string") {
        const doi = D.extractDoi(v);
        if (doi && !out.includes(doi)) out.push(doi);
      } else if (v && typeof v === "object") {
        walkJsonLd(v, out, depth + 1);
      }
    }
    for (const key of ["@graph", "mainEntity", "isPartOf", "citation"]) {
      if (value[key]) walkJsonLd(value[key], out, depth + 1);
    }
  }

  function jsonLdDois() {
    const out = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        walkJsonLd(JSON.parse(el.textContent), out, 0);
      } catch (e) {
        // Malformed JSON-LD: fall back to a plain text scan of the block.
        for (const doi of D.extractAllDois(el.textContent)) {
          if (!out.includes(doi)) out.push(doi);
        }
      }
    }
    return out;
  }

  function urlDois() {
    const out = [];
    const canonical = document.querySelector('link[rel="canonical"][href]');
    const sources = [canonical && canonical.href, location.href];
    for (const src of sources) {
      const doi = src && D.extractDoiFromUrl(src);
      if (doi && !out.includes(doi)) out.push(doi);
    }
    return out;
  }

  function linkDois(counts, order) {
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (href.indexOf("10.") === -1 && !/doi/i.test(href)) continue;
      const doi = D.extractDoiFromUrl(a.href);
      if (!doi) continue;
      if (!counts.has(doi)) order.push(doi);
      counts.set(doi, (counts.get(doi) || 0) + 1);
    }
  }

  function textDois(counts, order) {
    const rootNode = document.body || document.documentElement;
    if (!rootNode) return;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentNode;
        if (!parent || SKIP_TAGS.has(parent.nodeName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.indexOf("10.") !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let node;
    let visited = 0;
    while ((node = walker.nextNode()) && visited++ < MAX_TEXT_NODES) {
      for (const doi of D.extractAllDois(node.nodeValue)) {
        if (!counts.has(doi)) order.push(doi);
        counts.set(doi, (counts.get(doi) || 0) + 1);
      }
    }
  }

  /** Returns { primary, all, source }. */
  function findDois() {
    const tier1 = metaDois().concat(jsonLdDois());
    const tier2 = urlDois();

    const counts = new Map();
    const order = [];
    linkDois(counts, order);
    textDois(counts, order);

    let primary = null;
    let source = null;
    if (tier1.length) {
      primary = tier1[0];
      source = "metadata";
    } else if (tier2.length) {
      primary = tier2[0];
      source = "url";
    } else if (order.length) {
      let best = order[0];
      for (const doi of order) {
        if (counts.get(doi) > counts.get(best)) best = doi;
      }
      primary = best;
      source = "page";
    }

    const all = [];
    for (const doi of [].concat(tier1, tier2, order)) {
      if (!all.includes(doi)) all.push(doi);
    }
    return { primary, all, source };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "getDoi") {
      return Promise.resolve(findDois());
    }
    return undefined;
  });

  // Sci-Hub fallback tab: once the article page shows an embedded PDF
  // (e.g. after the user passed the anti-robot check), tell the background
  // page so it can jump straight to the PDF.
  const H = globalThis.SciHub;
  let pdfReported = false;
  function reportSciHubPdf() {
    if (pdfReported || !H) return;
    let url = null;
    try {
      url = H.findPdfInDocument(document);
    } catch (e) {
      return;
    }
    if (!url) return;
    pdfReported = true;
    browser.runtime.sendMessage({ type: "scihubPdf", url }).catch(() => {});
  }

  // Badge support: report the page DOI to the background page.
  let lastReported;
  function report() {
    reportSciHubPdf();
    let result;
    try {
      result = findDois();
    } catch (e) {
      return;
    }
    if (result.primary === lastReported) return;
    lastReported = result.primary;
    browser.runtime.sendMessage({ type: "doiFound", doi: result.primary }).catch(() => {});
  }

  report();
  // Late-rendered content (client-side frameworks).
  setTimeout(report, 3000);
  // Single-page-app navigation: re-scan when the URL changes.
  let lastHref = location.href;
  window.addEventListener("popstate", () => setTimeout(report, 500));
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(report, 800);
    }
  }, 1500);
})();
