import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pageOrder = ["index", "getting-started", "tools", "configuration", "deploy", "scenario-product-backlog", "contributing"];
export const navigationGroups = [
  { key: "start", pages: ["index", "getting-started"] },
  { key: "reference", pages: ["tools", "configuration"] },
  { key: "guides", pages: ["deploy", "scenario-product-backlog"] },
  { key: "project", pages: ["contributing"] },
];
export const publicUrl = "https://peter-n91.github.io/hve-squad-mcp/";

function validateMessages(reference, translated, path) {
  if (typeof reference === "string") {
    if (typeof translated !== "string" || !translated.trim()) throw new Error(`Missing translation: ${path}`);
    return;
  }
  if (!translated || typeof translated !== "object" || Array.isArray(translated)) throw new Error(`Invalid translation group: ${path}`);
  if (JSON.stringify(Object.keys(reference).sort()) !== JSON.stringify(Object.keys(translated).sort())) {
    throw new Error(`Incomplete translation group: ${path}`);
  }
  for (const key of Object.keys(reference)) validateMessages(reference[key], translated[key], `${path}.${key}`);
}

export function readLocales() {
  const locales = JSON.parse(readFileSync(resolve(repositoryRoot, "site/locales.json"), "utf8"));
  const english = locales.en;
  if (!english || english.prefix !== "") throw new Error("English must retain the root URLs.");
  const prefixes = new Set();
  for (const [code, locale] of Object.entries(locales)) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(code)) throw new Error(`Invalid locale code: ${code}`);
    if (prefixes.has(locale.prefix) || (locale.prefix && !/^[a-zA-Z0-9-]+\/$/.test(locale.prefix))) {
      throw new Error(`Invalid or duplicate locale prefix: ${code}`);
    }
    prefixes.add(locale.prefix);
    if (typeof locale.name !== "string" || !locale.name.trim()) throw new Error(`Missing native language name: ${code}`);
    if (!["ltr", "rtl"].includes(locale.direction)) throw new Error(`Invalid writing direction: ${code}`);
    validateMessages(english.ui, locale.ui, `${code}.ui`);
    for (const slug of pageOrder) {
      if (!locale.pages[slug]) throw new Error(`Missing navigation label: ${code}/${slug}`);
    }
  }
  return locales;
}

export function readSource(slug, prefix = "") {
  const sourcePath = `docs/${prefix}${slug}.html`;
  const raw = readFileSync(resolve(repositoryRoot, sourcePath), "utf8");
  const $ = load(raw);
  if ($("main").length !== 1) throw new Error(`${sourcePath}: expected exactly one main element.`);
  return { $, raw, sourcePath };
}

export function headingIds($) {
  const used = new Set($("main [id]").toArray().map(element => $(element).attr("id")));
  return $("main h2, main h3").toArray().map(element => {
    const heading = $(element);
    if (heading.attr("id")) return heading.attr("id");
    const stem = heading.text().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
    let id = stem;
    let count = 2;
    while (used.has(id)) id = `${stem}-${count++}`;
    used.add(id);
    return id;
  });
}

export function enhanceContent($, englishIds, ui, rootPrefix) {
  const main = $("main");
  const headings = main.find("h2, h3");
  if (headings.length !== englishIds.length) throw new Error("Translation must preserve all section headings.");
  const toc = [];
  headings.each((i, element) => {
    const heading = $(element);
    const id = englishIds[i];
    heading.attr("id", id);
    const label = heading.text();
    if (!heading.closest("a").length) {
      toc.push({ id, text: label, depth: Number(element.tagName.slice(1)) });
      const anchor = $("<a>").attr({ href: `#${id}`, class: "heading-anchor", "aria-label": `${ui.sectionLink}: ${label}`, "data-site-ui": "", "data-pagefind-ignore": "" }).text("#");
      heading.append(anchor);
    }
  });
  const hero = main.find(".hero-logo");
  if (hero.length) {
    hero.find("img").attr({ src: `${rootPrefix}assets/logo.svg`, alt: "", width: "112", height: "112" });
    hero.find(".wordmark").replaceWith('<h1 class="wordmark">HVE Squad <span class="tag">MCP</span></h1>');
  }
  main.find("table").each((i, element) => {
    const table = $(element);
    const label = table.prevAll("h2, h3").first().text().replace(/#$/, "") || ui.table;
    table.wrap($("<div>").attr({ class: "table-scroll", tabindex: "0", role: "region", "aria-label": label }));
    table.find("thead th").attr("scope", "col");
  });
  main.find("pre").each((i, element) => {
    const pre = $(element).attr({ tabindex: "0", "aria-label": ui.code });
    const id = `code-sample-${i + 1}`;
    pre.attr("id", id);
    pre.wrap('<div class="code-block"></div>');
    const button = $("<button>").attr({
      type: "button", class: "copy-button js-only", "data-copy-target": id,
      "aria-label": `${ui.copy}: ${ui.code} ${i + 1}`, "data-site-ui": "", "data-pagefind-ignore": "",
    }).text(ui.copy);
    pre.before(button);
  });
  return { content: main.html(), toc };
}

export function buildPages(locales = readLocales()) {
  const version = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")).version;
  const pages = [];
  for (const slug of pageOrder) {
    const english = readSource(slug);
    const ids = headingIds(english.$);
    for (const [language, locale] of Object.entries(locales)) {
      const { $, sourcePath } = readSource(slug, locale.prefix);
      const rootPrefix = locale.prefix ? "../" : "";
      if ($("main h2, main h3").length !== ids.length) {
        throw new Error(`${sourcePath}: expected ${ids.length} section headings to match English.`);
      }
      const { content, toc } = enhanceContent($, ids, locale.ui, rootPrefix);
      const title = $("title").text();
      const description = $('meta[name="description"]').attr("content");
      if (!title || !description) throw new Error(`Missing title or description: ${sourcePath}`);
      const index = pageOrder.indexOf(slug);
      const adjacent = n => n >= 0 && n < pageOrder.length
        ? { url: `${pageOrder[n]}.html`, title: locale.pages[pageOrder[n]] } : null;
      const outputPath = `${locale.prefix}${slug}.html`;
      pages.push({
        language, direction: locale.direction, slug, title, description, content, toc, rootPrefix, outputPath,
        ui: locale.ui, label: locale.pages[slug], version,
        canonical: publicUrl + outputPath, defaultCanonical: `${publicUrl}${slug}.html`,
        sourceUrl: `https://github.com/Peter-N91/hve-squad-mcp/blob/main/${sourcePath}`,
        nav: navigationGroups.map(group => ({
          label: locale.ui[group.key],
          pages: group.pages.map(id => ({ id, label: locale.pages[id], url: `${id}.html` })),
        })),
        languages: Object.entries(locales).map(([code, item]) => ({
          code, name: item.name, url: `${rootPrefix}${item.prefix}${slug}.html`,
          canonical: `${publicUrl}${item.prefix}${slug}.html`,
        })),
        previous: adjacent(index - 1), next: adjacent(index + 1),
      });
    }
  }
  return pages;
}
