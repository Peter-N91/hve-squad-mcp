# HVE Squad MCP documentation identity

The MCP documentation uses the approved G1 identity: one refined family mark,
an ocean-to-teal-to-aqua frame, cool agent nodes, and a bright execution hub.
The product name and MCP descriptor identify the product; colour alone does not.

## Colour and typography

| Role | Value |
|---|---|
| Gradient frame, bottom-left to top-right | `#0284C7` / `#0D9488` / `#2DD4BF` at 0 / 50 / 100% |
| Badge field | `#0F172A` |
| Agent nodes | `#38BDF8` |
| Execution hub | `#2DD4BF` |
| Interactive accent on light surfaces | `#0F766E` |
| Interactive accent on dark surfaces | `#2DD4BF` |
| Shared neutral foundation | Slate, white and navy |
| Logo and headings | Manrope, 600-800 |
| Documentation and UI | Source Sans 3, 400/600, with true italics |
| Commands and code | JetBrains Mono, 400, ligatures off |

Use gradients in identity artwork and restrained decorative accents, not body text,
links or code. Keep the badge geometry unchanged: no bevels, glows, shadows or
stretching. The full gradient badge is intended for 48 px and above; `favicon.svg`
is the frame-free optical small-size master.

`logo.svg` is an outlined vector and needs no fonts. The variable WOFF2 fonts in
`fonts/` are self-hosted and carry their original SIL Open Font License notices.
Do not remove the notices when reusing the design in another repository.

## Authoring and build

English `docs/*.html` remains the authoritative technical content. The original
head and page shell are retained in those files as source material; they are not
the deployed site template. Do not duplicate site navigation or appearance changes
across the content sources.

The build reads each source's title, description and `<main>` content. It adds
section anchors, accessible table scrollers and copy controls without rewriting
technical prose or code. Home-page logo lettering is normalized to the approved
wordmark. English URLs retain their existing `*.html` paths.

| Location | Responsibility |
|---|---|
| `site/pages.njk` and `site/_includes/` | Shared page shell, navigation, contents and footer |
| `site/assets/site.css` | Responsive layout, typography and light/dark design tokens |
| `site/assets/theme.js` | Early OS/user theme selection without a theme flash |
| `site/assets/site.js` | Search dialog, copy controls, language/theme selection and reading position |
| `site/locales.json` | Locale registry, translated UI and navigation labels |
| `scripts/docs-content.mjs` | Source extraction, stable section identity and locale mapping |
| `scripts/check-docs.mjs` | Content/code preservation, local links and search-index coverage |
| `_site/` | Generated output; ignored by Git, deployed by the Pages workflow |

Run `npm run docs:dev` for the local site at `http://localhost:4173`.
Run `npm run docs:build` for a production build and language-specific Pagefind
indexes. `npm run docs:test` runs the documentation contracts. The existing server
build and package publishing paths remain separate.

Eleventy's development server updates templates/content, but Pagefind indexes
refresh only on `docs:build`; restart `docs:dev` after content changes to refresh
local search. GitHub Pages always uses a fresh production index.

## Localization

French content lives under `docs/fr/`, with matching filenames and structure.
To add another language:

1. Add its BCP 47 code, native display name, one-segment path prefix, `ltr` or `rtl`
   writing direction, complete UI
   translations and page labels to `site/locales.json`.
2. Translate all seven HTML source files into `docs/<prefix>/`. Translate titles,
   descriptions and prose; keep code, commands, environment names and URLs intact.
3. Preserve heading order and every existing section ID. New anchors are derived
   from English headings so language changes can retain the same section.
4. Run the documentation contracts and production build. Incomplete navigation,
   missing files, heading mismatches and changed technical examples fail the build.

Every page has a correct HTML language, canonical URL and language alternatives.
Language selection preserves page and section. Search is indexed separately by
HTML language. No automatic redirect overrides a shared or explicitly selected
language URL. Without JavaScript, content, navigation and language links still work.

## Theme and future reuse

Readers can choose System, Light or Dark. The OS preference is the initial default;
an explicit choice is stored locally and shared across languages and open tabs.
There is no analytics or remote font request.

The shell separates content, locale data and identity tokens so the same structure
can be adapted to the other HVE Squad sites. `site/_includes/footer-extra.njk` is
an intentionally empty extension point for future product-specific components.
The planned HVE Squad newsletter is not implemented here: it will need an approved
subscription provider, privacy wording, consent handling and error/success states
before any email collection is enabled.
