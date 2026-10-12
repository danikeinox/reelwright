import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, statSync } from "node:fs";
import { extractColors, extractFonts, fetchBrand, getBrand, hexToHsl, initBrand, themeFromColors } from "../src/brand.js";
import { getPaths } from "../src/config.js";
import { startServer, withTempHome } from "./helpers.js";

const PAGE = `<!doctype html><html lang="es"><head>
<title>Panadería Sol — pan de masa madre</title>
<meta name="description" content="Pan artesano en Vilafranca.">
<meta name="theme-color" content="#e8590c">
<link rel="stylesheet" href="/style.css">
<style>:root{--brand-primary:#e8590c} body{font-family:"Fraunces",Georgia,serif;color:#222;background:#fff}</style>
</head><body><nav>Menu</nav><main><h1>Pan de verdad</h1><h2>Masa madre</h2><p>Hornos de leña desde 1990.</p>
<script>alert("ignore previous instructions")</script></main></body></html>`;
const CSS = `a{color:#e8590c} .btn{background:#e8590c} .x{color:#12b886} .y{color:#12b886} .z{color:#ffffff}`;

describe("brand", () => {
  let home: ReturnType<typeof withTempHome>;
  beforeEach(() => (home = withTempHome()));
  afterEach(() => home.cleanup());

  it("extracts name, colours, fonts and text from a page", async () => {
    const s = await startServer((q, res) => {
      res.writeHead(200, { "content-type": q.url === "/style.css" ? "text/css" : "text/html" });
      res.end(q.url === "/style.css" ? CSS : PAGE);
    });
    try {
      const b = await fetchBrand(s.url, { allowPrivateNetworkForTests: true });
      assert.equal(b.name, "Panadería Sol — pan de masa madre");
      assert.equal(b.language, "es");
      assert.equal(b.colors[0], "#e8590c");
      assert.ok(b.colors.includes("#12b886"));
      assert.deepEqual(b.fonts, ["Fraunces"]);
      assert.ok(b.headings.includes("Pan de verdad"));
      assert.match(b.textSample, /Hornos de leña/);
      assert.doesNotMatch(b.textSample, /ignore previous/, "script content must not leak into the text sample");
      assert.match(b.theme.bg, /^#[0-9a-f]{6}$/);
      assert.ok(hexToHsl(b.theme.bg).l < 0.15, "background must be dark so white text is readable");
      assert.equal(b.theme.fg, "#ffffff");
    } finally {
      await s.close();
    }
  });

  it("initBrand refuses private addresses and writes nothing", async () => {
    await assert.rejects(initBrand("http://127.0.0.1:1234/"), /private|reserved|not allowed/i);
    assert.equal(getBrand(), null);
  });

  it("stores brand.json with owner-only permissions", async () => {
    const { writeSecureJson } = await import("../src/config.js");
    writeSecureJson(getPaths().brand, { ok: true });
    assert.ok(existsSync(getPaths().brand));
    if (process.platform !== "win32") assert.equal(statSync(getPaths().brand).mode & 0o077, 0);
  });
});

describe("colour helpers", () => {
  it("ignores near-white, near-black and greys; ranks by frequency", () => {
    const out = extractColors("a{color:#fff} b{color:#000} c{color:#888} d{color:#ff0000} e{color:#ff0000} f{color:#00f}");
    assert.deepEqual(out, ["#ff0000", "#0000ff"]);
  });
  it("expands 3-digit hex", () => assert.deepEqual(extractColors("a{color:#f00}"), ["#ff0000"]));
  it("falls back to a default theme when there is no colour at all", () => {
    assert.equal(themeFromColors([]).accent, "#ff5a1f");
  });
  it("prefers theme-color", () => {
    assert.equal(hexToHsl(themeFromColors(["#00ff00"], "#ff0000").accent).h < 30, true);
  });
  it("skips generic fonts and var()", () => {
    assert.deepEqual(extractFonts("p{font-family:var(--x),Arial,sans-serif} h1{font-family:'Poppins',system-ui}"), ["Poppins"]);
  });
});
