export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Reelwright remote</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"></head>
<body><header><h1>Reelwright</h1><span id="online" class="pill">…</span></header>
<div id="banner" hidden></div>
<main><div class="card"><p class="muted">Remote dashboard. You can review status and make low-impact edits here. <strong>Approving and publishing only happen on your own computer.</strong> No passwords or tokens are ever sent here.</p></div>
<section id="health"></section><section id="reels"></section><section id="theme"></section><section id="log"></section></main>
<script src="/app.js"></script></body></html>`;

export const STYLE_CSS = `:root{--bg:#f6f6f8;--card:#fff;--fg:#16181d;--muted:#6a707c;--line:#e2e4ea;--accent:#e8490f;--ok:#18794e;--warn:#a45a00;--bad:#b3261e;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#101217;--card:#181b22;--fg:#eceef2;--muted:#9aa1ad;--line:#2a2e38;--accent:#ff6a33;--ok:#4cc38a;--warn:#e5a23c;--bad:#ff7b72}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--card);border-bottom:1px solid var(--line)}h1{font-size:18px;margin:0;flex:1}
main{max-width:900px;margin:18px auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.muted{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.pill{border:1px solid var(--line);border-radius:99px;padding:1px 10px;font-size:12px}
input[type=color]{width:48px;height:32px;padding:2px;vertical-align:middle}
textarea,input:not([type=color]){width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:7px 12px;font:inherit;cursor:pointer;margin:8px 8px 0 0}button.alt{background:none;color:var(--fg);border:1px solid var(--line)}
#banner{background:var(--accent);color:#fff;padding:9px 20px}#banner.error{background:var(--bad)}h2{font-size:16px;margin:0 0 8px}`;

export const APP_JS = `"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, String(v)); }
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  let t; function banner(m, bad) { const b = $("#banner"); b.textContent = m; b.className = bad ? "error" : ""; b.hidden = false; clearTimeout(t); t = setTimeout(() => (b.hidden = true), 6000); }
  async function post(body) {
    const r = await fetch("/api/commands", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "reelwright" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "HTTP " + r.status); return d;
  }
  const ago = (ms) => { if (!ms) return "never"; const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? s + " s ago" : s < 5400 ? Math.round(s / 60) + " min ago" : new Date(ms).toLocaleString(); };
  const editable = ["pending_approval", "approved", "publish_unknown", "failed"];
  let themeInputs = null;
  async function load() {
    let d; try { const r = await fetch("/api/state"); if (!r.ok) throw new Error("HTTP " + r.status); d = await r.json(); } catch (e) { banner("Cannot load: " + e.message, true); return; }
    const on = $("#online"); on.textContent = d.online ? "computer online" : "computer offline (last seen " + ago(d.lastSeen) + ")"; on.className = "pill " + (d.online ? "ok" : "warn");
    const h = $("#health"); h.replaceChildren();
    if (!d.state) { h.append(el("div", { class: "card muted" }, "Waiting for your computer to connect. Run: reelwright remote")); return; }
    h.append(el("div", { class: "card" }, el("h2", {}, "Status"), el("p", { class: d.state.health.canPublish ? "ok" : "warn" }, d.state.health.summary), el("p", { class: "muted" }, "Reelwright v" + d.state.version)));
    const root = $("#reels"); if (!root.contains(document.activeElement) || document.activeElement.tagName !== "TEXTAREA") {
      root.replaceChildren();
      if (!d.state.reels.length) root.append(el("div", { class: "card muted" }, "No reels yet."));
      for (const r of d.state.reels) {
        const ta = el("textarea", { maxlength: "2200", rows: "3" }); ta.value = r.caption;
        const card = el("div", { class: "card" }, el("h2", {}, r.hook), el("p", { class: "muted" }, r.id + " · " + r.status.replace("_", " ") + (r.error ? " · " + r.error : "")));
        if (r.permalink && /^https:\\/\\/(www\\.)?instagram\\.com\\//.test(r.permalink)) card.append(el("a", { href: r.permalink, target: "_blank", rel: "noopener noreferrer" }, "Open on Instagram"));
        if (editable.includes(r.status)) {
          card.append(ta,
            el("button", { onclick: async () => { try { await post({ type: "set_caption", reelId: r.id, caption: ta.value }); banner("Queued. It applies when your computer next syncs; you will need to approve the new caption again there."); load(); } catch (e) { banner(e.message, true); } } }, "Save caption"),
            el("button", { class: "alt", onclick: async () => { if (!confirm("Reject this reel?")) return; try { await post({ type: "reject_reel", reelId: r.id }); banner("Queued."); load(); } catch (e) { banner(e.message, true); } } }, "Reject"));
          if (r.status === "pending_approval") card.append(el("p", { class: "muted" }, "To approve: open the Reelwright panel on your computer."));
        }
        root.append(card);
      }
    }
    const th = $("#theme"); if (!themeInputs) {
      themeInputs = ["bg", "fg", "accent"].map((k) => { const i = el("input", { type: "color" }); i.value = k === "bg" ? "#10121a" : k === "fg" ? "#ffffff" : "#ff5a1f"; return [k, i]; });
      th.append(el("div", { class: "card" }, el("h2", {}, "Default colours"), ...themeInputs.map(([k, i]) => el("label", {}, k + " ", i, " ")),
        el("button", { onclick: async () => { try { const b = { type: "set_theme" }; for (const [k, i] of themeInputs) b[k] = i.value; await post(b); banner("Queued."); load(); } catch (e) { banner(e.message, true); } } }, "Save colours")));
    }
    const lg = $("#log"); lg.replaceChildren(el("div", { class: "card" }, el("h2", {}, "Recent requests"), ...(d.commands.length ? d.commands.map((c) => el("div", { class: "muted" }, c.command.type + " · " + c.status + (c.error ? " (" + c.error + ")" : ""))) : [el("div", { class: "muted" }, "None")])));
  }
  load(); setInterval(load, 15000);
})();`;
