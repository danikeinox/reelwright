"use strict";
(() => {
  // The token arrives in the URL fragment (never sent over the network) and is kept for this tab only.
  let token = "";
  try {
    const m = location.hash.match(/t=([\w-]+)/);
    if (m) { token = m[1]; sessionStorage.setItem("rw", token); history.replaceState(null, "", location.pathname); }
    else token = sessionStorage.getItem("rw") || "";
  } catch { /* storage blocked: the token only lives until reload */ }

  const $ = (s, r = document) => r.querySelector(s);
  // Everything from the server goes through textContent: no innerHTML anywhere.
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v != null) n.setAttribute(k, String(v));
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }

  async function api(method, path, body) {
    const res = await fetch("/api" + path, {
      method,
      headers: { authorization: "Bearer " + token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { banner("This panel link is no longer valid. Open it again with `reelwright ui` or ask Claude to open the dashboard.", true); throw new Error("Unauthorized"); }
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  let bannerTimer;
  function banner(text, bad) {
    const b = $("#banner");
    b.textContent = text; b.className = bad ? "error" : ""; b.hidden = false;
    clearTimeout(bannerTimer);
    if (!bad) bannerTimer = setTimeout(() => (b.hidden = true), 5000);
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== "Unauthorized") banner(e.message, true); } };

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
  const statusClass = (s) => ({ published: "ok", pending_approval: "warn", approved: "ok", failed: "bad", publish_unknown: "bad", rejected: "muted" }[s] || "muted");

  // ---------- tabs ----------
  const views = { overview: renderOverview, reels: renderReels, connections: renderConnections, brand: renderBrand };
  let current = "overview";
  function show(tab) {
    current = tab;
    for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === tab);
    for (const s of document.querySelectorAll("main section")) s.hidden = s.id !== tab;
    guard(views[tab])();
  }
  $("#tabs").addEventListener("click", (e) => { const t = e.target.dataset && e.target.dataset.tab; if (t) show(t); });

  // ---------- overview ----------
  async function renderOverview() {
    const { report, version } = await api("GET", "/status");
    $("#version").textContent = "v" + version;
    const root = $("#overview"); root.replaceChildren();
    root.append(el("div", { class: "card" }, el("h2", {}, "Status"), el("p", { class: report.canPublish ? "ok" : "warn" }, report.summary),
      report.checks.map((c) => el("div", { class: "check" },
        el("span", { class: c.status === "ok" ? "ok" : c.status === "fail" ? "bad" : c.status === "warn" ? "warn" : "muted" }, c.status === "ok" ? "✔" : c.status === "fail" ? "✖" : c.status === "warn" ? "!" : "·"),
        el("div", {}, el("strong", {}, c.name), " ", el("span", { class: "muted" }, c.detail), c.fix ? el("div", { class: "fix" }, "→ " + c.fix) : null)))));
    const reels = (await api("GET", "/reels")).reels;
    const waiting = reels.filter((r) => r.status === "pending_approval").length;
    root.append(el("div", { class: "card" }, el("h2", {}, "Reels"), el("p", {}, `${reels.length} in your queue. ${waiting ? waiting + " waiting for your review." : "Nothing waiting for review."}`),
      el("button", { class: "btn", onclick: () => show("reels") }, "Open reels")));
  }

  // ---------- reels ----------
  async function renderReels() {
    const root = $("#reels"); root.replaceChildren();
    const { reels } = await api("GET", "/reels");
    if (!reels.length) root.append(el("div", { class: "card muted" }, "No reels yet. Ask Claude to render one from your website."));
    for (const r of reels) {
      root.append(el("div", { class: "card reel", onclick: guard(() => openReel(r.id)) },
        el("div", {}, el("strong", {}, r.hook), el("div", { class: "muted" }, fmt(r.createdAt), " · ", r.id)),
        el("span", { class: "pill " + statusClass(r.status) }, r.status.replace("_", " "))));
    }
  }

  let videoUrl;
  async function openReel(id) {
    const r = await api("GET", "/reels/" + id);
    const root = $("#reels"); root.replaceChildren();
    if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
    root.append(el("button", { class: "btn alt", onclick: guard(renderReels) }, "← All reels"));
    const card = el("div", { class: "card" });
    card.append(el("h2", {}, r.hook), el("p", {}, el("span", { class: "pill " + statusClass(r.status) }, r.status.replace("_", " ")), " ", r.durationSeconds ? r.durationSeconds + " s" : "", r.voiceover ? " · voice-over" : ""));
    if (r.error) card.append(el("p", { class: "bad" }, r.error));
    if (r.hasVideo) {
      const v = el("video", { controls: true, playsinline: true });
      card.append(v);
      fetch("/api/reels/" + id + "/video", { headers: { authorization: "Bearer " + token } })
        .then((x) => x.blob()).then((b) => { videoUrl = URL.createObjectURL(b); v.src = videoUrl; });
    } else card.append(el("p", { class: "muted" }, r.status === "rendering" ? "Rendering… " + Math.round((r.progress || 0) * 100) + "%" : "No video."));
    const ta = el("textarea", { maxlength: 2200 }); ta.value = r.caption;
    card.append(el("h3", {}, "Caption that will be posted (" + r.caption.length + " characters, " + r.caption.split("\n").length + " lines)"),
      el("pre", { class: "cap" }, r.caption), el("h3", {}, "Edit caption"), ta);
    const editable = r.hasVideo && ["pending_approval", "approved", "publish_unknown", "failed"].includes(r.status);
    if (editable) card.append(el("button", { class: "btn alt", onclick: guard(async () => { await api("PUT", "/reels/" + id + "/caption", { caption: ta.value }); banner("Caption saved. Review and approve again."); openReel(id); }) }, "Save caption"));
    if (r.approval) card.append(el("p", { class: "muted" }, `Approved ${fmt(r.approval.at)} (${r.approval.via}).`));
    if (r.publish) card.append(el("p", { class: "ok" }, "Published " + fmt(r.publish.at) + " ", r.publish.permalink && /^https:\/\/(www\.)?instagram\.com\//.test(r.publish.permalink) ? el("a", { href: r.publish.permalink, target: "_blank", rel: "noopener noreferrer" }, "Open on Instagram") : null));
    if (["pending_approval", "publish_unknown"].includes(r.status) && r.hasVideo) {
      if (r.status === "publish_unknown") card.append(el("p", { class: "bad" }, "Instagram did not confirm this post. Check your Instagram profile first: approving again may post it twice."));
      const approve = el("button", { class: "btn", onclick: guard(async () => { await api("POST", "/reels/" + id + "/approve", { sha256: r.sha256, captionSha256: r.captionSha256 }); banner("Approved."); openReel(id); }) }, "Approve this video and caption");
      ta.addEventListener("input", () => { approve.disabled = ta.value !== r.caption; });
      card.append(el("p", { class: "muted" }, "Watch the whole video and read the caption above. Approving covers exactly this video and this caption. Save your edits first if you changed the text."), approve);
    }
    if (r.status === "approved") {
      card.append(el("button", { class: "btn", onclick: guard(async (ev) => {
        if (!confirm("Publish this reel to Instagram now? It will be public.")) return;
        ev.target.disabled = true; banner("Publishing… this can take a few minutes.");
        try { await api("POST", "/reels/" + id + "/publish", {}); banner("Published."); } finally { openReel(id); }
      }) }, "Publish to Instagram"));
    }
    if (["pending_approval", "approved", "publish_unknown", "failed"].includes(r.status)) {
      card.append(el("button", { class: "btn alt danger", onclick: guard(async () => { await api("POST", "/reels/" + id + "/reject", {}); openReel(id); }) }, "Reject"));
    }
    root.append(card);
  }

  // ---------- connections ----------
  function field(label, input) { return el("div", {}, el("label", {}, label), input); }
  function textInput(value, type = "text", ph = "") { const i = el("input", { type, placeholder: ph, autocomplete: "off", spellcheck: "false" }); i.value = value || ""; return i; }

  async function renderConnections() {
    const c = await api("GET", "/config");
    const root = $("#connections"); root.replaceChildren();

    // Instagram
    const igToken = textInput("", "password", c.instagram.hasToken ? "•••••• saved (leave empty to keep)" : "Paste your access token");
    const igUser = textInput(c.instagram.userId, "text", "Numeric Instagram user id");
    const ig = el("div", { class: "card" }, el("h2", {}, "Instagram"),
      el("p", { class: c.instagram.connected ? "ok" : "warn" }, c.instagram.connected ? "Connected" + (c.instagram.tokenRefreshedAt ? " · token refreshed " + fmt(c.instagram.tokenRefreshedAt) : "") : "Not connected"),
      field("Access token", igToken), field("User id", igUser),
      el("button", { class: "btn", onclick: guard(async () => { await api("PUT", "/config", { instagram: { accessToken: igToken.value, userId: igUser.value } }); banner("Saved."); renderConnections(); }) }, "Save"),
      el("button", { class: "btn alt", onclick: guard(async () => { const r = await api("POST", "/test/instagram"); banner("Works: @" + (r.username || "?") + " (" + (r.accountType || "?") + ")"); }) }, "Test"),
      el("p", { class: "fix" }, "How to get a token: docs/instagram.md in the Reelwright repository."));

    // Storage
    const mode = el("select", {}, el("option", { value: "tunnel" }, "Temporary Cloudflare tunnel (free, no account)"), el("option", { value: "s3" }, "My own S3 / R2 bucket"));
    mode.value = c.storage.mode;
    const s3 = c.storage.s3 || {};
    const f = { endpoint: textInput(s3.endpoint, "url", "https://<account>.r2.cloudflarestorage.com"), region: textInput(s3.region || "auto"), bucket: textInput(s3.bucket), prefix: textInput(s3.prefix || "reelwright/"),
      accessKeyId: textInput("", "password", s3.hasKeys ? "•••••• saved" : ""), secretAccessKey: textInput("", "password", s3.hasKeys ? "•••••• saved" : "") };
    const s3box = el("div", {}, field("Endpoint (empty for AWS)", f.endpoint), field("Region", f.region), field("Bucket", f.bucket), field("Prefix", f.prefix), field("Access key id", f.accessKeyId), field("Secret access key", f.secretAccessKey));
    const toggle = () => (s3box.hidden = mode.value !== "s3"); mode.addEventListener("change", toggle); toggle();
    const st = el("div", { class: "card" }, el("h2", {}, "Storage"), field("Where Instagram downloads the video from", mode), s3box,
      el("button", { class: "btn", onclick: guard(async () => {
        const patch = { storage: { mode: mode.value } };
        if (mode.value === "s3") patch.storage.s3 = { endpoint: f.endpoint.value, region: f.region.value, bucket: f.bucket.value, prefix: f.prefix.value, accessKeyId: f.accessKeyId.value, secretAccessKey: f.secretAccessKey.value };
        await api("PUT", "/config", patch); banner("Saved."); renderConnections();
      }) }, "Save"),
      el("button", { class: "btn alt", onclick: guard(async () => { const r = await api("POST", "/test/storage"); banner(r.message, !r.ok); }) }, "Test"));

    // Voice
    const en = el("input", { type: "checkbox" }); en.checked = c.tts.enabled;
    const t = { baseUrl: textInput(c.tts.baseUrl, "url", "http://127.0.0.1:PORT/v1"), model: textInput(c.tts.model), voice: textInput(c.tts.voice), apiKey: textInput("", "password", c.tts.hasApiKey ? "•••••• saved" : "optional") };
    const vo = el("div", { class: "card" }, el("h2", {}, "Voice-over (VoiceStudio or any OpenAI-compatible TTS)"),
      el("label", {}, en, " Enable voice-over"), field("Base URL", t.baseUrl), field("Model", t.model), field("Voice", t.voice), field("API key", t.apiKey),
      el("button", { class: "btn", onclick: guard(async () => { await api("PUT", "/config", { tts: { enabled: en.checked, baseUrl: t.baseUrl.value, model: t.model.value, voice: t.voice.value, apiKey: t.apiKey.value } }); banner("Saved."); renderConnections(); }) }, "Save"),
      el("button", { class: "btn alt", onclick: guard(async () => { const r = await api("POST", "/test/voice"); banner(r.message); }) }, "Test"));

    // Safety
    const cr = el("input", { type: "checkbox" }); cr.checked = c.safety.confirmReplies;
    cr.addEventListener("change", guard(async () => { await api("PUT", "/config", { safety: { confirmReplies: cr.checked } }); banner("Saved."); }));
    const sf = el("div", { class: "card" }, el("h2", {}, "Safety"), el("label", {}, cr, " Ask me before the AI posts a public reply to a comment"));
    const rm = el("div", { class: "card" }, el("h2", {}, "Remote dashboard (optional)"),
      el("p", { class: c.remote.configured ? "ok" : "muted" }, c.remote.configured ? "Configured: " + c.remote.url : "Not set up. You do not need it; it only lets you check status from your phone."),
      el("p", { class: "fix" }, "It can show status, edit captions, reject reels and change colours. It can never approve or publish and never receives a token. Guide: worker/README.md. Set it up with `reelwright remote init`."));
    root.append(ig, st, vo, sf, rm);
  }

  // ---------- brand ----------
  async function renderBrand() {
    const { brand } = await api("GET", "/brand");
    const root = $("#brand"); root.replaceChildren();
    const url = textInput(brand ? brand.sourceUrl : "", "url", "https://your-website.com");
    root.append(el("div", { class: "card" }, el("h2", {}, "Brand"), field("Your website", url),
      el("button", { class: "btn", onclick: guard(async () => { banner("Reading the website…"); await api("POST", "/brand", { url: url.value }); banner("Brand updated."); renderBrand(); }) }, brand ? "Refresh from website" : "Read my website")));
    if (brand) {
      const sw = (c) => { const chip = el("span", { class: "swatch" }); if (/^#[0-9a-f]{6}$/i.test(c)) chip.style.background = c; return el("span", {}, chip, c, " "); };
      root.append(el("div", { class: "card" }, el("h3", {}, brand.name), el("p", { class: "muted" }, brand.description || ""),
        el("p", {}, "Theme: ", sw(brand.theme.bg), sw(brand.theme.fg), sw(brand.theme.accent)),
        el("p", {}, "Fonts: ", (brand.fonts || []).join(", ") || "—"),
        el("p", { class: "fix" }, "Text read from your website is treated as data by Reelwright, never as instructions.")));
    }
  }

  if (!token) banner("Open this panel with `reelwright ui`, or ask Claude to open the dashboard.", true);
  else show("overview");
})();
