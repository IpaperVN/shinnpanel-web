"use strict";

const $ = (id) => document.getElementById(id);

// ---- shared fetch helper (same-origin session cookie) ----
async function api(url, opts) {
  opts = opts || {};
  const headers = { ...(opts.headers || {}) };
  // CSRF guard: non-GET /api/* requires this header server-side; cross-origin
  // pages can't set it without a CORS preflight.
  if (!/^get$/i.test(opts.method || "GET")) headers["X-Requested-With"] = "XMLHttpRequest";
  return fetch(url, { credentials: "same-origin", ...opts, headers });
}

async function apiJson(url, opts) {
  const res = await api(url, opts);
  if (res.status === 401) { window.location.href = "/login"; return null; }
  return res;
}


// ================= Tabs =================
const navItems = document.querySelectorAll(".navitem");
const tabs = document.querySelectorAll(".tab");

/** Tables fetched the first time their tab is opened. */
const LAZY_TABS = {
  licenses: loadLicenses, scheduled: loadScheduled,
  stats: loadStats, settings: loadSettings, logs: loadLogs,
};

/** Fire-and-forget: log a failure instead of leaving the rejection unhandled. */
function run(task) {
  Promise.resolve(task()).catch((e) => console.error(e));
}

function switchTab(name) {
  document.querySelectorAll(".navitem").forEach((n) => n.classList.toggle("active", n.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  // lazy-load each table the first time its tab is opened
  const lazy = LAZY_TABS[name];
  if (lazy && !window._loaded[name]) {
    window._loaded[name] = true;
    run(lazy);
  }
  // ESPaper is re-fetched every time — the gateway caches its upstream call for 15s.
  if (name === "espaper") {
    window._loaded.espaper = true;
    run(loadEspaper);
  }
  // Cuộn lên đầu nội dung khi chuyển tab (đỡ mất chỗ trên mobile).
  window.scrollTo(0, 0);
}

navItems.forEach((n) => n.addEventListener("click", () => switchTab(n.dataset.tab)));

// ================= Formatting helpers =================
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// URL scheme allowlist — only http(s), data images and relative URLs survive.
// Blocks javascript:/vbscript:/data:text/html in href/src (preview renders user input).
function safeUrl(u) {
  const s = (u || "").trim();
  if (/^(https?:)?\/\//i.test(s) || /^\//.test(s)) return s;
  if (/^data:image\/(png|gif|jpe?g|webp);base64,/i.test(s)) return s;
  return "#";
}
function shortId(s) { return (s || "").length > 10 ? "…" + s.slice(-10) : s; }
function fmtTs(ts) {
  if (!ts) return "—";
  const n = Number(ts);
  // accept both epoch seconds (10 digits) and millis (13 digits)
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toLocaleString("vi-VN");
}
function badge(text, kind) {
  return `<span class="badge badge-${kind || "default"}">${escapeHtml(text)}</span>`;
}
function emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="empty">${escapeHtml(msg || "Không có dữ liệu")}</td></tr>`;
}

function hideOnErr(imgs) {
  imgs.forEach((im) => {
    if (im.dataset && im.dataset.img === "hide-on-err") {
      im.addEventListener("error", () => { im.style.display = "none"; });
    }
  });
}

// ================= Editor =================
const el = {
  channel: $("channel"), reloadChannels: $("reloadChannels"),
  templateSelect: $("templateSelect"), loadTemplate: $("loadTemplate"), deleteTemplate: $("deleteTemplate"),
  content: $("content"), contentCounter: $("contentCounter"), embedCount: $("embedCount"),
  presetSelect: $("presetSelect"),
  webhookName: $("webhookName"), webhookAvatar: $("webhookAvatar"),
  addEmbedBtn: $("addEmbedBtn"), embedsList: $("embedsList"),
  sendBtn: $("sendBtn"), sendTestBtn: $("sendTestBtn"), saveTemplateBtn: $("saveTemplateBtn"),
  clearDraftBtn: $("clearDraftBtn"),
  testChannel: $("testChannel"),
  status: $("status"), preview: $("preview"),
};

function setStatus(msg, kind) {
  el.status.textContent = msg;
  el.status.className = "status" + (kind ? " " + kind : "");
  if (msg) setTimeout(() => { if (el.status.textContent === msg) { el.status.textContent = ""; el.status.className = "status"; } }, 4000);
}

function hexToInt(hex) { return parseInt((hex || "").replace("#", ""), 16) || 0; }
function intToHex(int) { return "#" + ((int & 0xffffff) || 0x5865f2).toString(16).padStart(6, "0"); }
function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex) {
  const n = hexToInt(hex);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return rgbToHex(r + m * 255, g + m * 255, b + m * 255);
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
const PRESET_COLORS = [
  "#5865F2", "#984FED", "#F23F43", "#FAA61A", "#FEE75C",
  "#23A55A", "#3BA55C", "#1ABC9C", "#00A8FC", "#EB459E", "#FFFFFF", "#000000",
];
function defaultEmbed() {
  return {
    authorName: "", authorUrl: "",
    title: "", url: "",
    description: "",
    color: "#5865F2",
    thumbnail: "", image: "",
    footer: "", footerIcon: "",
    timestamp: false,
    fields: [],
  };
}
function blankField() { return { name: "", value: "", inline: false }; }

// Discord embed limits (used by character counters).
const LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  embedTotal: 6000,
  maxEmbeds: 10,
  maxFieldsPerEmbed: 25,
};

// LocalStorage keys for auto-save draft + remembered test channel.
const DRAFT_KEY = "authbot.editor.draft.v1";
const TEST_CHANNEL_KEY = "authbot.editor.testChannel";

function embedTotalChars(e) {
  return (e.title.length) + (e.url.length) + (e.description.length) +
    (e.authorName.length) + (e.authorUrl.length) + (e.thumbnail.length) +
    (e.image.length) + (e.footer.length) + (e.footerIcon.length) +
    e.fields.reduce((s, f) => s + (f.name.length + f.value.length), 0);
}

// Editor state — the single source of truth the whole editor renders from.
let state = {
  content: "",
  webhookName: "AuthBot",
  webhookAvatar: "",
  embeds: [],
};

function freshEmbed() {
  const e = defaultEmbed();
  e.fields = [blankField()];
  return e;
}

function embedToData(e) {
  const out = {};
  if (e.title.trim()) out.title = e.title.trim();
  if (e.url.trim()) out.url = e.url.trim();
  if (e.description.trim()) out.description = e.description.trim();
  if (e.color) out.color = hexToInt(e.color);
  if (e.authorName.trim()) out.author = { name: e.authorName.trim(), ...(e.authorUrl.trim() ? { url: e.authorUrl.trim() } : {}) };
  if (e.thumbnail.trim()) out.thumbnail = { url: e.thumbnail.trim() };
  if (e.image.trim()) out.image = { url: e.image.trim() };
  if (e.footer.trim()) out.footer = { text: e.footer.trim(), ...(e.footerIcon.trim() ? { icon_url: e.footerIcon.trim() } : {}) };
  if (e.timestamp) out.timestamp = new Date().toISOString();
  const fields = e.fields
    .filter((f) => f.name.trim() && f.value.trim())
    .map((f) => ({ name: f.name.trim(), value: f.value.trim(), inline: !!f.inline }));
  if (fields.length) out.fields = fields;
  return out;
}

function buildPayload() {
  const payload = {};
  const content = el.content.value.trim();
  if (content) payload.content = content;
  const embeds = state.embeds.map(embedToData).filter((e) => Object.keys(e).length > 0);
  if (embeds.length) payload.embeds = embeds;
  return payload;
}

function parseEmbedData(embed) {
  const e = defaultEmbed();
  if (embed == null) { e.fields = [blankField()]; return e; }
  e.title = embed.title || "";
  e.url = embed.url || "";
  e.description = embed.description || "";
  e.color = embed.color != null ? intToHex(embed.color) : "#5865F2";
  e.thumbnail = (embed.thumbnail && embed.thumbnail.url) || "";
  e.image = (embed.image && embed.image.url) || "";
  e.footer = (embed.footer && embed.footer.text) || "";
  e.footerIcon = (embed.footer && embed.footer.icon_url) || "";
  e.timestamp = !!embed.timestamp;
  if (embed.author) {
    e.authorName = embed.author.name || "";
    e.authorUrl = embed.author.url || "";
  }
  if (Array.isArray(embed.fields) && embed.fields.length) {
    e.fields = embed.fields.map((f) => ({
      name: (f && f.name) || "",
      value: (f && f.value) || "",
      inline: !!(f && f.inline),
    }));
  } else {
    e.fields = [blankField()];
  }
  return e;
}

function loadPayload(payload) {
  state.content = payload.content || "";
  state.webhookName = payload.username || "AuthBot";
  state.webhookAvatar = payload.avatar_url || "";
  state.embeds = (payload.embeds || []).map(parseEmbedData);
  el.content.value = state.content;
  el.webhookName.value = state.webhookName;
  el.webhookAvatar.value = state.webhookAvatar;
  renderEditor();
  renderPreview();
}

// ================= Editor rendering (embeds list) =================
function embedCardHtml(e, i) {
  const total = embedTotalChars(e);
  const over = total > LIMITS.embedTotal;
  const fieldsHtml = e.fields.map((f, fi) => `
    <div class="field-row" data-fi="${fi}">
      <input type="text" class="fld-name" placeholder="Tên" value="${escapeHtml(f.name)}" />
      <input type="text" class="fld-value" placeholder="Giá trị" value="${escapeHtml(f.value)}" />
      <span class="fld-count" data-fn="${fi}" data-kind="name">${f.name.length}/${LIMITS.fieldName}</span>
      <span class="fld-count" data-fn="${fi}" data-kind="value">${f.value.length}/${LIMITS.fieldValue}</span>
      <label class="fld-inline" title="Hiện trên cùng hàng">
        <input type="checkbox" class="fld-inline-cb" ${f.inline ? "checked" : ""} /> inline
      </label>
      <button type="button" class="btn small ghost del-field" title="Xoá field">✕</button>
    </div>`).join("");
  return `
  <div class="embed-card ${over ? "field-over" : ""}" data-i="${i}">
    <div class="embed-card-head">
      <span class="embed-card-title">Embed #${i + 1}</span>
      <span class="embed-count-badge counter ${over ? "over" : (total > LIMITS.embedTotal * 0.9 ? "warn" : "")}">${total}/${LIMITS.embedTotal}</span>
      <div class="embed-card-actions">
        <button type="button" class="btn small ghost move-embed" data-dir="-1" title="Lên">↑</button>
        <button type="button" class="btn small ghost move-embed" data-dir="1" title="Xuống">↓</button>
        <button type="button" class="btn small ghost danger del-embed" title="Xoá embed">🗑</button>
      </div>
    </div>
    <div class="embed-fields">
      <div class="row"><label>Author</label>
        <div class="row-pair">
          <input type="text" class="ed-authorName" placeholder="Tên" value="${escapeHtml(e.authorName)}" />
          <input type="text" class="ed-authorUrl" placeholder="URL" value="${escapeHtml(e.authorUrl)}" />
        </div>
      </div>
      <div class="row"><label>Tiêu đề <span class="counter" data-limit="title">0/${LIMITS.title}</span></label>
        <div class="row-pair">
          <input type="text" class="ed-title" placeholder="Tiêu đề" value="${escapeHtml(e.title)}" />
          <input type="text" class="ed-url" placeholder="URL tiêu đề" value="${escapeHtml(e.url)}" />
        </div>
      </div>
      <div class="row"><label>Mô tả <span class="counter" data-limit="description">0/${LIMITS.description}</span></label>
        <textarea class="ed-desc" rows="4" placeholder="Mô tả">${escapeHtml(e.description)}</textarea>
      </div>
      <div class="row"><label>Màu</label>
        <div class="color-row">
          <button type="button" class="color-swatch" data-open-picker="${i}" style="background:${e.color}" title="Chọn màu"></button>
          <input type="text" class="ed-color-hex" value="${e.color}" placeholder="#5865F2" />
          <span class="color-hex-hint">#RRGGBB</span>
        </div>
      </div>
      <div class="row"><label>Thumbnail URL</label><input type="text" class="ed-thumb" value="${escapeHtml(e.thumbnail)}" placeholder="https://..." /></div>
      <div class="row"><label>Image URL</label><input type="text" class="ed-image" value="${escapeHtml(e.image)}" placeholder="https://..." /></div>
      <div class="row"><label>Footer</label>
        <div class="row-pair">
          <input type="text" class="ed-footer" placeholder="Text" value="${escapeHtml(e.footer)}" />
          <input type="text" class="ed-footerIcon" placeholder="Icon URL" value="${escapeHtml(e.footerIcon)}" />
        </div>
      </div>
      <div class="row inline-check">
        <label class="chk"><input type="checkbox" class="ed-timestamp" ${e.timestamp ? "checked" : ""} /> Hiện timestamp</label>
      </div>
      <div class="field-head">
        <span class="fields-label">Fields <span class="counter">${e.fields.length}/${LIMITS.maxFieldsPerEmbed}</span></span>
        <button type="button" class="btn small ghost add-field" data-i="${i}">＋ Thêm field</button>
      </div>
      <div class="fields-list">${fieldsHtml}</div>
      <div class="limit-note">Giới hạn: 10 embed / tin nhắn, 25 field / embed, tối đa ${LIMITS.embedTotal} ký tự / embed.</div>
    </div>
  </div>`;
}

function renderEditor() {
  el.embedsList.innerHTML = state.embeds.map(embedCardHtml).join("") ||
    '<div class="no-embeds">Chưa có embed — bấm "＋ Thêm embed" để bắt đầu.</div>';
  renderCounters();
}

function setCount(el, cur, max) {
  if (!el) return;
  el.textContent = cur + "/" + max;
  el.classList.toggle("over", cur > max);
  el.classList.toggle("warn", cur <= max && cur > max * 0.9);
}

function renderCounters() {
  // message-level
  setCount(el.contentCounter, el.content.value.length, LIMITS.content);
  setCount(el.embedCount, state.embeds.length, LIMITS.maxEmbeds);
  // per-embed cards
  state.embeds.forEach((e, i) => {
    const card = el.embedsList.querySelector(`.embed-card[data-i="${i}"]`);
    if (!card) return;
    setCount(card.querySelector("[data-limit='title']"), e.title.length, LIMITS.title);
    setCount(card.querySelector("[data-limit='description']"), e.description.length, LIMITS.description);
    const total = embedTotalChars(e);
    const badge = card.querySelector(".embed-count-badge");
    if (badge) setCount(badge, total, LIMITS.embedTotal);
    card.classList.toggle("field-over", total > LIMITS.embedTotal);
    e.fields.forEach((f, fi) => {
      const n = card.querySelector(`.fld-count[data-fn="${fi}"][data-kind="name"]`);
      const v = card.querySelector(`.fld-count[data-fn="${fi}"][data-kind="value"]`);
      setCount(n, f.name.length, LIMITS.fieldName);
      setCount(v, f.value.length, LIMITS.fieldValue);
    });
  });
}

// Debounced preview so typing stays cheap.
let _previewTimer = null;
function schedulePreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(renderPreview, 40);
}

function embedIndexOf(elm) {
  const card = elm.closest(".embed-card");
  return card ? Number(card.dataset.i) : -1;
}

function syncEmbedFromCard(card) {
  const i = Number(card.dataset.i);
  if (i < 0 || i >= state.embeds.length) return;
  const e = state.embeds[i];
  e.authorName = card.querySelector(".ed-authorName").value;
  e.authorUrl = card.querySelector(".ed-authorUrl").value;
  e.title = card.querySelector(".ed-title").value;
  e.url = card.querySelector(".ed-url").value;
  e.description = card.querySelector(".ed-desc").value;
  e.thumbnail = card.querySelector(".ed-thumb").value;
  e.image = card.querySelector(".ed-image").value;
  e.footer = card.querySelector(".ed-footer").value;
  e.footerIcon = card.querySelector(".ed-footerIcon").value;
  e.timestamp = card.querySelector(".ed-timestamp").checked;
  const hex = card.querySelector(".ed-color-hex").value.trim();
  e.color = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : e.color;
  // fields
  e.fields = Array.from(card.querySelectorAll(".field-row")).map((row, fi) => {
    const name = row.querySelector(".fld-name").value;
    const value = row.querySelector(".fld-value").value;
    const inline = row.querySelector(".fld-inline-cb").checked;
    return { name, value, inline };
  });
}

function refreshColorSwatch(card) {
  const i = Number(card.dataset.i);
  const swatch = card.querySelector(".color-swatch");
  if (swatch) swatch.style.background = state.embeds[i].color;
}

function onEditorInput(e) {
  const card = e.target.closest(".embed-card");
  if (!card) return;
  syncEmbedFromCard(card);
  if (e.target.classList.contains("ed-color-hex")) refreshColorSwatch(card);
  schedulePreview();
  scheduleSaveDraft();
}

function onEmbedListClick(e) {
  const target = e.target;
  // move embed up/down
  if (target.classList.contains("move-embed")) {
    const i = embedIndexOf(target);
    if (i < 0) return;
    const dir = Number(target.dataset.dir);
    const j = i + dir;
    if (j < 0 || j >= state.embeds.length) return;
    [state.embeds[i], state.embeds[j]] = [state.embeds[j], state.embeds[i]];
    renderEditor(); renderPreview(); scheduleSaveDraft();
    return;
  }
  // delete embed
  if (target.classList.contains("del-embed")) {
    const i = embedIndexOf(target);
    if (i < 0) return;
    state.embeds.splice(i, 1);
    renderEditor(); renderPreview(); scheduleSaveDraft();
    return;
  }
  // add field to embed i
  if (target.classList.contains("add-field")) {
    const i = Number(target.dataset.i);
    if (i < 0 || i >= state.embeds.length) return;
    state.embeds[i].fields.push(blankField());
    renderEditor(); scheduleSaveDraft();
    return;
  }
  // delete a field
  if (target.classList.contains("del-field")) {
    const i = embedIndexOf(target);
    const row = target.closest(".field-row");
    if (i < 0 || !row) return;
    state.embeds[i].fields.splice(Number(row.dataset.fi), 1);
    renderEditor(); renderPreview(); scheduleSaveDraft();
    return;
  }
  // open the color picker for embed i
  if (target.classList.contains("color-swatch")) {
    const i = Number(target.dataset.openPicker);
    if (i >= 0 && i < state.embeds.length) openColorPicker(target, i);
  }
}

// ================= Discord-style gradient color picker =================
let activePicker = null; // { root, embedIndex, h, s, l }

function colorPickerMarkup() {
  return `
  <div class="cp-pop">
    <div class="cp-sv" title="Bão hoà / Độ sáng">
      <div class="cp-sv-white"></div>
      <div class="cp-sv-black"></div>
      <div class="cp-sv-dot"></div>
    </div>
    <div class="cp-controls">
      <input type="range" class="cp-hue" min="0" max="360" step="1" value="220" aria-label="Màu sắc" />
      <input type="text" class="cp-hex" value="#5865F2" placeholder="#5865F2" />
    </div>
    <div class="cp-swatches">
      ${PRESET_COLORS.map((c) => `<button type="button" class="cp-swatch" data-c="${c}" style="background:${c}"></button>`).join("")}
    </div>
  </div>`;
}

function positionPicker(swatchEl) {
  const pop = activePicker.root;
  const r = swatchEl.getBoundingClientRect();
  pop.style.visibility = "hidden";
  pop.style.display = "block";
  const pr = pop.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 8;
  if (left + pr.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pr.width - 8);
  if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 8);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  pop.style.visibility = "visible";
}

function syncPickerUI() {
  const { h, s, l, root, embedIndex } = activePicker;
  root.querySelector(".cp-sv").style.background = `hsl(${h}, 100%, 50%)`;
  root.querySelector(".cp-hue").value = h;
  root.querySelector(".cp-sv-dot").style.background = hslToRgb(h, s, l);
  const x = s / 100, y = 1 - l / 100;
  root.querySelector(".cp-sv-dot").style.left = (x * 100) + "%";
  root.querySelector(".cp-sv-dot").style.top = (y * 100) + "%";
  root.querySelector(".cp-hex").value = state.embeds[embedIndex].color.toUpperCase();
}

function setPickerColor(hex) {
  if (!activePicker) return;
  const { embedIndex, root } = activePicker;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  state.embeds[embedIndex].color = hex.toLowerCase();
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  activePicker.h = hsl.h; activePicker.s = hsl.s; activePicker.l = hsl.l;
  syncPickerUI();
  // reflect into the embed card hex input
  const card = el.embedsList.querySelector(`.embed-card[data-i="${embedIndex}"]`);
  if (card) {
    const hexInput = card.querySelector(".ed-color-hex");
    if (hexInput) hexInput.value = hex.toUpperCase();
    refreshColorSwatch(card);
  }
  renderPreview();
}

function openColorPicker(swatchEl, embedIndex) {
  closeColorPicker();
  const pop = document.createElement("div");
  pop.className = "color-picker";
  pop.innerHTML = colorPickerMarkup();
  document.body.appendChild(pop);
  const { r, g, b } = hexToRgb(state.embeds[embedIndex].color);
  const hsl = rgbToHsl(r, g, b);
  activePicker = { root: pop, embedIndex, h: hsl.h, s: hsl.s, l: hsl.l };
  positionPicker(swatchEl);
  syncPickerUI();

  // SV square drag
  const sv = pop.querySelector(".cp-sv");
  function updateFromSVPointer(ev) {
    const rect = sv.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
    activePicker.s = Math.round(x * 100);
    activePicker.l = Math.round((1 - y) * 100);
    setPickerColor(hslToRgb(activePicker.h, activePicker.s, activePicker.l));
  }
  sv.addEventListener("mousedown", (ev) => {
    updateFromSVPointer(ev);
    const move = (e2) => updateFromSVPointer(e2);
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // hue slider
  pop.querySelector(".cp-hue").addEventListener("input", (ev) => {
    activePicker.h = Number(ev.target.value);
    setPickerColor(hslToRgb(activePicker.h, activePicker.s, activePicker.l));
  });

  // hex input
  pop.querySelector(".cp-hex").addEventListener("input", (ev) => {
    let v = ev.target.value.trim();
    if (!v.startsWith("#")) v = "#" + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setPickerColor(v);
  });
  pop.querySelector(".cp-hex").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") closeColorPicker();
  });

  // presets
  pop.querySelectorAll(".cp-swatch").forEach((b) =>
    b.addEventListener("click", () => setPickerColor(b.dataset.c)));

  // global: click outside closes, Esc closes
  setTimeout(() => {
    document.addEventListener("click", onClickOutside, true);
  }, 0);
  document.addEventListener("keydown", onPickerKey, true);
}

function onClickOutside(ev) {
  if (!activePicker) return;
  if (!activePicker.root.contains(ev.target) && !ev.target.classList.contains("color-swatch")) {
    closeColorPicker();
  }
}
function onPickerKey(ev) {
  if (ev.key === "Escape") closeColorPicker();
}
function closeColorPicker() {
  if (!activePicker) return;
  activePicker.root.remove();
  document.removeEventListener("click", onClickOutside, true);
  document.removeEventListener("keydown", onPickerKey, true);
  activePicker = null;
}

// ================= Live preview (Discord-like) =================
function markdownLite(text) {
  const esc = escapeHtml(text);
  const lines = esc.split("\n").map((line) => {
    if (/^&gt;\s?/.test(line)) return `<span class="md-quote">${line.replace(/^&gt;\s?/, "")}</span>`;
    return line;
  });
  return lines.join("<br>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>");
}

function previewFieldGrid(fields) {
  let html = "";
  const cell = (f) => `<div class="pf-cell"><div class="pf-name">${markdownLite(f.name)}</div><div class="pf-value">${markdownLite(f.value)}</div></div>`;
  // inline fields flow left-to-right in up to 3 columns, like Discord
  let buf = [], bufCount = 0;
  const flush = () => {
    if (buf.length) {
      html += `<div class="pf-row">${buf.join("")}</div>`;
      buf = []; bufCount = 0;
    }
  };
  fields.forEach((f) => {
    if (f.inline && bufCount < 3) {
      buf.push(cell(f));
      bufCount++;
    } else {
      flush();
      html += `<div class="pf-row">${cell(f)}</div>`;
    }
  });
  flush();
  return html;
}

function renderPreview() {
  const p = buildPayload();
  const name = state.webhookName.trim() || "AuthBot";
  const avatar = state.webhookAvatar.trim();
  const now = new Date();
  const time = now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  let html = "";
  html += `<div class="pv-head">
      ${avatar
        ? `<img class="pv-avatar" src="${escapeHtml(safeUrl(avatar))}" alt="" data-img="hide-on-err" />`
        : `<div class="pv-avatar pv-avatar-fallback">${escapeHtml((name[0] || "B").toUpperCase())}</div>`}
      <div class="pv-meta">
        <span class="pv-name">${escapeHtml(name)}</span>
        <span class="pv-time">Hôm nay lúc ${time}</span>
      </div>
    </div>`;
  if (p.content) html += `<div class="discord-content">${markdownLite(p.content)}</div>`;
  (p.embeds || []).forEach((embed) => {
    const color = intToHex(embed.color || 0x5865f2);
    html += `<div class="embed-preview" style="border-left-color:${color}"><div class="embed-main">`;
    if (embed.author) html += `<div class="embed-author">${markdownLite(embed.author.name)}</div>`;
    if (embed.title) {
      html += embed.url
        ? `<div class="embed-title"><a href="${escapeHtml(safeUrl(embed.url))}" target="_blank" rel="noopener">${markdownLite(embed.title)}</a></div>`
        : `<div class="embed-title">${markdownLite(embed.title)}</div>`;
    }
    if (embed.description) html += `<div class="embed-desc">${markdownLite(embed.description)}</div>`;
    if (embed.fields && embed.fields.length) html += `<div class="embed-fields-grid">${previewFieldGrid(embed.fields)}</div>`;
    if (embed.image) html += `<img class="embed-image" src="${escapeHtml(safeUrl(embed.image.url))}" alt="" data-img="hide-on-err" />`;
    if (embed.footer) html += `<div class="embed-footer">${embed.footer.icon_url ? `<img class="embed-footer-icon" src="${escapeHtml(safeUrl(embed.footer.icon_url))}" alt="" data-img="hide-on-err" />` : ""}${markdownLite(embed.footer.text)}</div>`;
    html += `</div>`;
    if (embed.thumbnail) html += `<img class="embed-thumb" src="${escapeHtml(safeUrl(embed.thumbnail.url))}" alt="" data-img="hide-on-err" />`;
    html += `</div>`;
  });
  el.preview.innerHTML = html || '<span style="color:var(--muted)">Chưa có nội dung…</span>';
  // CSP: no inline onerror — hide broken <img> after render.
  hideOnErr(el.preview.querySelectorAll("img[data-img='hide-on-err']"));
}

// ================= Embed presets =================
const EMBED_PRESETS = {
  success: { title: "✅ Thành công", description: "Thao tác đã hoàn tất thành công.", color: "#23A55A" },
  error: { title: "❌ Lỗi", description: "Đã xảy ra lỗi, vui lòng thử lại sau.", color: "#F23F43" },
  info: { title: "ℹ️ Thông báo", description: "Đây là thông báo dành cho bạn.", color: "#5865F2" },
  warning: { title: "⚠️ Cảnh báo", description: "Hãy kiểm tra lại thông tin trước khi tiếp tục.", color: "#FAA61A" },
  giveaway: { title: "🎉 GIVEAWAY", description: "Nhấn nút phía dưới để tham gia!", footer: "Kết thúc sau 24h", color: "#EB459E" },
  announcement: { title: "📢 Thông báo chung", description: "Xin chào mọi người!\n\nVui lòng đọc kỹ thông tin dưới đây.", color: "#1ABC9C" },
};

function applyPreset(value) {
  if (!value || !EMBED_PRESETS[value]) return;
  const p = EMBED_PRESETS[value];
  const e = defaultEmbed();
  e.title = p.title;
  e.description = p.description;
  e.color = p.color;
  e.footer = p.footer || "";
  state.embeds.push(e);
  el.presetSelect.value = "";
  renderEditor();
  renderPreview();
  scheduleSaveDraft();
}

// ================= Auto-save draft to localStorage =================
function saveDraft() {
  try {
    const draft = {
      content: el.content.value,
      webhookName: el.webhookName.value,
      webhookAvatar: el.webhookAvatar.value,
      embeds: state.embeds,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch { /* quota exceeded, ignore */ }
}

let _saveDraftTimer = null;
function scheduleSaveDraft() {
  clearTimeout(_saveDraftTimer);
  _saveDraftTimer = setTimeout(saveDraft, 300);
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== "object") return false;
    state.content = draft.content || "";
    state.webhookName = draft.webhookName || "AuthBot";
    state.webhookAvatar = draft.webhookAvatar || "";
    state.embeds = (draft.embeds || []).map(parseEmbedData);
    if (!state.embeds.length) state.embeds = [];
    el.content.value = state.content;
    el.webhookName.value = state.webhookName;
    el.webhookAvatar.value = state.webhookAvatar;
    return true;
  } catch { return false; }
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
  localStorage.removeItem(TEST_CHANNEL_KEY);
  setStatus("Đã xoá draft", "ok");
}

// ================= Send-test (remembers test channel) =================
async function loadTestChannel() {
  try {
    const saved = localStorage.getItem(TEST_CHANNEL_KEY);
    if (saved) el.testChannel.value = saved;
  } catch { /* ignore */ }
  const res = await api("/api/authbot/channels");
  if (!res.ok) return;
  const data = await res.json();
  el.testChannel.innerHTML = '<option value="">— Chọn kênh test —</option>';
  for (const c of data.channels) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.category ? `${c.category} / #${c.name}` : `#${c.name}`;
    el.testChannel.appendChild(opt);
  }
  try {
    const saved = localStorage.getItem(TEST_CHANNEL_KEY);
    if (saved) el.testChannel.value = saved;
  } catch { /* ignore */ }
}

async function sendTestMessage() {
  const channelId = el.testChannel.value;
  if (!channelId) { setStatus("Chọn kênh test trước", "err"); return; }
  const payload = buildPayload();
  if (!payload.content && !payload.embeds) { setStatus("Tin nhắn trống", "err"); return; }
  el.sendTestBtn.disabled = true;
  const res = await api("/api/authbot/messages/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, payload }),
  });
  el.sendTestBtn.disabled = false;
  if (res.ok) {
    try { localStorage.setItem(TEST_CHANNEL_KEY, channelId); } catch { /* ignore */ }
    setStatus("Đã gửi thử ✓", "ok");
  } else if (res.status === 429) setStatus("Gửi quá nhanh, thử lại sau", "err");
  else {
    const e = await res.json().catch(() => ({}));
    setStatus("Lỗi: " + (e.error || res.status), "err");
  }
}

