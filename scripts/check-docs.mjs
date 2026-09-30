import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { load } from "cheerio";
import { buildPages, readSource, repositoryRoot } from "./docs-content.mjs";

const output = resolve(repositoryRoot, "_site");
const normalized = value => value.replace(/\s+/g, " ").trim();
const renderedDocuments = new Map();
const pages = buildPages();

for (const page of pages) {
  const target = resolve(output, page.outputPath);
  assert(existsSync(target), `Missing built page ${page.outputPath}; run npm run docs:build.`);
  const $ = load(readFileSync(target, "utf8"));
  renderedDocuments.set(target, $);
  assert.equal($("html").attr("lang"), page.language);
  assert.equal($("main").length, 1);
  assert.equal($("h1").length, 1, `${page.outputPath}: needs exactly one page heading`);
  assert.equal($("title").text(), page.title);
  assert.equal($('link[rel="alternate"][hreflang]').length, page.languages.length + 1);
  const ids = $("[id]").toArray().map(element => $(element).attr("id"));
  assert.equal(new Set(ids).size, ids.length, `${page.outputPath}: duplicate IDs`);

  const source = readSource(page.slug, page.language === "en" ? "" : page.outputPath.split("/")[0] + "/").$;
  const sourceBody = source("main").clone();
  const builtBody = $(".doc-content").clone();
  sourceBody.find(".hero-logo").remove();
  builtBody.find(".hero-logo, [data-site-ui]").remove();
  assert.equal(normalized(builtBody.text()), normalized(sourceBody.text()), `${page.outputPath}: source prose changed`);
  const code = doc => doc("main pre").toArray().map(element => doc(element).text());
  assert.deepEqual(code($), code(source), `${page.outputPath}: code samples changed`);
  const english = readSource(page.slug).$;
  const shape = doc => doc("main").find("h2, h3, p, table, thead, tbody, tr, th, td, ul, ol, li, pre, code")
    .toArray().map(element => element.tagName);
  assert.deepEqual(shape(source), shape(english), `${page.outputPath}: translation omitted or reorganized content`);
  assert.deepEqual(code(source), code(english), `${page.outputPath}: translated code samples differ from English`);
  const inline = doc => doc("main code").toArray().map(element => doc(element).text());
  assert.deepEqual(inline(source), inline(english), `${page.outputPath}: technical identifiers changed`);
  const externalLinks = doc => doc("main a[href]").toArray()
    .map(element => doc(element).attr("href")).filter(href => /^https?:/.test(href));
  assert.deepEqual(externalLinks(source), externalLinks(english), `${page.outputPath}: external references changed`);
}

for (const [filename, $] of renderedDocuments) {
  for (const element of $("a[href], link[href], script[src], img[src]").toArray()) {
    const value = $(element).attr("href") || $(element).attr("src");
    if (!value || /^(?:https?:|mailto:|data:|tel:|\/\/)/.test(value)) continue;
    const [pathAndQuery, fragment] = value.split("#");
    const path = decodeURIComponent(pathAndQuery.split("?")[0]);
    const destination = path ? resolve(dirname(filename), path) : filename;
    assert(destination === output || destination.startsWith(output + "\\" ) || destination.startsWith(output + "/"), `Link escapes output: ${value}`);
    assert(existsSync(destination), `${filename}: missing local link ${value}`);
    if (fragment && destination.endsWith(".html")) {
      const target = renderedDocuments.get(destination) || load(readFileSync(destination, "utf8"));
      assert(target("[id]").toArray().some(node => target(node).attr("id") === decodeURIComponent(fragment)),
        `${filename}: missing anchor ${value}`);
    }
  }
}
assert(existsSync(resolve(output, "pagefind/pagefind.js")), "Missing search index.");
const entry = JSON.parse(readFileSync(resolve(output, "pagefind/pagefind-entry.json"), "utf8"));
for (const page of pages) assert(entry.languages[page.language], `Missing ${page.language} search index.`);
console.log(`Documentation: ${pages.length} pages; source prose, technical examples, languages, local links and search indexes preserved.`);
