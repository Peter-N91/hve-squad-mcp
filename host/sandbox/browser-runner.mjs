#!/usr/bin/env node
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chromium } from "/opt/hve-browser/node_modules/playwright/index.mjs";
import { isNonPublicHost, validateBrowserUrl, validateWorkflow } from "./browser-policy.mjs";

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 30_000;
const MAX_LINKS = 30;
const MAX_WORKFLOW_MS = 35_000;
const MAX_REVEAL_SCROLLS = 12;

/**
 * Scroll through the page the way a reader would, so lazily loaded sections
 * (for example components that render on intersection) are fetched, then let
 * their requests settle. Bounded in scrolls and time.
 */
async function revealLazyContent(page) {
  for (let index = 0; index < MAX_REVEAL_SCROLLS; index++) {
    const atBottom = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 0.9);
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    }).catch(() => true);
    await page.waitForTimeout(250);
    if (atBottom) break;
  }
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
}

/**
 * Visible page text, including open shadow roots (web components such as
 * compatibility tables render there, where `innerText` does not reach).
 * Runs inside the page, so it must not reference module scope.
 */
function visibleText() {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent.replace(/\s+/g, " ");
      if (value.trim()) parts.push(value);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    let display = "";
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (skip.has(node.tagName.toUpperCase())) return;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return;
      display = style.display;
    }
    const assigned = node.nodeType === Node.ELEMENT_NODE && node.tagName === "SLOT" ? node.assignedNodes({ flatten: true }) : [];
    const children = assigned.length ? assigned : node.shadowRoot ? [node.shadowRoot] : node.childNodes;
    const cell = display === "table-cell";
    const block = !cell && display && !display.startsWith("inline");
    if (block) parts.push("\n");
    for (const child of children) walk(child);
    if (cell) parts.push(" | ");
    if (block) parts.push("\n");
  };
  walk(document.body);
  return parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function allowedHostsFromEnvironment() {
  return (process.env.COPILOT_BROWSER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function safeSourceUrl(raw) {
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`.slice(0, 500);
}

function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !isNonPublicHost(address);
  if (family === 6) return !isNonPublicHost(address);
  return false;
}

async function assertPublicDns(url, cache) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) {
    if (!publicAddress(host)) throw new Error(`host ${host} resolves to a non-public address`);
    return;
  }
  let records = cache.get(host);
  if (!records) {
    records = lookup(host, { all: true, verbatim: true });
    cache.set(host, records);
  }
  const addresses = await records;
  if (addresses.length === 0 || addresses.some((record) => !publicAddress(record.address))) {
    throw new Error(`host ${host} resolves to a non-public address`);
  }
}

async function readInput() {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes.`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function resolveLocator(page, step) {
  if (typeof step.role === "string" && typeof step.name === "string") {
    return page.getByRole(step.role, { name: step.name, exact: true });
  }
  if (typeof step.label === "string") return page.getByLabel(step.label, { exact: true });
  return page.getByText(step.text, { exact: true });
}

async function exactlyOne(locator, action) {
  const count = await locator.count();
  if (count !== 1) throw new Error(`${action} expected exactly one matching control, found ${count}.`);
  return locator;
}

async function runWorkflow(workflow) {
  const allowedHosts = allowedHostsFromEnvironment();
  const start = validateBrowserUrl(workflow.url, allowedHosts);
  if (!start.allowed) throw new Error(`Starting URL refused: ${start.reason}`);

  const dnsCache = new Map();
  await assertPublicDns(start.url, dnsCache);
  const browser = await chromium.launch({
    headless: true,
    timeout: 10000,
    args: ["--disable-dev-shm-usage", "--disable-background-networking", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  const context = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: "block",
    viewport: { width: 1365, height: 900 },
  });
  let page;
  let blockedNavigation = false;
  let timedOut = false;
  const workflowTimer = setTimeout(() => {
    timedOut = true;
    void browser.close();
  }, MAX_WORKFLOW_MS);

  const visited = [];
  const blocked = [];
  const pages = new Set();
  const recordNavigation = (candidate, frame) => {
    if (frame === candidate.mainFrame() && frame.url() !== "about:blank") {
      try {
        const url = validateBrowserUrl(frame.url(), allowedHosts);
        if (url.allowed) visited.push(safeSourceUrl(url.url.href));
        else blockedNavigation = true;
      } catch { blockedNavigation = true; }
    }
  };
  const attachPage = (candidate) => {
    if (pages.has(candidate)) return;
    pages.add(candidate);
    candidate.setDefaultTimeout(5000);
    candidate.setDefaultNavigationTimeout(10000);
    candidate.on("framenavigated", (frame) => recordNavigation(candidate, frame));
    candidate.on("close", () => {
      pages.delete(candidate);
      if (page === candidate) page = [...pages].at(-1);
    });
  };

  // Routes are registered on the context before any page exists, so no request escapes them.
  await context.route("**/*", async (route) => {
    const request = route.request();
    try {
      const checked = validateBrowserUrl(request.url(), allowedHosts);
      if (!checked.allowed) throw new Error(checked.reason);
      await assertPublicDns(checked.url, dnsCache);
      await route.continue();
    } catch (error) {
      blocked.push({ url: safeSourceUrlIfPublic(request.url()), reason: String(error).slice(0, 200) });
      if (request.isNavigationRequest()) blockedNavigation = true;
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
  const routeWebSocket = async (route) => {
    const checked = validateBrowserUrl(route.url(), allowedHosts, { websocket: true });
    if (!checked.allowed) {
      blocked.push({ url: "blocked-url", reason: checked.reason });
      route.close({ code: 1008, reason: "URL refused by browser network policy" });
      return;
    }
    try {
      await assertPublicDns(new URL(checked.url.href.replace(/^wss:/, "https:")), dnsCache);
      await route.connectToServer();
    } catch (error) {
      blocked.push({ url: "blocked-url", reason: String(error).slice(0, 200) });
      route.close({ code: 1008, reason: "URL refused by browser network policy" });
    }
  };
  await context.routeWebSocket("**/*", routeWebSocket);
  context.on("page", (candidate) => {
    if (pages.has(candidate)) return;
    if (pages.size >= 3) {
      void candidate.close();
      return;
    }
    attachPage(candidate);
    page = candidate;
  });
  page = await context.newPage();
  attachPage(page);

  try {
    await page.goto(start.url.href, { waitUntil: "domcontentloaded", timeout: 10000 });
    if (blockedNavigation) throw new Error("A browser navigation was blocked by network policy.");
    const actions = [];
    for (const step of workflow.steps) {
      switch (step.action) {
        case "navigate": {
          const checked = validateBrowserUrl(step.url, allowedHosts);
          if (!checked.allowed) throw new Error(`Navigation URL refused: ${checked.reason}`);
          await page.goto(checked.url.href, { waitUntil: "domcontentloaded", timeout: 10000 });
          break;
        }
        case "click": {
          const locator = await exactlyOne(resolveLocator(page, step), "click");
          const targetUrl = await locator.evaluate((element) => {
            if (element instanceof HTMLAnchorElement) return element.href;
            if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) return element.form?.action ?? "";
            return "";
          });
          if (targetUrl) {
            const checked = validateBrowserUrl(targetUrl, allowedHosts);
            if (!checked.allowed) throw new Error(`Link refused: ${checked.reason}`);
            await assertPublicDns(checked.url, dnsCache);
          }
          await locator.click();
          break;
        }
        case "fill": {
          const locator = await exactlyOne(resolveLocator(page, step), "fill");
          const sensitiveField = await locator.evaluate((element) => {
            const input = element instanceof HTMLInputElement ? element : null;
            const markers = `${input?.type ?? ""} ${input?.autocomplete ?? ""} ${input?.name ?? ""} ${input?.id ?? ""}`.toLowerCase();
            return markers.includes("password");
          });
          if (sensitiveField) throw new Error("Password fields are not supported.");
          await locator.fill(step.value);
          break;
        }
        case "press": {
          if (step.key === "Enter") {
            const action = await page.evaluate(() => {
              const active = document.activeElement;
              return active instanceof HTMLElement ? active.closest("form")?.action ?? "" : "";
            });
            if (action) {
              const checked = validateBrowserUrl(action, allowedHosts);
              if (!checked.allowed) throw new Error(`Form navigation refused: ${checked.reason}`);
              await assertPublicDns(checked.url, dnsCache);
            }
          }
          await page.keyboard.press(step.key);
          break;
        }
        case "scroll":
          await page.mouse.wheel(0, step.deltaY);
          break;
        case "wait":
          await page.waitForTimeout(step.ms);
          break;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(350);
      actions.push({ action: step.action, completed: true });
      if (timedOut) throw new Error("Browser workflow exceeded its 35-second limit.");
      if (blockedNavigation) throw new Error("A browser navigation was blocked by network policy.");
    }
    if (blockedNavigation) throw new Error("A browser navigation was blocked by network policy.");
    await revealLazyContent(page);
    if (blockedNavigation) throw new Error("A browser navigation was blocked by network policy.");
    const content = await page.evaluate(visibleText).catch(() => "");
    // This callback runs inside the page, so the limit must be passed in as an argument.
    const links = await page.locator("a[href]").evaluateAll((anchors, max) => anchors
      .filter((anchor) => anchor instanceof HTMLAnchorElement && anchor.offsetParent !== null)
      .slice(0, max)
      .map((anchor) => ({ text: (anchor.innerText || anchor.getAttribute("aria-label") || "").trim().slice(0, 200), url: anchor.href })), MAX_LINKS);
    const visibleLinks = links.flatMap((link) => {
      const checked = validateBrowserUrl(link.url, allowedHosts);
      return checked.allowed ? [{ text: link.text, url: safeSourceUrl(checked.url.href) }] : [];
    });
    const visitedUrls = [...new Set([...visited, safeSourceUrl(page.url())])].slice(-12);
    // A short metadata line first (the server reads the visited pages from it, even
    // when the shell truncates long output), then the page as plain readable text.
    const metadata = {
      kind: "hve-squad-browser",
      title: (await page.title()).slice(0, 300),
      finalUrl: safeSourceUrl(page.url()),
      visitedUrls,
      actions,
      blockedRequests: blocked.slice(0, 10),
      textChars: Math.min(content.length, MAX_TEXT_CHARS),
      truncated: content.length > MAX_TEXT_CHARS,
    };
    const linkLines = visibleLinks.map((link) => `- ${link.text || "(no text)"}: ${link.url}`);
    process.stdout.write([
      `HVE_BROWSER_RESULT ${JSON.stringify(metadata)}`,
      "",
      "--- page text ---",
      content.slice(0, MAX_TEXT_CHARS),
      ...(linkLines.length ? ["", "--- visible links ---", ...linkLines] : []),
      "",
    ].join("\n"));
  } finally {
    clearTimeout(workflowTimer);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function safeSourceUrlIfPublic(raw) {
  const checked = validateBrowserUrl(raw, allowedHostsFromEnvironment());
  return checked.allowed ? safeSourceUrl(checked.url.href) : "blocked-url";
}

async function main() {
  const workflow = validateWorkflow(await readInput());
  await runWorkflow(workflow);
}

main().catch((error) => {
  process.stderr.write(`squad-browser: ${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