async function loadChannels() {
  const res = await api("/api/authbot/channels");
  if (!res.ok) { setStatus("Không tải được kênh", "err"); return; }
  const data = await res.json();
  el.channel.innerHTML = "";
  for (const c of data.channels) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.category ? `${c.category} / #${c.name}` : `#${c.name}`;
    el.channel.appendChild(opt);
  }
}

async function loadTemplates() {
  const res = await api("/api/authbot/templates");
  if (!res.ok) return;
  const data = await res.json();
  el.templateSelect.innerHTML = '<option value="">— Mới —</option>';
  window._templates = {};
  for (const t of data.templates) {
    window._templates[t.id] = t;
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    el.templateSelect.appendChild(opt);
  }
}

async function sendMessage() {
  const channelId = el.channel.value;
  if (!channelId) { setStatus("Chọn kênh trước", "err"); return; }
  const payload = buildPayload();
  if (!payload.content && !payload.embeds) { setStatus("Tin nhắn trống", "err"); return; }
  el.sendBtn.disabled = true;
  const res = await api("/api/authbot/messages/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, payload }),
  });
  el.sendBtn.disabled = false;
  if (res.ok) setStatus("Đã gửi ✓", "ok");
  else if (res.status === 429) setStatus("Gửi quá nhanh, thử lại sau", "err");
  else {
    const e = await res.json().catch(() => ({}));
    setStatus("Lỗi: " + (e.error || res.status), "err");
  }
}

