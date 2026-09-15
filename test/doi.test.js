// Plain-node tests for lib/doi.js and the URL normalisation in lib/scihub.js.
// Run: node test/doi.test.js
"use strict";

const path = require("path");
const assert = require("assert");

require(path.join(__dirname, "..", "lib", "doi.js"));
require(path.join(__dirname, "..", "lib", "scihub.js"));

const D = globalThis.SciHubDoi;
const H = globalThis.SciHub;

let failures = 0;
function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log("ok   " + name);
  } catch (e) {
    failures++;
    console.log("FAIL " + name + "\n     expected: " + JSON.stringify(expected) + "\n     actual:   " + JSON.stringify(actual));
  }
}

// cleanDOI
check("plain", D.cleanDOI("10.1016/j.cell.2015.02.028"), "10.1016/j.cell.2015.02.028");
check("doi: prefix", D.cleanDOI("doi:10.1038/nature12373"), "10.1038/nature12373");
check("DOI: prefix with space", D.cleanDOI("DOI: 10.1038/nature12373."), "10.1038/nature12373");
check("doi.org url", D.cleanDOI("https://doi.org/10.1103/PhysRevLett.116.061102"), "10.1103/PhysRevLett.116.061102");
check("dx.doi.org url", D.cleanDOI("http://dx.doi.org/10.1002/(SICI)1097-0258(19980415)17:7<857::AID-SIM777>3.0.CO;2-E"), "10.1002/(SICI)1097-0258(19980415)17:7");
check("trailing paren", D.cleanDOI("(10.1021/acs.jpcc.5b01234)"), "10.1021/acs.jpcc.5b01234");
check("balanced parens kept", D.cleanDOI("10.1002/(SICI)1097-4636(199709)36:3"), "10.1002/(SICI)1097-4636(199709)36:3");
check("trailing /pdf", D.cleanDOI("10.1021/acs.jpcc.5b01234/pdf"), "10.1021/acs.jpcc.5b01234");
check("trailing /full", D.cleanDOI("10.1080/00220388.2019.1614181/full"), "10.1080/00220388.2019.1614181");
check("query stripped", D.cleanDOI("10.1080/00220388.2019.1614181?journalCode=fjds20"), "10.1080/00220388.2019.1614181");
check("percent-encoded", D.cleanDOI("10.1002%2Fanie.201234567"), "10.1002/anie.201234567");
check("not a doi", D.cleanDOI("hello world"), null);
check("empty", D.cleanDOI(""), null);
check("short prefix rejected", D.cleanDOI("10.12/abc"), null);

// extractDoiFromUrl
check("url doi.org", D.extractDoiFromUrl("https://doi.org/10.1038/s41586-020-2649-2"), "10.1038/s41586-020-2649-2");
check("url doi.org encoded", D.extractDoiFromUrl("https://doi.org/10.1002%2Fanie.201234567"), "10.1002/anie.201234567");
check("url acs", D.extractDoiFromUrl("https://pubs.acs.org/doi/10.1021/acs.jpcc.5b01234"), "10.1021/acs.jpcc.5b01234");
check("url acs pdf", D.extractDoiFromUrl("https://pubs.acs.org/doi/pdf/10.1021/acs.jpcc.5b01234"), "10.1021/acs.jpcc.5b01234");
check("url wiley full", D.extractDoiFromUrl("https://onlinelibrary.wiley.com/doi/full/10.1002/anie.201234567"), "10.1002/anie.201234567");
check("url tandf", D.extractDoiFromUrl("https://www.tandfonline.com/doi/abs/10.1080/00220388.2019.1614181?journalCode=fjds20"), "10.1080/00220388.2019.1614181");
check("url query doi", D.extractDoiFromUrl("https://example.com/resolve?doi=10.1016%2Fj.cell.2015.02.028&x=1"), "10.1016/j.cell.2015.02.028");
check("url ieee no doi", D.extractDoiFromUrl("https://ieeexplore.ieee.org/document/8478289"), null);
check("url sciencedirect pii", D.extractDoiFromUrl("https://www.sciencedirect.com/science/article/pii/S0092867415002093"), null);
check("url springer", D.extractDoiFromUrl("https://link.springer.com/article/10.1007/s11192-019-03215-6"), "10.1007/s11192-019-03215-6");
check("url nature", D.extractDoiFromUrl("https://www.nature.com/articles/s41586-020-2649-2"), null);

// extractAllDois
check(
  "all dois in text",
  D.extractAllDois("See 10.1000/abc, then https://doi.org/10.1000/xyz. Also 10.1000/abc again."),
  ["10.1000/abc", "10.1000/xyz"]
);
check("text with html-like", D.extractAllDois("doi:10.1000/abc</a>"), ["10.1000/abc"]);

// pushUnique
const uniq = [];
for (const d of ["10.1000/ABC", "10.1000/abc", null, "10.1000/xyz", "10.1000/xyz"]) D.pushUnique(uniq, d);
check("pushUnique case-insensitive", uniq, ["10.1000/ABC", "10.1000/xyz"]);

// choosePrimaryDoi
check("primary from metadata beats page list", D.choosePrimaryDoi(["10.1000/meta"], [], ["10.1000/a", "10.1000/b"]), { primary: "10.1000/meta", source: "metadata" });
check("primary from url", D.choosePrimaryDoi([], ["10.1000/url"], ["10.1000/a", "10.1000/b"]), { primary: "10.1000/url", source: "url" });
check("single page doi is primary", D.choosePrimaryDoi([], [], ["10.1000/only"]), { primary: "10.1000/only", source: "page" });
check("list page has no primary", D.choosePrimaryDoi([], [], ["10.1000/a", "10.1000/b"]), { primary: null, source: "multiple" });
check("no doi at all", D.choosePrimaryDoi([], [], []), { primary: null, source: null });

