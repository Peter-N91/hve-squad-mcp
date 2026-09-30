export default function (config) {
  config.addWatchTarget("docs");
  config.addWatchTarget("scripts/docs-content.mjs");
  config.addPassthroughCopy({ "site/assets": "assets" });
  config.addPassthroughCopy({ "docs/assets/fonts": "fonts" });
  config.addPassthroughCopy({ "docs/assets/logo.svg": "assets/logo.svg" });
  config.addPassthroughCopy({ "docs/assets/favicon.svg": "assets/favicon.svg" });
  config.addPassthroughCopy({ "docs/planning": "planning" });
  config.addPassthroughCopy({ "docs/strategy-playbook.md": "strategy-playbook.md" });
  config.addPassthroughCopy({ "docs/.nojekyll": ".nojekyll" });
  config.addFilter("jsonScript", value => JSON.stringify(value).replace(/</g, "\\u003c"));
  return {
    dir: { input: "site", output: "_site", includes: "_includes", data: "_data" },
    templateFormats: ["njk"],
    htmlTemplateEngine: false,
  };
}
