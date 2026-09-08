/*
 * Talks to a Sci-Hub mirror: fetches the article page and extracts the direct
 * PDF URL (…/storage/… or …/downloads/…) so the PDF opens without the
 * Sci-Hub bottom panel.
 */
(function (root) {
  "use strict";

  const PDF_PATH_RE = /\/(?:storage|downloads|tree|uptodate)\/[^"'\s<>#?]+?\.pdf/i;
  const RAW_URL_RE = /(?:https?:)?\/\/[^"'\s<>]+?\/(?:storage|downloads|tree|uptodate)\/[^"'\s<>#?]+?\.pdf|(?:^|[="'(\s])(\/(?:storage|downloads|tree|uptodate)\/[^"'\s<>#?)]+?\.pdf)/gi;
  const ONCLICK_RE = /location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i;

  function buildArticleUrl(mirrorBase, doi) {
    const path = encodeURI(doi).replace(/#/g, "%23").replace(/\?/g, "%3F");
    return mirrorBase.replace(/\/+$/, "") + "/" + path;
  }

  function normalizePdfUrl(src, baseUrl) {
    if (!src) return null;
    let u;
    try {
      u = new URL(String(src).trim(), baseUrl);
    } catch (e) {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.searchParams.delete("download");
    if ([...u.searchParams.keys()].length === 0) u.search = "";
    return u.href;
  }

  function looksLikePdf(url) {
    return /\.pdf(?:$|[?#])/i.test(url) || PDF_PATH_RE.test(url);
  }

  function collectCandidates(doc, html) {
    const candidates = [];
    const push = (v) => {
      if (v && !candidates.includes(v)) candidates.push(v);
    };

    const selectors = [
      "meta[name='citation_pdf_url'][content]",
      "#pdf[src]",
      "embed[type='application/pdf'][src]",
      "embed[src]",
      "object[type='application/pdf'][data]",
      "object[data*='.pdf']",
      "iframe[src*='.pdf']",
      "iframe[src*='/storage/']",
      "iframe[src*='/downloads/']"
    ];
    for (const sel of selectors) {
      for (const el of doc.querySelectorAll(sel)) {
        push(el.getAttribute("src") || el.getAttribute("data") || el.getAttribute("content"));
      }
    }

    for (const el of doc.querySelectorAll("[onclick]")) {
      const m = ONCLICK_RE.exec(el.getAttribute("onclick") || "");
      if (m) push(m[1]);
    }

    for (const el of doc.querySelectorAll("a[href]")) {
      const href = el.getAttribute("href") || "";
      if (looksLikePdf(href)) push(href);
    }

    let m;
    RAW_URL_RE.lastIndex = 0;
    while ((m = RAW_URL_RE.exec(html)) !== null) {
      push(m[1] || m[0]);
    }
    return candidates;
  }

  const CAPTCHA_MARKUP_RE = /altcha|<[a-z-]+[^>]*captcha|\/captcha\/|recaptcha|hcaptcha|cf-challenge|challenge-platform/i;
  const CAPTCHA_TEXT_RE = /are you a robot|robot check|вы робот|проверка на робота|подтвердите, что вы не робот|введите (?:код|капчу)/i;
  const NOT_FOUND_RE = /(?:article|paper|document)?\s*not\s+found|doesn'?t\s+have|нет\s+в\s+базе|не\s+найден|Unfortunately/i;

  function detectError(doc, html) {
    const text = (doc.body ? doc.body.textContent : html) || "";
    const title = (doc.title || "") + " " + (html.match(/<title[^>]*>([^<]*)<\/title>/i) || ["", ""])[1];
    if (CAPTCHA_MARKUP_RE.test(html) || CAPTCHA_TEXT_RE.test(text) || CAPTCHA_TEXT_RE.test(title)) return "captcha";
    if (NOT_FOUND_RE.test(text)) return "notfound";
    return "noPdf";
  }

  /** True if the document looks like a Sci-Hub anti-robot / captcha page. */
  function isCaptchaPage(doc) {
    const html = doc.documentElement ? doc.documentElement.innerHTML : "";
    return CAPTCHA_MARKUP_RE.test(html) || CAPTCHA_TEXT_RE.test(doc.title || "") || CAPTCHA_TEXT_RE.test(doc.body ? doc.body.textContent : "");
  }

  /**
   * Parses a Sci-Hub HTML page and returns { pdfUrl } or { error }.
   * Errors: "captcha" | "notfound" | "noPdf".
   */
  function parsePdfUrl(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const raw of collectCandidates(doc, html)) {
      const url = normalizePdfUrl(raw, baseUrl);
      if (url && looksLikePdf(url)) return { pdfUrl: url };
    }
    return { error: detectError(doc, html) };
  }

  /**
   * Resolves the direct PDF URL for a DOI on a mirror.
   * Returns { articleUrl, pdfUrl } or { articleUrl, error, status?, message? }.
   * Errors: "captcha" | "notfound" | "noPdf" | "http" | "timeout" | "network".
   */
  async function resolvePdf(mirrorBase, doi, timeoutMs) {
    const articleUrl = buildArticleUrl(mirrorBase, doi);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    try {
      // "include": Sci-Hub remembers a solved anti-robot check in a cookie;
      // sending it lets the direct PDF lookup work after the user passed it once.
      const resp = await fetch(articleUrl, {
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal
      });
      const contentType = (resp.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/pdf")) {
        return { articleUrl, pdfUrl: resp.url };
      }
      const html = await resp.text();
      const parsed = parsePdfUrl(html, resp.url || articleUrl);
      if (parsed.pdfUrl) return { articleUrl, pdfUrl: parsed.pdfUrl };
      if (!resp.ok && parsed.error === "noPdf") {
        return { articleUrl, error: "http", status: resp.status };
      }
      return { articleUrl, error: parsed.error, status: resp.status };
    } catch (e) {
      const isTimeout = e && e.name === "AbortError";
      return { articleUrl, error: isTimeout ? "timeout" : "network", message: e && e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * For a live Sci-Hub article document (content script): returns the direct
   * PDF URL if the page embeds one from Sci-Hub storage, otherwise null.
   * Publisher pages also carry citation_pdf_url, so only /storage/-style
   * paths count.
   */
  function findPdfInDocument(doc) {
    const url = findEmbeddedPdf(doc);
    return url && PDF_PATH_RE.test(new URL(url).pathname) ? url : null;
  }

  function findEmbeddedPdf(doc) {
    const selectors = [
      "meta[name='citation_pdf_url'][content]",
      "#pdf[src]",
      "embed[type='application/pdf'][src]",
      "object[type='application/pdf'][data]",
      "iframe[src*='/storage/']",
      "iframe[src*='/downloads/']",
      "iframe[src*='.pdf']"
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const raw = el.getAttribute("src") || el.getAttribute("data") || el.getAttribute("content");
      const url = normalizePdfUrl(raw, doc.baseURI);
      if (url && looksLikePdf(url)) return url;
    }
    for (const el of doc.querySelectorAll("[onclick]")) {
      const m = ONCLICK_RE.exec(el.getAttribute("onclick") || "");
      if (!m) continue;
      const url = normalizePdfUrl(m[1], doc.baseURI);
      if (url && looksLikePdf(url)) return url;
    }
    return null;
  }

  root.SciHub = {
    buildArticleUrl,
    normalizePdfUrl,
    parsePdfUrl,
    resolvePdf,
    isCaptchaPage,
    findPdfInDocument
  };
})(globalThis);