async function saveTemplate() {
  const name = prompt("Tên template:");
  if (!name) return;
  const payload = buildPayload();
  const res = await api("/api/authbot/templates", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, payload }),
  });
  if (res.ok) { setStatus("Đã lưu template ✓", "ok"); await loadTemplates(); }
  else if (res.status === 409) setStatus("Tên template đã tồn tại", "err");
  else setStatus("Lưu thất bại", "err");
}

function loadSelectedTemplate() {
  const id = el.templateSelect.value;
  if (!id || !window._templates[id]) { setStatus("Chọn template", "err"); return; }
  try {
    const payload = JSON.parse(window._templates[id].payload);
    loadPayload(payload);
    setStatus("Đã tải template", "ok");
  } catch { setStatus("Template lỗi định dạng", "err"); }
}

async function deleteSelectedTemplate() {
  const id = el.templateSelect.value;
  if (!id) { setStatus("Chọn template để xoá", "err"); return; }
  if (!confirm("Xoá template này?")) return;
  const res = await api("/api/authbot/templates/" + id, { method: "DELETE" });
  if (res.ok) { setStatus("Đã xoá", "ok"); await loadTemplates(); }
  else setStatus("Xoá thất bại", "err");
}

// ================= Licenses tab =================
async function loadLicenses() {
  const res = await apiJson("/api/authbot/licenses");
  if (!res) return;
  const data = await res.json();
  const box = $("licensesTable");
  const rows = (data.licenses || []).map((l) => `
    <tr>
      <td class="mono">${escapeHtml(l.key)}</td>
      <td>${escapeHtml(l.label || "—")}</td>
      <td>${l.revoked ? badge("Đã thu hồi", "danger") : badge("Hoạt động", "ok")}</td>
      <td class="actions-cell">${l.revoked ? "" : `<button class="btn small danger" data-revoke="${escapeHtml(l.key)}">Thu hồi</button>`}</td>
    </tr>`).join("");
  box.innerHTML = `<table><thead><tr><th>Key</th><th>Ghi chú</th><th>Trạng thái</th><th></th></tr></thead><tbody>${
    rows || emptyRow(4, "Chưa có license key")}</tbody></table>`;
  box.querySelectorAll("[data-revoke]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Thu hồi key này?")) return;
      const r = await api("/api/authbot/licenses/" + encodeURIComponent(b.dataset.revoke), { method: "DELETE" });
      if (r.ok) await loadLicenses(); else setStatus("Thu hồi thất bại", "err");
    }));
}

