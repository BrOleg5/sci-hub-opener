/*
 * DOI extraction helpers shared by the background page, content script and
 * options page. Modelled on Zotero's DOI.js translator.
 */
(function (root) {
  "use strict";

  // Same idea as Zotero: "10." + 4+ digits + "/" + suffix without whitespace/quotes.
  // Angle brackets are excluded as well so raw HTML never leaks into a match.
  const DOI_SOURCE = "10\\.[0-9]{4,}\\/[^\\s&\"'<>]*[^\\s&\"'<>.,;:]";
  const DOI_RE_GLOBAL = new RegExp("\\b" + DOI_SOURCE, "g");
  const DOI_RE_SINGLE = new RegExp(DOI_SOURCE);
  const DOI_RE_FULL = new RegExp("^" + DOI_SOURCE + "$");

  const PREFIX_RE = /^\s*(?:doi\s*:\s*|info:doi\/|https?:\/\/(?:dx\.)?doi\.org\/|(?:dx\.)?doi\.org\/)/i;
  const TRAILING_SEGMENT_RE = /\/(?:pdf|epdf|full|fulltext|abstract|abs|meta|references|supplemental|suppinfo)(?:\/.*)?$/i;

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (e) {
      return value;
    }
  }

  function count(str, ch) {
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === ch) n++;
    }
    return n;
  }

  /**
   * Normalises a raw DOI-like string (with optional "doi:" / doi.org prefix,
   * trailing punctuation or "/pdf" suffix). Returns null if no DOI is found.
   */
  function cleanDOI(raw) {
    if (!raw) return null;
    let doi = String(raw).trim();
    doi = safeDecode(doi);
    doi = doi.replace(PREFIX_RE, "");

    const match = doi.match(DOI_RE_SINGLE);
    if (!match) return null;
    doi = match[0];

    // Query string / fragment are never part of a DOI in practice.
    doi = doi.replace(/[?#].*$/, "");
    // Publisher URL suffixes such as /pdf, /full, /abstract.
    doi = doi.replace(TRAILING_SEGMENT_RE, "");

    // Strip trailing punctuation and unbalanced closing brackets.
    for (;;) {
      const last = doi[doi.length - 1];
      if (!last) break;
      if (/[.,;:]/.test(last)) {
        doi = doi.slice(0, -1);
      } else if (last === ")" && count(doi, "(") < count(doi, ")")) {
        doi = doi.slice(0, -1);
      } else if (last === "}" && count(doi, "{") < count(doi, "}")) {
        doi = doi.slice(0, -1);
      } else if (last === "]" && count(doi, "[") < count(doi, "]")) {
        doi = doi.slice(0, -1);
      } else {
        break;
      }
    }

    return DOI_RE_FULL.test(doi) ? doi : null;
  }

  /** Returns every distinct DOI found in a text, in order of first appearance. */
  function extractAllDois(text) {
    const result = [];
    if (!text || text.indexOf("10.") === -1) return result;
    const seen = new Set();
    let m;
    DOI_RE_GLOBAL.lastIndex = 0;
    while ((m = DOI_RE_GLOBAL.exec(text)) !== null) {
      const doi = cleanDOI(m[0]);
      if (doi && !seen.has(doi)) {
        seen.add(doi);
        result.push(doi);
      }
    }
    return result;
  }

  function extractDoiFromText(text) {
    const all = extractAllDois(text);
    return all.length ? all[0] : null;
  }

  /**
   * Extracts a DOI from a URL: doi.org links, "doi=" query parameters,
   * publisher paths like /doi/10.xxxx/yyy, then any DOI-looking segment.
   */
  function extractDoiFromUrl(url) {
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return extractDoiFromText(url);
    }

    if (/(^|\.)doi\.org$/i.test(parsed.hostname)) {
      return cleanDOI(parsed.pathname.replace(/^\/+/, ""));
    }

    for (const [key, value] of parsed.searchParams) {
      if (/doi/i.test(key)) {
        const doi = cleanDOI(value);
        if (doi) return doi;
      }
    }

    const fromPath = extractDoiFromText(safeDecode(parsed.pathname));
    if (fromPath) return fromPath;

    for (const segment of url.split(/[#?]/)) {
      const doi = extractDoiFromText(safeDecode(segment));
      if (doi) return doi;
    }
    return null;
  }

  /** Tries the strict DOI parse first, then a URL parse. */
  function extractDoi(value) {
    return cleanDOI(value) || extractDoiFromUrl(value);
  }

  /** Appends `doi` unless already present (DOIs are case-insensitive). */
  function pushUnique(list, doi) {
    if (!doi) return;
    const key = doi.toLowerCase();
    if (!list.some((d) => d.toLowerCase() === key)) list.push(doi);
  }

  /**
   * Picks the DOI of the article a page is about.
   * Metadata and the page URL are trusted as-is. DOIs from links and text
   * count only when exactly one distinct DOI is present: several mean a list
   * page (search results, table of contents, reading lists).
   * Returns { primary, source }, source: "metadata" | "url" | "page" | "multiple" | null.
   */
  function choosePrimaryDoi(metadataDois, urlDois, pageDois) {
    if (metadataDois.length) return { primary: metadataDois[0], source: "metadata" };
    if (urlDois.length) return { primary: urlDois[0], source: "url" };
    if (pageDois.length === 1) return { primary: pageDois[0], source: "page" };
    return { primary: null, source: pageDois.length ? "multiple" : null };
  }

  /**
   * Normalises page text for use as an article title: collapses whitespace
   * and removes the DOI itself (bare, "doi:" or doi.org URL).
   */
  function cleanTitle(text, doi) {
    let title = String(text || "").replace(/\s+/g, " ");
    if (doi) {
      const escaped = doi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const doiRe = new RegExp("(?:(?:https?:\\/\\/)?(?:dx\\.)?doi\\.org\\/|doi\\s*:?\\s*)?" + escaped, "gi");
      title = title.replace(doiRe, " ");
    }
    return title
      .replace(/\s+/g, " ")
      .replace(/^[\s|•·:;,.\-–—]+|[\s|•·:;,.\-–—]+$/g, "");
  }

  root.SciHubDoi = {
    DOI_RE_GLOBAL,
    cleanDOI,
    extractAllDois,
    extractDoiFromText,
    extractDoiFromUrl,
    extractDoi,
    pushUnique,
    choosePrimaryDoi,
    cleanTitle
  };
})(globalThis);
