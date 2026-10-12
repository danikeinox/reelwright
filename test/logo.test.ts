import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLogo, removeLogo, setLogo, sniffImage, LOGO_MAX_BYTES } from "../src/logo.js";
import { ReelRequestSchema } from "../src/render.js";
import { withTempHome } from "./helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

describe("logo", () => {
  let home: ReturnType<typeof withTempHome>;
  beforeEach(() => (home = withTempHome()));
  afterEach(() => home.cleanup());

  const file = (name: string, data: Buffer) => {
    const dir = join(home.dir, "src");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, data);
    return p;
  };

  it("detects formats by content, not by name", () => {
    assert.equal(sniffImage(PNG)?.ext, "png");
    assert.equal(sniffImage(WEBP)?.ext, "webp");
    assert.equal(sniffImage(JPG)?.ext, "jpg");
    assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")), null);
  });

  it("stores, replaces and removes the logo", () => {
    assert.equal(getLogo(), null);
    const a = setLogo(file("logo.png", PNG));
    assert.equal(a.ext, "png");
    assert.equal(getLogo()?.ext, "png");
    // a WebP disguised with a .png name is stored as WebP, and replaces the PNG
    setLogo(file("disguised.png", WEBP));
    assert.equal(getLogo()?.ext, "webp");
    assert.equal(existsSync(join(home.dir, "logo.png")), false);
    assert.equal(removeLogo(), true);
    assert.equal(getLogo(), null);
    assert.equal(removeLogo(), false);
  });

  it("rejects SVG, other files, folders and huge files", () => {
    assert.throws(() => setLogo(file("x.svg", Buffer.from("<svg/>"))), /PNG, WebP or JPEG/);
    assert.throws(() => setLogo(join(home.dir, "nope.png")), /not found/);
    assert.throws(() => setLogo(home.dir), /file/);
    assert.throws(() => setLogo(file("big.png", Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES)]))), /too big/);
    assert.equal(getLogo(), null);
  });

  it("render requests can opt out of the logo", () => {
    const base = { hook: "Hola", lines: ["Una línea"], caption: "c" };
    assert.equal(ReelRequestSchema.parse(base).logo, undefined);
    assert.equal(ReelRequestSchema.parse({ ...base, logo: false }).logo, false);
  });
});