async function addLicense() {
  const key = $("newLicenseKey").value.trim();
  if (!key) { setStatus("Nhập key", "err"); return; }
  const res = await api("/api/authbot/licenses", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, label: $("newLicenseLabel").value.trim() || null }),
  });
  if (res.ok) { $("newLicenseKey").value = ""; $("newLicenseLabel").value = ""; loadLicenses(); }
  else setStatus(res.status === 409 ? "Key đã tồn tại" : "Thêm thất bại", "err");
}

// ================= Scheduled tab =================
async function loadScheduled() {
  const res = await apiJson("/api/authbot/scheduled");
  if (!res) return;
  const data = await res.json();
  const box = $("scheduledTable");
  const rows = (data.scheduled || []).map((s) => `
    <tr>
      <td>#${s.id}</td>
      <td>${badge(s.type)}</td>
      <td class="mono">${escapeHtml(s.channelId)}</td>
      <td>${s.intervalSecs ? "mỗi " + Math.round(s.intervalSecs / 60) + " phút" : "một lần"}</td>
      <td>${fmtTs(s.nextRun)}</td>
      <td class="actions-cell"><button class="btn small danger" data-del-sched="${s.id}">Xoá</button></td>
    </tr>`).join("");
  box.innerHTML = `<table><thead><tr><th>ID</th><th>Loại</th><th>Kênh</th><th>Lặp</th><th>Chạy tiếp</th><th></th></tr></thead><tbody>${
    rows || emptyRow(6, "Chưa có lịch — tạo bằng /schedule hoặc /remind")}</tbody></table>`;
  box.querySelectorAll("[data-del-sched]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Xoá lịch này?")) return;
      const r = await api("/api/authbot/scheduled/" + b.dataset.delSched, { method: "DELETE" });
      if (r.ok) await loadScheduled(); else setStatus("Xoá thất bại", "err");
    }));
}