// cleanTitle
check("title whitespace", D.cleanTitle("  Engineering   transition\n metal ", "10.1000/x"), "Engineering transition metal");
check("title strips doi: suffix", D.cleanTitle("Some title. doi: 10.1016/j.cell.2015.02.028.", "10.1016/j.cell.2015.02.028"), "Some title");
check("title strips doi.org url, any case", D.cleanTitle("https://doi.org/10.1016/J.CELL.2015.02.028", "10.1016/j.cell.2015.02.028"), "");
check("title keeps question mark", D.cleanTitle("Is it true?", "10.1000/x"), "Is it true?");

// Sci-Hub URL helpers
check("article url", H.buildArticleUrl("https://sci-hub.se", "10.1016/j.cell.2015.02.028"), "https://sci-hub.se/10.1016/j.cell.2015.02.028");
check("article url with <>", H.buildArticleUrl("https://sci-hub.se/", "10.1002/(SICI)1097-0258(19980415)17:7<857::AID-SIM777>3.0.CO;2-E"), "https://sci-hub.se/10.1002/(SICI)1097-0258(19980415)17:7%3C857::AID-SIM777%3E3.0.CO;2-E");
check("pdf protocol-relative", H.normalizePdfUrl("//sci-hub.se/downloads/2019-11-11/8b/paper.pdf#navpanes=0&view=FitH", "https://sci-hub.se/10.1/x"), "https://sci-hub.se/downloads/2019-11-11/8b/paper.pdf");
check("pdf relative download=true", H.normalizePdfUrl("/downloads/2019-11-11/8b/paper.pdf?download=true", "https://sci-hub.se/10.1/x"), "https://sci-hub.se/downloads/2019-11-11/8b/paper.pdf");
check("pdf absolute storage", H.normalizePdfUrl("https://sci-hub.red/storage/twin/6277/884bfecafad7a38e1a97c2c51f3ab18c/kurgankin2015.pdf", "https://sci-hub.red/10.1/x"), "https://sci-hub.red/storage/twin/6277/884bfecafad7a38e1a97c2c51f3ab18c/kurgankin2015.pdf");
check("pdf javascript rejected", H.normalizePdfUrl("javascript:void(0)", "https://sci-hub.se/10.1/x"), null);

// parsePdfUrl with a minimal DOMParser stub (only what collectCandidates uses).
if (typeof DOMParser === "undefined") {
  globalThis.DOMParser = class {
    parseFromString(html) {
      return {
        body: { textContent: html.replace(/<[^>]+>/g, " ") },
        querySelectorAll() {
          return [];
        }
      };
    }
  };
}
const htmlEmbed = '<html><body><div id="article"><embed type="application/pdf" src="//sci-hub.se/downloads/2019-11-11/8b/paper.pdf#navpanes=0&view=FitH" id="pdf"></div></body></html>';
check("parse embed via raw regex", H.parsePdfUrl(htmlEmbed, "https://sci-hub.se/10.1/x"), { pdfUrl: "https://sci-hub.se/downloads/2019-11-11/8b/paper.pdf" });
const htmlButton = "<html><body><button onclick=\"location.href='/downloads/2020-01-01/aa/bb.pdf?download=true'\">save</button></body></html>";
check("parse button via raw regex", H.parsePdfUrl(htmlButton, "https://sci-hub.se/10.1/x"), { pdfUrl: "https://sci-hub.se/downloads/2020-01-01/aa/bb.pdf" });
const htmlStorage = '<iframe src="https://sci-hub.red/storage/twin/6277/884bfecafad7a38e1a97c2c51f3ab18c/kurgankin2015.pdf"></iframe>';
check("parse storage iframe", H.parsePdfUrl(htmlStorage, "https://sci-hub.red/10.1/x"), { pdfUrl: "https://sci-hub.red/storage/twin/6277/884bfecafad7a38e1a97c2c51f3ab18c/kurgankin2015.pdf" });
check("parse not found", H.parsePdfUrl("<html><body><p>Unfortunately, Sci-Hub doesn't have the requested document</p></body></html>", "https://sci-hub.se/10.1/x"), { error: "notfound" });
check("parse captcha", H.parsePdfUrl('<html><body><form><img id="captcha" src="/captcha/1.png"><input name="answer"></form></body></html>', "https://sci-hub.se/10.1/x"), { error: "captcha" });
check("parse nothing", H.parsePdfUrl("<html><body><p>hello</p></body></html>", "https://sci-hub.se/10.1/x"), { error: "noPdf" });

// Real pages captured from sci-hub.ru (September 2026).
const fs = require("fs");
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
check(
  "real article page",
  H.parsePdfUrl(fixture("scihub-article.html"), "https://sci-hub.ru/10.1016/j.cell.2015.02.028"),
  { pdfUrl: "https://sci-hub.ru/storage/2024/3628/8f73784474760f598863bb39df952d7e/seeley2015.pdf" }
);
check(
  "real robot-check page",
  H.parsePdfUrl(fixture("scihub-captcha.html"), "https://sci-hub.ru/10.1016/j.cell.2015.02.028"),
  { error: "captcha" }
);

console.log(failures ? "\n" + failures + " test(s) failed" : "\nall tests passed");
process.exit(failures ? 1 : 0);
