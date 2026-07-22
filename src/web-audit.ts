import axios from "axios";
import { CONFIG } from "./config.js";

interface PageLink {
  href: string;
  text: string;
}

interface OpenGraphMetadata {
  title?: string;
  description?: string;
  image?: string;
}

export interface WebAuditReport {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  metaDescription: string;
  canonicalUrl: string;
  htmlLang: string;
  viewport: string;
  headings: {
    h1: string[];
    h2: string[];
    h3: string[];
  };
  links: PageLink[];
  buttons: string[];
  images: {
    total: number;
    missingAlt: number;
    emptyAlt: number;
  };
  forms: number;
  scripts: number;
  stylesheets: number;
  frameworkHints: string[];
  openGraph: OpenGraphMetadata;
  suggestions: string[];
}

export async function auditWebsite(url: string, timeoutMs = 20000): Promise<WebAuditReport> {
  const response = await axios.get<string>(url, {
    responseType: "text",
    timeout: timeoutMs,
    maxRedirects: 5,
    headers: {
      "User-Agent": "memecoin-trading-bot website-audit/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  const html = response.data || "";
  const finalUrl = String(response.request?.res?.responseUrl || url);
  const contentType = String(response.headers["content-type"] || "unknown");

  const report: WebAuditReport = {
    requestedUrl: url,
    finalUrl,
    status: response.status,
    contentType,
    title: extractFirstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    metaDescription: extractMetaContent(html, "description"),
    canonicalUrl: extractLinkHref(html, "canonical"),
    htmlLang: extractHtmlLang(html),
    viewport: extractMetaContent(html, "viewport"),
    headings: {
      h1: extractTagTexts(html, "h1"),
      h2: extractTagTexts(html, "h2"),
      h3: extractTagTexts(html, "h3"),
    },
    links: extractLinks(html),
    buttons: extractButtons(html),
    images: extractImageStats(html),
    forms: countMatches(html, /<form\b/gi),
    scripts: countMatches(html, /<script\b/gi),
    stylesheets: countMatches(html, /<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["']/gi),
    frameworkHints: detectFrameworks(html),
    openGraph: {
      title: extractMetaContent(html, "og:title", true),
      description: extractMetaContent(html, "og:description", true),
      image: extractMetaContent(html, "og:image", true),
    },
    suggestions: [],
  };

  report.suggestions = buildSuggestions(report);
  return report;
}

function buildSuggestions(report: WebAuditReport): string[] {
  const suggestions: string[] = [];

  if (!report.htmlLang) {
    suggestions.push("Add a lang attribute on the <html> element to improve accessibility and SEO.");
  }
  if (!report.title) {
    suggestions.push("Add a descriptive <title> tag so the page is identifiable in search results and browser tabs.");
  } else if (report.title.length < 15 || report.title.length > 65) {
    suggestions.push("Adjust the <title> length to roughly 15-65 characters for clearer search and sharing previews.");
  }
  if (!report.metaDescription) {
    suggestions.push("Add a meta description to improve search snippets and link previews.");
  } else if (report.metaDescription.length < 70 || report.metaDescription.length > 160) {
    suggestions.push("Tune the meta description to around 70-160 characters for better search result visibility.");
  }
  if (!report.viewport) {
    suggestions.push("Add a responsive viewport meta tag for better mobile rendering.");
  }
  if (!report.canonicalUrl) {
    suggestions.push("Add a canonical URL to avoid duplicate-content ambiguity across deployments.");
  }
  if (report.headings.h1.length === 0) {
    suggestions.push("Add a clear H1 heading so users and search engines can quickly understand the page purpose.");
  } else if (report.headings.h1.length > 1) {
    suggestions.push("Consider reducing to a single primary H1 to create a clearer content hierarchy.");
  }
  if (!report.openGraph.title || !report.openGraph.description || !report.openGraph.image) {
    suggestions.push("Add complete Open Graph metadata (title, description, image) for richer social sharing cards.");
  }
  if (report.images.total > 0 && report.images.missingAlt > 0) {
    suggestions.push(`Add alt attributes to ${report.images.missingAlt} image(s) to improve accessibility and screen-reader support.`);
  }
  if (report.images.emptyAlt > 0) {
    suggestions.push(`Review ${report.images.emptyAlt} image(s) with empty alt text and confirm they are decorative rather than content-bearing.`);
  }
  if (report.links.length === 0) {
    suggestions.push("Add visible navigation or CTA links so users can move deeper into the app.");
  }
  if (report.buttons.length === 0 && report.forms === 0) {
    suggestions.push("Consider adding a clear primary call to action so the landing page drives the next user step.");
  }
  if (!report.frameworkHints.length) {
    suggestions.push("Expose a small amount of recognizable app metadata if you want easier diagnostics for deployed builds.");
  }

  return suggestions;
}

function extractHtmlLang(html: string): string {
  const match = html.match(/<html\b[^>]*\blang=["']([^"']+)["']/i);
  return cleanupText(match?.[1] || "");
}

function extractMetaContent(html: string, name: string, property = false): string {
  const attribute = property ? "property" : "name";
  const pattern = new RegExp(
    `<meta\\b[^>]*${attribute}=["']${escapeRegex(name)}["'][^>]*content=["']([^"']*)["'][^>]*>`,
    "i"
  );
  return cleanupText(html.match(pattern)?.[1] || "");
}

function extractLinkHref(html: string, rel: string): string {
  const pattern = new RegExp(
    `<link\\b[^>]*rel=["'][^"']*${escapeRegex(rel)}[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return cleanupText(html.match(pattern)?.[1] || "");
}

function extractTagTexts(html: string, tag: "h1" | "h2" | "h3"): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const values: string[] = [];

  for (const match of html.matchAll(pattern)) {
    const value = cleanupText(stripTags(match[1] || ""));
    if (value) {
      values.push(value);
    }
  }

  return values;
}

function extractLinks(html: string): PageLink[] {
  const links: PageLink[] = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(pattern)) {
    const href = cleanupText(match[1] || "");
    const text = cleanupText(stripTags(match[2] || ""));
    if (href) {
      links.push({ href, text });
    }
  }

  return links;
}

function extractButtons(html: string): string[] {
  const buttons: string[] = [];

  for (const match of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) {
    const text = cleanupText(stripTags(match[1] || ""));
    if (text) {
      buttons.push(text);
    }
  }

  for (const match of html.matchAll(/<input\b[^>]*type=["'](?:submit|button)["'][^>]*value=["']([^"']+)["'][^>]*>/gi)) {
    const text = cleanupText(match[1] || "");
    if (text) {
      buttons.push(text);
    }
  }

  return buttons;
}

function extractImageStats(html: string): { total: number; missingAlt: number; emptyAlt: number } {
  let total = 0;
  let missingAlt = 0;
  let emptyAlt = 0;

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    total += 1;
    const alt = extractAltAttribute(match[0]);
    if (!alt.present) {
      missingAlt += 1;
      continue;
    }
    if (!alt.value.trim()) {
      emptyAlt += 1;
    }
  }

  return { total, missingAlt, emptyAlt };
}

function extractAltAttribute(imgTag: string): { present: boolean; value: string } {
  const doubleQuoted = imgTag.match(/(?:^|\s)alt\s*=\s*"([^"]*)"/i);
  if (doubleQuoted) {
    return { present: true, value: doubleQuoted[1] || "" };
  }

  const singleQuoted = imgTag.match(/(?:^|\s)alt\s*=\s*'([^']*)'/i);
  if (singleQuoted) {
    return { present: true, value: singleQuoted[1] || "" };
  }

  const unquoted = imgTag.match(/(?:^|\s)alt\s*=\s*([^\s>]+)/i);
  if (unquoted) {
    return { present: true, value: unquoted[1] || "" };
  }

  if (/(?:^|\s)alt(?:\s|>)/i.test(imgTag)) {
    return { present: true, value: "" };
  }

  return { present: false, value: "" };
}

function detectFrameworks(html: string): string[] {
  const frameworks = new Set<string>();
  const lower = html.toLowerCase();

  if (html.includes("__NEXT_DATA__") || lower.includes("_next/")) frameworks.add("Next.js");
  if (lower.includes("/@vite/client") || lower.includes("vite")) frameworks.add("Vite");
  if (html.includes("data-reactroot") || lower.includes("react")) frameworks.add("React");
  if (html.includes("__NUXT__") || lower.includes("_nuxt/")) frameworks.add("Nuxt");
  if (lower.includes("astro")) frameworks.add("Astro");
  if (lower.includes("svelte")) frameworks.add("Svelte");

  return [...frameworks];
}

function extractFirstMatch(html: string, pattern: RegExp): string {
  return cleanupText(stripTags(html.match(pattern)?.[1] || ""));
}

function countMatches(html: string, pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function cleanupText(value: string): string {
  return decodeHtmlEntities(value.replace(/\s+/g, " ").trim());
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return "\"";
    if (normalized === "apos") return "'";
    if (normalized.startsWith("#x")) {
      return String.fromCharCode(parseInt(normalized.slice(2), 16));
    }
    if (normalized.startsWith("#")) {
      return String.fromCharCode(parseInt(normalized.slice(1), 10));
    }
    return _;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printReport(report: WebAuditReport): void {
  console.log(`🌐 Website audit for ${report.requestedUrl}`);
  console.log(`   Final URL: ${report.finalUrl}`);
  console.log(`   Status: ${report.status}`);
  console.log(`   Content-Type: ${report.contentType}`);
  console.log(`   Title: ${report.title || "(missing)"}`);
  console.log(`   Meta description: ${report.metaDescription || "(missing)"}`);
  console.log(`   Canonical: ${report.canonicalUrl || "(missing)"}`);
  console.log(`   HTML lang: ${report.htmlLang || "(missing)"}`);
  console.log(`   Viewport: ${report.viewport || "(missing)"}`);
  console.log(`   Framework hints: ${report.frameworkHints.join(", ") || "(none detected)"}`);
  console.log(`   Headings: H1=${report.headings.h1.length}, H2=${report.headings.h2.length}, H3=${report.headings.h3.length}`);
  console.log(`   Images: ${report.images.total} total, ${report.images.missingAlt} missing alt, ${report.images.emptyAlt} empty alt`);
  console.log(`   Forms: ${report.forms} | Buttons: ${report.buttons.length} | Links: ${report.links.length}`);

  if (report.headings.h1.length > 0) {
    console.log(`\n📌 H1 headings:`);
    for (const heading of report.headings.h1) {
      console.log(`   - ${heading}`);
    }
  }

  if (report.links.length > 0) {
    console.log(`\n🔗 Sample links:`);
    for (const link of report.links.slice(0, 10)) {
      console.log(`   - ${link.text || "(no text)"} → ${link.href}`);
    }
  }

  if (report.buttons.length > 0) {
    console.log(`\n🔘 Buttons / CTA labels:`);
    for (const button of report.buttons.slice(0, 10)) {
      console.log(`   - ${button}`);
    }
  }

  console.log(`\n💡 Improvement suggestions:`);
  if (report.suggestions.length === 0) {
    console.log("   - No obvious metadata/accessibility issues detected from the HTML snapshot.");
  } else {
    for (const suggestion of report.suggestions) {
      console.log(`   - ${suggestion}`);
    }
  }
}

function resolveAuditUrl(args: string[]): string {
  const explicitUrl = args.find(arg => !arg.startsWith("--"));
  if (explicitUrl) {
    assertValidUrl(explicitUrl);
    return explicitUrl;
  }
  if (CONFIG.dashboardWebUrl) {
    assertValidUrl(CONFIG.dashboardWebUrl);
    return CONFIG.dashboardWebUrl;
  }
  if (CONFIG.dashboardApiUrl) {
    const derivedUrl = deriveDashboardWebUrl(CONFIG.dashboardApiUrl);
    assertValidUrl(derivedUrl);
    return derivedUrl;
  }
  throw new Error("Provide a URL (`npm run inspect-web -- https://example.com`) or set DASHBOARD_WEB_URL.");
}

function deriveDashboardWebUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    const apiSegmentIndex = url.pathname.indexOf("/api/");
    if (apiSegmentIndex >= 0) {
      url.pathname = url.pathname.slice(0, apiSegmentIndex) || "/";
      url.search = "";
      url.hash = "";
      return trimTrailingSlash(url.toString());
    }

    if (url.pathname.endsWith("/api")) {
      url.pathname = url.pathname.slice(0, -4) || "/";
      url.search = "";
      url.hash = "";
      return trimTrailingSlash(url.toString());
    }

    return trimTrailingSlash(apiUrl);
  } catch {
    return trimTrailingSlash(apiUrl);
  }
}

function assertValidUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || !parsed.host) {
      throw new Error("missing protocol or host");
    }
  } catch {
    throw new Error(`Invalid URL: ${value}. Expected a full URL like https://memescope-command-center.lovable.app`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const timeoutFlag = args.find(arg => arg.startsWith("--timeout="));
  const timeoutValue = timeoutFlag ? timeoutFlag.slice("--timeout=".length) : "";
  const parsedTimeoutMs = timeoutValue ? parseInt(timeoutValue, 10) : 20000;
  const timeoutMs = Number.isFinite(parsedTimeoutMs) ? parsedTimeoutMs : 20000;
  const url = resolveAuditUrl(args);

  const report = await auditWebsite(url, timeoutMs);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}

if (process.argv[1]?.endsWith("web-audit.ts") || process.argv[1]?.endsWith("web-audit.js")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Website audit failed: ${message}`);
    process.exit(1);
  });
}