// ================= Stats tab =================
// Hand-rolled SVG bar chart — no CDN/library, works offline.
function renderBarChart(container, series, color) {
  // series: [{ d: label, c: count }]
  const max = Math.max(1, ...series.map((p) => p.c));
  const W = 560, H = 180, padL = 28, padB = 22;
  const n = series.length || 1;
  const bw = Math.max(2, Math.floor((W - padL - 8) / n) - 2);
  const step = (W - padL - 8) / n;
  const scale = (H - padB - 10) / max;
  let bars = "", labels = "";
  series.forEach((p, i) => {
    const h = Math.max(p.c > 0 ? 2 : 0, Math.round(p.c * scale));
    const x = padL + i * step;
    const y = H - padB - h;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${color}" rx="2"><title>${escapeHtml(p.d)}: ${p.c}</title></rect>`;
    // label every ~6th bar to avoid clutter
    if (i % Math.max(1, Math.ceil(n / 8)) === 0) {
      labels += `<text x="${x + bw / 2}" y="${H - 6}" font-size="9" fill="var(--muted)" text-anchor="middle">${escapeHtml(String(p.d).slice(5))}</text>`;
    }
  });
  const axis = `<line x1="${padL}" y1="${H - padB}" x2="${W}" y2="${H - padB}" stroke="var(--border)"/>` +
    `<text x="4" y="${H - padB - max * scale + 10}" font-size="9" fill="var(--muted)">${max}</text>`;
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">${axis}${bars}${labels}</svg>`;
}

