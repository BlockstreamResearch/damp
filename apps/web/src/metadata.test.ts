import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve("index.html"), "utf8");
const manifest = JSON.parse(readFileSync(resolve("public/site.webmanifest"), "utf8")) as Record<string, string>;
const publicUrl = "https://blockstreamresearch.github.io/damp/";

describe("public DAMP metadata", () => {
  it("uses the canonical GitHub Pages URL for SEO and sharing", () => {
    expect(html).toContain(`<link rel="canonical" href="${publicUrl}"`);
    expect(html).toContain(`<meta property="og:url" content="${publicUrl}"`);
    expect(html).toContain(`"url": "${publicUrl}"`);
  });

  it("uses DAMP consistently in public page and app labels", () => {
    expect(html).toContain('<meta name="application-name" content="DAMP"');
    expect(html).toContain('<meta property="og:site_name" content="DAMP"');
    expect(html).not.toMatch(/\bAMP\b/);
    expect(manifest.short_name).toBe("DAMP");
    expect(manifest.name).toMatch(/^DAMP\b/);
    expect(JSON.stringify(manifest)).not.toMatch(/\bAMP\b/);
  });
});
