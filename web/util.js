/* ═══════════════════════════════════════════════════════════════
   ShinnPanel — helpers.
   Small DOM + format helpers shared by the dashboard pages.
   ═══════════════════════════════════════════════════════════════ */
"use strict";

const SHINUTIL = (() => {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
    return n + " B";
  }
  function fmtUptime(sec) {
    sec = Number(sec) || 0;
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
          m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + s + "s";
    return s + "s";
  }
  function now() { return new Date().toTimeString().slice(0, 8); }
  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
    }
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function onEnter(id, fn) {
    const i = document.getElementById(id);
    if (i) i.addEventListener("keydown", e => { if (e.key === "Enter") fn(e); });
  }
  function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
  function setHtml(id, v) { const e = document.getElementById(id); if (e) e.innerHTML = v; }

  return { esc, fmtBytes, fmtUptime, now, el, onEnter, setText, setHtml };
})();

window.SHINUTIL = SHINUTIL;