async function loadStats() {
  const res = await apiJson("/api/authbot/stats?days=30&weeks=12");
  if (!res) return;
  const data = await res.json();
  renderBarChart($("chartLinks"), data.linksPerDay || [], "#5865F2");
  // join vs leave overlay: build combined series
  const joins = data.joinsPerDay || [], leaves = data.leavesPerDay || [];
  const lmap = {};
  leaves.forEach((p) => (lmap[p.d] = p.c));
  const combined = joins.map((p) => ({ d: p.d, j: p.c, l: lmap[p.d] || 0 }));
  renderMemberChart($("chartMembers"), combined);
  renderBarChart($("chartWarns"), data.warnsPerWeek || [], "#FAA61A");
}

function renderMemberChart(container, series) {
  const max = Math.max(1, ...series.map((p) => Math.max(p.j, p.l)));
  const W = 560, H = 180, padL = 28, padB = 22;
  const n = series.length || 1;
  const bw = Math.max(2, Math.floor((W - padL - 8) / n) - 4);
  const step = (W - padL - 8) / n;
  const scale = (H - padB - 10) / max;
  let bars = "", labels = "";
  series.forEach((p, i) => {
    const hj = Math.max(p.j > 0 ? 2 : 0, Math.round(p.j * scale));
    const hl = Math.max(p.l > 0 ? 2 : 0, Math.round(p.l * scale));
    const x = padL + i * step;
    bars += `<rect x="${x}" y="${H - padB - hj}" width="${bw / 2}" height="${hj}" fill="#23A55A" rx="2"><title>${escapeHtml(p.d)} join: ${p.j}</title></rect>`;
    bars += `<rect x="${x + bw / 2 + 1}" y="${H - padB - hl}" width="${bw / 2}" height="${hl}" fill="#F23F43" rx="2"><title>${escapeHtml(p.d)} leave: ${p.l}</title></rect>`;
    if (i % Math.max(1, Math.ceil(n / 8)) === 0) {
      labels += `<text x="${x + bw}" y="${H - 6}" font-size="9" fill="var(--muted)" text-anchor="middle">${escapeHtml(String(p.d).slice(5))}</text>`;
    }
  });
  const axis = `<line x1="${padL}" y1="${H - padB}" x2="${W}" y2="${H - padB}" stroke="var(--border)"/>` +
    `<text x="4" y="${H - padB - max * scale + 10}" font-size="9" fill="var(--muted)">${max}</text>`;
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">${axis}${bars}${labels}</svg>`;
}

// ================= Settings tab =================
// key -> { label, kind, group } for rendering; matches server FEATURE_KEYS for editable kinds
const SETTINGS_META = {
  roles:             { label: "Role menus", kind: "bool", group: "Tính năng" },
  moderation:        { label: "Moderation", kind: "bool", group: "Tính năng" },
  snipe:             { label: "Snipe (/snipe)", kind: "bool", group: "Tính năng" },
  tags:              { label: "Tags", kind: "bool", group: "Tính năng" },
  welcome:           { label: "Welcome/Goodbye", kind: "bool", group: "Tính năng" },
  "log-message-events": { label: "Log edit/delete", kind: "bool", group: "Tính năng" },
  plugins:           { label: "Plugin panel", kind: "bool", group: "Tính năng" },
  schedule:          { label: "Scheduled msgs", kind: "bool", group: "Tính năng" },
  automod:           { label: "Automod", kind: "bool", group: "Tính năng" },
  starboard:         { label: "Starboard", kind: "bool", group: "Tính năng" },
  poll:              { label: "/poll", kind: "bool", group: "Tính năng" },
  giveaway:          { label: "Giveaway", kind: "bool", group: "Tính năng" },
  leveling:          { label: "Leveling/XP", kind: "bool", group: "Tính năng" },
  tickets:           { label: "Tickets", kind: "bool", group: "Tính năng" },
  suggestions:       { label: "Suggestions", kind: "bool", group: "Tính năng" },
  raidprotection:    { label: "Raid protection", kind: "bool", group: "Tính năng" },
  alt:               { label: "Alt IP detection", kind: "bool", group: "Tính năng" },
  tempvoice:         { label: "Temp voice channel", kind: "bool", group: "Tính năng" },
  stats:             { label: "Stats (member events)", kind: "bool", group: "Tính năng" },
  verification:      { label: "Verification Gate", kind: "bool", group: "Tính năng" },
  economy:           { label: "Economy", kind: "bool", group: "Tính năng" },
  autothread:        { label: "Auto-Thread", kind: "bool", group: "Tính năng" },
  customcommands:    { label: "Custom Commands", kind: "bool", group: "Tính năng" },
  autoresponder:     { label: "Auto-Responder", kind: "bool", group: "Tính năng" },
  "starboard-threshold": { label: "Starboard — số ⭐ cần", kind: "int", group: "Tham số" },
  "auto-punish-mute-threshold": { label: "Số warn → tự động mute (0 = tắt)", kind: "int", group: "Tham số" },
  "plugin-heartbeat-timeout": { label: "Plugin heartbeat timeout (s)", kind: "int", group: "Tham số" },
  "leveling-xp-cooldown-seconds": { label: "XP cooldown (giây)", kind: "int", group: "Tham số" },
  "leveling-xp-min": { label: "XP min/message", kind: "int", group: "Tham số" },
  "leveling-xp-max": { label: "XP max/message", kind: "int", group: "Tham số" },
  "raid-join-threshold": { label: "Raid — số join để báo động", kind: "int", group: "Tham số" },
  "raid-window-seconds": { label: "Raid — cửa sổ (giây)", kind: "int", group: "Tham số" },
  "autoresponder-cooldown-seconds": { label: "Auto-responder cooldown (giây)", kind: "int", group: "Tham số" },
  "customcommands-prefix": { label: "Custom commands prefix", kind: "str", group: "Tham số" },
  "welcome-channel-id":  { label: "Welcome channel ID", kind: "snowflake", group: "Kênh & Role" },
  "starboard-channel-id": { label: "Starboard channel ID", kind: "snowflake", group: "Kênh & Role" },
  "plugin-panel-channel-id": { label: "Plugin panel channel ID", kind: "snowflake", group: "Kênh & Role" },
  "plugin-log-channel-id": { label: "Plugin log channel ID", kind: "snowflake", group: "Kênh & Role" },
  "ticket-staff-role-id": { label: "Ticket staff role ID", kind: "snowflake", group: "Kênh & Role" },
  "ticket-log-channel-id": { label: "Ticket log channel ID", kind: "snowflake", group: "Kênh & Role" },
  "suggestion-channel-id": { label: "Suggestion channel ID", kind: "snowflake", group: "Kênh & Role" },
  "raid-alert-channel-id": { label: "Raid alert channel ID", kind: "snowflake", group: "Kênh & Role" },
  "alt-alert-channel-id": { label: "Alt alert channel ID", kind: "snowflake", group: "Kênh & Role" },
  "tempvoice-channel-id": { label: "Temp voice join-to-create channel ID", kind: "snowflake", group: "Kênh & Role" },
  "tempvoice-category-id": { label: "Temp voice category ID", kind: "snowflake", group: "Kênh & Role" },
  "verify-gate-role-id": { label: "Verify gate role ID", kind: "snowflake", group: "Kênh & Role" },
};

let settingsValues = {};

async function loadSettings() {
  const res = await apiJson("/api/authbot/settings");
  if (!res) return;
  const data = await res.json();
  settingsValues = data.features.values || {};
  const env = data.features.envOverridden || [];

  const warnBox = $("settingsWarning");
  if (env.length) {
    warnBox.textContent = "⚠️ Các key sau đang bị env override (sửa config.yml sẽ không có tác dụng): " + env.join(", ");
    warnBox.classList.remove("hidden");
  } else warnBox.classList.add("hidden");

  const form = $("settingsForm");
  const groups = {};
  Object.entries(SETTINGS_META).forEach(([key, meta]) => {
    (groups[meta.group] = groups[meta.group] || []).push([key, meta]);
  });
  form.innerHTML = Object.entries(groups).map(([group, keys]) => `
    <div class="settings-group"><h3>${escapeHtml(group)}</h3>${keys.map(([key, meta]) => {
      const val = settingsValues[key];
      if (meta.kind === "bool") {
        return `<label class="settings-row"><span>${escapeHtml(meta.label)}</span>
          <input type="checkbox" data-setting="${key}" ${val ? "checked" : ""} /></label>`;
      }
      return `<label class="settings-row"><span>${escapeHtml(meta.label)}</span>
        <input type="text" data-setting="${key}" value="${escapeHtml(String(val ?? ""))}" /></label>`;
    }).join("")}</div>`).join("");
}

async function saveSettings() {
  const body = {};
  document.querySelectorAll("[data-setting]").forEach((inp) => {
    body[inp.dataset.setting] = inp.type === "checkbox" ? inp.checked : inp.value.trim();
  });
  const res = await api("/api/authbot/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const banner = $("settingsBanner");
  if (res.ok) {
    const data = await res.json();
    const rejected = (data.rejected || []);
    banner.textContent = "💾 Đã lưu config.yml — restart bot (run.bat) để áp dụng." +
      (rejected.length ? " Bỏ qua: " + rejected.join(", ") : "");
    banner.classList.remove("hidden");
  } else {
    banner.textContent = "❌ Lưu thất bại (" + res.status + ")";
    banner.classList.remove("hidden");
  }
}

// ================= Logs tab =================
async function loadLogs() {
  // audit
  const ares = await apiJson("/api/authbot/audit");
  if (ares) {
    const data = await ares.json();
    const box = $("logsTable");
    const rows = (data.entries || []).map((e) => `
      <tr>
        <td>${fmtTs(e.createdAt)}</td>
        <td class="mono">${escapeHtml(e.action)}</td>
        <td>${escapeHtml(e.username || "—")}</td>
        <td class="mono">${escapeHtml(e.ip || "—")}</td>
        <td>${escapeHtml(e.performedBy || "system")}</td>
      </tr>`).join("");
    box.innerHTML = `<table><thead><tr><th>Thời gian</th><th>Hành động</th><th>Người dùng</th><th>IP</th><th>Thực hiện bởi</th></tr></thead><tbody>${
      rows || emptyRow(5, "Chưa có sự kiện")}</tbody></table>`;
  }
  // plugin status
  const pres = await apiJson("/api/authbot/plugins/status");
  if (pres) {
    const data = await pres.json();
    const box = $("pluginsTable");
    // Chỉ hiện plugin đang online — offline biến khỏi bảng thay vì xếp hàng chờ.
    const rows = (data.plugins || []).filter((p) => p.status === "online").map((p) => `
      <tr>
        <td class="mono">${escapeHtml(p.name)}</td>
        <td class="mono">${escapeHtml(p.version || "—")}</td>
        <td class="mono">${escapeHtml(p.server || "—")}</td>
        <td>${fmtTs(p.lastSeen)}</td>
      </tr>`).join("");
    box.innerHTML = `<table><thead><tr><th>Plugin</th><th>Version</th><th>Server</th><th>Cuối online</th></tr></thead><tbody>${
      rows || emptyRow(4, "Không có plugin nào đang online")}</tbody></table>`;
  }
}

// ================= ESPaper tab =================
// 4 endpoint qua gateway (session-gated): overview cards, players table + search,
// kho detail khi click row, tổng server per item. 502/503 → banner + nút retry.
let espaperRefreshTimer = null;

function espaperBanner(msg, kind) {
  const b = $("espaperBanner");
  if (!msg) { b.classList.add("hidden"); b.innerHTML = ""; return; }
  b.classList.remove("hidden");
  b.className = "banner" + (kind ? " " + kind : "");
  b.innerHTML = `${escapeHtml(msg)} <button class="btn" id="espaperRetry" type="button">↻ Retry</button>`;
  const retryBtn = b.querySelector("#espaperRetry");
  if (retryBtn) retryBtn.addEventListener("click", () => run(loadEspaper));
}

async function loadEspaper() {
  espaperBanner("");
  const common = { status: null, players: null, items: null };
  const [st, pl, it] = await Promise.all([
    apiJson("/api/authbot/espaper/status"),
    apiJson("/api/authbot/espaper/players"),
    apiJson("/api/authbot/espaper/items"),
  ]);
  for (const [name, res] of [["status", st], ["players", pl], ["items", it]]) {
    if (!res) return; // 401 → login gate đã hiện
    if (res.status === 503 || res.status === 502) {
      const body = await res.json().catch(() => ({}));
      const msg = body.error === "espaper_disabled"
        ? "ESPaper chưa cấu hình — đặt espaper.url + espaper.token trong config.yml gateway (và bật RestApi phía plugin)."
        : body.error === "espaper_auth"
          ? "Token ESPaper sai — đối chiếu RestApi.Token (plugin) với espaper.token (gateway)."
          : "Không kết nối được ESPaper REST API (plugin tắt hoặc tunnel đứt).";
      espaperBanner(`⚠️ ${msg}`, "warn");
      return;
    }
    common[name] = await res.json();
  }

  renderEspaperOverview(common.status);
  renderEspaperPlayers(common.players || []);
  renderEspaperItems(common.items || {});
  $("espaperDetail").innerHTML = "";

  // Auto-refresh 15s khi tab đang mở + trang hiển thị (pattern như Stats).
  clearInterval(espaperRefreshTimer);
  espaperRefreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (!document.querySelector('.tab[data-tab="espaper"].active')) { clearInterval(espaperRefreshTimer); return; }
    run(loadEspaper);
  }, 15000);
}

function renderEspaperOverview(st) {
  const box = $("espaperOverview");
  if (!st) { box.innerHTML = ""; return; }
  const cards = [
    ["Users loaded", st.users_loaded ?? "—"],
    ["Quỹ thuế (đích)", st.tax_bank != null ? fmtMoney(st.tax_bank) : "—"],
    ["Quỹ local", st.tax_bank_local != null ? fmtMoney(st.tax_bank_local) : "—"],
    ["Uptime", st.uptime_seconds != null ? fmtUptime(st.uptime_seconds) : "—"],
    ["Version", st.version || "—"],
  ];
  box.innerHTML = cards.map(([label, val]) => `<div class="card"><h3>${escapeHtml(label)}</h3><div class="stat-num">${escapeHtml(String(val))}</div></div>`).join("");
  $("espaperHint").textContent = `ESPaper ${st.version || ""} · cập nhật cache 15s`;
}

function renderEspaperPlayers(players) {
  const box = $("espaperPlayers");
  const q = ($("espaperSearch").value || "").toLowerCase();
  const filtered = players.filter((p) => !q || (p.name || "").toLowerCase().includes(q));
  const rows = filtered.map((p) => `
    <tr class="clickable" data-uuid="${escapeHtml(p.uuid)}">
      <td class="mono">${escapeHtml(p.name)}</td>
      <td class="mono">${fmtQty(p.total_items)}</td>
      <td class="mono">${p.distinct_items}</td>
    </tr>`).join("");
  box.innerHTML = `<table><thead><tr><th>Player</th><th>Tổng số lượng</th><th>Loại item</th></tr></thead><tbody>${
    rows || emptyRow(3, "Chưa có player nào (hoặc chưa ai dùng kho)")}</tbody></table>`;
  // CSP: no inline onclick — attach listeners after render.
  box.querySelectorAll("tr[data-uuid]").forEach((tr) =>
    tr.addEventListener("click", () => openEspaperPlayer(tr.dataset.uuid)));
}

async function openEspaperPlayer(uuid) {
  const res = await apiJson("/api/authbot/espaper/player/" + encodeURIComponent(uuid));
  if (!res) return;
  const box = $("espaperDetail");
  if (res.status !== 200) {
    const body = await res.json().catch(() => ({}));
    box.innerHTML = `<div class="banner warn">Không lấy được kho: ${escapeHtml(body.error || res.status)}</div>`;
    return;
  }
  const data = await res.json();
  const items = Object.entries(data.items || {}).sort((a, b) => b[1] - a[1]);
  const staleNote = res.headers.get("X-Cache") === "stale" ? ' <span class="hint">(dữ liệu cũ — ESPaper tắt)</span>' : "";
  const rows = items.map(([key, qty]) => `
    <tr><td class="mono">${escapeHtml(key)}</td><td class="mono">${fmtQty(qty)}</td></tr>`).join("");
  box.innerHTML = `<div class="tab-head"><h3>🧰 Kho của ${escapeHtml(data.name)}${staleNote}</h3></div>
    <table><thead><tr><th>Item</th><th>Số lượng</th></tr></thead><tbody>${
    rows || emptyRow(2, "Kho trống")}</tbody></table>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderEspaperItems(items) {
  const box = $("espaperItems");
  const entries = Object.entries(items).sort((a, b) => b[1] - a[1]);
  const rows = entries.map(([key, qty]) => `
    <tr><td class="mono">${escapeHtml(key)}</td><td class="mono">${fmtQty(qty)}</td></tr>`).join("");
  box.innerHTML = `<table><thead><tr><th>Item</th><th>Tổng số lượng</th></tr></thead><tbody>${
    rows || emptyRow(2, "Chưa có dữ liệu")}</tbody></table>`;
}

function fmtQty(n) { return Number(n).toLocaleString("vi-VN"); }
function fmtMoney(n) { return Number(n).toLocaleString("vi-VN", { maximumFractionDigits: 0 }); }
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + "d " : "") + (h ? h + "h " : "") + m + "m";
}
$("espaperSearch").addEventListener("input", () => {
  // Re-filter từ data đã load — giữ đơn giản bằng cách re-fetch từ cache chung
  // (fetch lại qua gateway có cache 15s nên rẻ).
  if (window._loaded.espaper) run(loadEspaper);
});

// ================= Init =================
window._loaded = {};
window._templates = {};

async function init() {
  const me = await api("/api/me");
  if (me.status === 401) { window.location.href = "/login"; return; }
  const user = await me.json();
  const whoami = $("whoami");
  if (whoami) whoami.textContent = user.username || "";
  const dash = $("dashboard");
  if (dash) dash.classList.remove("hidden");

  // Editor wiring
  el.content.addEventListener("input", () => { renderCounters(); schedulePreview(); scheduleSaveDraft(); });
  el.webhookName.addEventListener("input", () => { state.webhookName = el.webhookName.value; schedulePreview(); scheduleSaveDraft(); });
  el.webhookAvatar.addEventListener("input", () => { state.webhookAvatar = el.webhookAvatar.value; schedulePreview(); scheduleSaveDraft(); });
  el.embedsList.addEventListener("input", onEditorInput);
  el.embedsList.addEventListener("click", onEmbedListClick);
  el.addEmbedBtn.addEventListener("click", () => { state.embeds.push(freshEmbed()); renderEditor(); renderPreview(); scheduleSaveDraft(); });
  el.presetSelect.addEventListener("change", (e) => applyPreset(e.target.value));
  el.sendBtn.addEventListener("click", sendMessage);
  el.sendTestBtn.addEventListener("click", sendTestMessage);
  el.saveTemplateBtn.addEventListener("click", saveTemplate);
  el.loadTemplate.addEventListener("click", loadSelectedTemplate);
  el.deleteTemplate.addEventListener("click", deleteSelectedTemplate);
  el.clearDraftBtn.addEventListener("click", clearDraft);
  el.reloadChannels.addEventListener("click", loadChannels);
  el.testChannel.addEventListener("change", () => {
    if (el.testChannel.value) { try { localStorage.setItem(TEST_CHANNEL_KEY, el.testChannel.value); } catch { /* ignore */ } }
  });
  $("addLicenseBtn").addEventListener("click", addLicense);
  $("saveSettingsBtn").addEventListener("click", saveSettings);

  if (restoreDraft()) setStatus("Đã khôi phục draft", "ok");
  renderEditor();
  renderPreview();
  await loadChannels();
  await loadTemplates();
  await loadTestChannel();
}

init();
