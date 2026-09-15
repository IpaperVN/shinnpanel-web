/* ═══════════════════════════════════════════════════════════════
   ShinnPanel — dashboard.
   Views: overview (OS+players | console | status+run.sh), files,
   authbot (editor sender + licenses + scheduled + stats + espaper),
   logs (audit + plugin status).
   All data via /api/mc/* and /api/authbot/* (see api.js).
   ═══════════════════════════════════════════════════════════════ */
"use strict";

(() => {
  const { esc, fmtBytes, fmtUptime, now, el, onEnter, setText, setHtml } = window.SHINUTIL;

  /* ─────────────── theme ─────────────── */
  const btnTheme = document.getElementById("btnTheme");
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    if (btnTheme) btnTheme.textContent = t === "dark" ? "☀ light" : "☾ dark";
  }
  function toggleTheme() { applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }
  if (btnTheme) btnTheme.addEventListener("click", toggleTheme);
  try { localStorage.getItem("shinntheme") && document.documentElement.dataset.theme === ""; } catch (e) {}
  applyTheme("dark");

  /* ─────────────── nav ─────────────── */
  const NAVS = ["overview", "files", "authbot", "logs"];
  function switchNav(nav) {
    document.querySelectorAll(".navitem[data-nav]").forEach(b => b.classList.toggle("active", b.dataset.nav === nav));
    // "logs" sống ngay trong trang authbot (tab logs: audit + plugin status) —
    // nhảy thẳng vào tab đó thay vì giữ một trang riêng.
    const target = nav === "logs" ? "authbot" : nav;
    document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.dataset.page === target));
    if (nav === "logs" && window.switchTab) window.switchTab("logs");
    if (nav === "overview") refreshOverview();
    if (nav === "files") reloadDir();
    if (nav === "authbot") authbotLoad();
  }
  document.querySelectorAll(".navitem[data-nav]").forEach(b =>
    b.addEventListener("click", () => switchNav(b.dataset.nav)));
  document.addEventListener("keydown", e => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 4) switchNav(NAVS[n - 1]);
  });

  /* ═══════════════════ OVERVIEW ═══════════════════ */
  const POLL_MS = 5000;
  let consoleStreamHandle = null;

  function sanitizeLogLine(line) {
    const s = esc(String(line));
    // highlight prefix timestamps and log levels
    return s
      .replace(/\[([0-9:.]+)\]/g, '<span class="t">[$1]</span>')
      .replace(/\b(INFO|FATAL|SEVERE)\b/g, '<span class="info">$1</span>')
      .replace(/\b(WARN)\b/g, '<span class="warn">$1</span>')
      .replace(/\b(ERROR)\b/g, '<span class="err">$1</span>');
  }

  function logEl(t, cls, msg) {
    const box = document.getElementById("consoleEl");
    const l = document.createElement("span");
    l.className = "console-line " + (cls || "");
    l.innerHTML = `<span class="t">${t ? "[" + esc(t) + "]" : ""}</span> ${esc(msg)}`;
    box.appendChild(l);
    box.scrollTop = box.scrollHeight;
  }

  async function refreshOverview() {
    // OS info (once per load; cached server-side)
    try {
      const os = await SHINNAPI.get("/api/mc/os");
      setText("osBanner", (os.host || "server") + "@" + (os.os || "?"));
      setText("osName", os.os || "—");
      setText("osKernel", os.kernel || "—");
      setText("osHost", os.host || "—");
      setText("osCpu", os.cpu || "—");
      setText("osIp", os.ip || "—");
      setText("osUptime", fmtUptime(os.uptime || 0));
    } catch (e) { /* ignore */ }

    // metrics
    try {
      const m = await SHINNAPI.get("/api/mc/metrics");
      const ramPct = Math.round(m.ram && m.ram.percent || 0);
      const cpuPct = Math.round(m.cpu && m.cpu.percent || 0);
      const diskPct = Math.round(m.disk && m.disk.percent || 0);
      const tps = m.tps || 0;
      const tpsPct = Math.min(100, Math.round(tps / 20 * 100));
      setWidth("barRam", ramPct); setWidth("barCpu", cpuPct);
      setWidth("barDisk", diskPct); setWidth("barTps", tpsPct);
      setText("uRamPct", ramPct + "%"); setText("uCpuPct", cpuPct + "%");
      setText("uDiskPct", diskPct + "%"); setText("uTpsPct", tpsPct + "%");
      setText("sbRam", (m.ram && m.ram.usedBytes ? fmtBytes(m.ram.usedBytes) : "—"));
      setText("sbCpu", cpuPct + "%");
      setText("sbTps", tps.toFixed(1));

      setWidth("sbBarRam", ramPct); setWidth("sbBarCpu", cpuPct);
      const diskBar = document.getElementById("sbBarDisk"); if (diskBar) diskBar.style.background = "var(--green)";
    } catch (e) { /* not ready */ }

    // process
    try {
      const p = await SHINNAPI.get("/api/mc/process");
      setText("procState", p.running ? "● online" : "○ offline");
      const b = document.getElementById("procState");
      if (b) b.style.color = p.running ? "var(--green)" : "var(--yellow)";
      setText("procUptime", p.running ? fmtUptime(p.uptime) : "—");
      const pid = document.getElementById("pidVal"); if (pid) pid.textContent = p.running ? "pid " + p.pid : "";
      setText("sbProcess", p.running ? "●" : "○");
      btnStart.disabled = p.running;
      btnStop.disabled = !p.running;
      btnKill.disabled = !p.running;
    } catch (e) {}

    // players
    try {
      const pl = await SHINNAPI.get("/api/mc/players");
      const list = pl.players || [];
      setText("pCountHome", list.length);
      setHtml("playersHomeTbl", list.map(pl2 =>
        `<div class="row"><span class="c name">${esc(pl2.name)}</span>` +
        `<span class="c ping">${pl2.ping || 0}ms</span>` +
        `<span class="c" style="color:${pl2.state === "on" ? "var(--green)" : "var(--yellow)"}">` +
        (pl2.state === "on" ? "●" : "○") + `</span></div>`).join(""));
      setText("sbPlayers", list.length + "/20");
    } catch (e) {}

    // run.sh
    try {
      const sh = await SHINNAPI.request("GET", "/api/mc/runsh");
      const txt = await sh.text();
      setText("runshPath", "…/" + (txt ? txt.split("\n")[0] : "run.sh").slice(0, 80));
    } catch (e) {}
    setHtml("runshCode", esc("#!/bin/bash\n# run.sh — xem trong mục Files để sửa"));
  }

  function setWidth(id, pct) {
    const b = document.getElementById(id); if (!b) return;
    b.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }

  /* Console stream: đọc dòng từ /api/mc/console/stream (poll-based SSE qua proxy) */
  function startConsoleStream() {
    if (consoleStreamHandle) { consoleStreamHandle.abort(); consoleStreamHandle = null; }
    consoleLog("— kết nối console —", "dim");
    consoleStreamHandle = SHINNAPI.stream("/api/mc/console/stream", line => {
      consoleLog(line);
    }, err => {
      consoleLog("stream lỗi: " + (err && err.message), "err");
    });
  }
  function consoleLog(msg, cls) {
    const box = document.getElementById("consoleEl");
    if (!box) return;
    const l = document.createElement("span");
    l.className = "console-line " + (cls || "");
    l.innerHTML = sanitizeLogLine(msg);
    box.appendChild(l);
    while (box.childNodes.length > 1000) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function sendCmd() {
    const input = document.getElementById("cmdInput");
    const cmd = input.value.trim(); if (!cmd) return;
    consoleLog("❯ " + cmd, "cmd");
    input.value = "";
    SHINNAPI.post("/api/mc/console/command", { command: cmd }).catch(e => {
      consoleLog("— " + e.message, "err");
    });
  }
  onEnter("cmdInput", sendCmd);

  async function processAction(action) {
    const b = { start: "Đang khởi động…", stop: "Đang dừng máy chủ…", kill: "Đang huỷ tiến trình…" }[action];
    setText("procMsg", b);
    try {
      const r = await SHINNAPI.request("POST", "/api/mc/process/" + action);
      await r.json();
      setText("procMsg", "");
      const p = await SHINNAPI.get("/api/mc/process");
      setText("sbProcess", p.running ? "●" : "○");
      setText("procUptime", p.running ? fmtUptime(p.uptime) : "—");
      btnStart.disabled = p.running; btnStop.disabled = !p.running; btnKill.disabled = !p.running;
    } catch (e) { setText("procMsg", e.message); }
  }
  const btnStart = document.getElementById("btnStart"), btnStop = document.getElementById("btnStop"), btnKill = document.getElementById("btnKill");
  if (btnStart) btnStart.addEventListener("click", () => processAction("start"));
  if (btnStop) btnStop.addEventListener("click", () => processAction("stop"));
  if (btnKill) btnKill.addEventListener("click", () => processAction("kill"));

  /* Notices — left column */
  async function loadNotices() {
    try {
      const n = await SHINNAPI.get("/api/mc/metrics");
      const arr = [];
      if (n.ram) arr.push(n.ram.percent > 85 ? ["warn", "ram cao " + Math.round(n.ram.percent) + "%"] : ["", "ram " + Math.round(n.ram.percent) + "% — bình thường"]);
      if (n.cpu) arr.push(n.cpu.percent > 80 ? ["warn", "cpu cao " + Math.round(n.cpu.percent) + "%"] : ["", "cpu " + Math.round(n.cpu.percent) + "%"]);
      if (n.disk) arr.push(n.disk.percent > 90 ? ["warn", "disk gần đầy " + Math.round(n.disk.percent) + "%"] : ["", "disk " + Math.round(n.disk.percent) + "%"]);
      setHtml("notices", arr.map(([k, m]) =>
        `<div class="notice ${k}">${k === "warn" ? "⚠ " : "• "}${esc(m)}</div>`).join(""));
    } catch (e) {}
  }

  async function initOverview() {
    await refreshOverview();
    setInterval(refreshOverview, POLL_MS);
    startConsoleStream();
    loadNotices();
    setInterval(loadNotices, POLL_MS);
  }

  /* ═══════════════════ FILES ═══════════════════ */
  let reloading = false;
  let currentDir = "";
  async function reloadDir() {
    if (reloading) return; reloading = true;
    try {
      const d = await SHINNAPI.get("/api/mc/files/list?path=" + encodeURIComponent(currentDir));
      renderTree(d.entries || []);
    } catch (e) { setText("filePath", "lỗi: " + e.message); }
    finally { reloading = false; }
  }
  function renderTree(entries) {
    const tree = document.getElementById("fileTree");
    tree.innerHTML = "";
    const ups = el("div", { class: "row", text: ".." });
    ups.classList.add("dir");
    ups.addEventListener("click", () => {
      currentDir = currentDir.split("/").slice(0, -1).join("/");
      reloadDir();
    });
    tree.appendChild(ups);
    // sort: dirs first, then name
    entries.sort((a, b) => (a.dir ? 0 : 1) - (b.dir ? 0 : 1) || a.name.localeCompare(b.name));
    entries.forEach(e => {
      const row = el("div", { class: "row", text: (e.dir ? "▸ " : "") + e.name + (e.dir ? "/" : "") });
      if (e.dir) row.classList.add("dir");
      else row.classList.add(e.name.endsWith(".yml") || e.name.endsWith(".yaml") ? "yml" : "");
      if (!e.dir) row.appendChild(el("span", { class: "meta", text: fmtBytes(e.size || 0) }));
      row.addEventListener("click", () => { openFile(e.path); });
      tree.appendChild(row);
    });
  }
  async function openFile(path) {
    const fName = document.getElementById("fViewName");
    fName.textContent = path;
    currentPath = path;
    const save = document.getElementById("btnFileSave");
    if (save) save.disabled = !path;
    try {
      const r = await SHINNAPI.request("GET", "/api/mc/files/read?path=" + encodeURIComponent(path));
      const txt = await r.text();
      setHtml("fViewer", esc(txt));
    } catch (e) { setHtml("fViewer", "// lỗi: " + esc(e.message)); }
  }

  /* Lưu file đã sửa trong viewer → POST /api/mc/files/write (agent cap 1MB, CSRF header tự thêm) */
  let currentPath = "";
  async function saveFile() {
    const path = currentPath;
    if (!path) return;
    const raw = document.getElementById("fViewer").innerText;
    const save = document.getElementById("btnFileSave");
    if (save) { save.disabled = true; save.textContent = "💾 Đang lưu…"; }
    try {
      await SHINNAPI.post("/api/mc/files/write?path=" + encodeURIComponent(path), raw);
      if (save) save.textContent = "💾 Lưu ✓";
      setTimeout(() => { if (save) { save.textContent = "💾 Lưu"; } }, 1500);
    } catch (e) {
      if (save) { save.textContent = "❌ " + e.message; }
    } finally {
      if (save) save.disabled = false;
    }
  }
  const btnFileSave = document.getElementById("btnFileSave");
  if (btnFileSave) btnFileSave.addEventListener("click", saveFile);

  /* Sửa run.sh — nhảy sang mục Files và mở run.sh */
  const btnEditRunsh = document.getElementById("btnEditRunsh");
  if (btnEditRunsh) btnEditRunsh.addEventListener("click", () => {
    switchNav("files");
    currentDir = "";
    reloadDir();
    openFile("/run.sh");
  });

  /* ═══════════════════ AUTHBOT ═══════════════════ */
  async function authbotLoad() {
    // licenses + scheduled — gọi /api/authbot/*
    try {
      const r = await SHINNAPI.request("GET", "/api/authbot/licenses");
      const ok = await r.json();
      // nếu bot trả về có cấu trúc list — render tối giản
    } catch (e) { /* bot chưa nối */ }
  }
  window.authbotLoad = authbotLoad;

  /* ═══════════════════ LOGS ═══════════════════ */
  async function logsLoad() {
    try {
      const r = await SHINNAPI.request("GET", "/api/authbot/audit");
      // mẫu
    } catch (e) {}
  }

  /* ─────────────── boot ─────────────── */
  async function boot() {
    try {
      const me = await SHINNAPI.get("/api/me");
      if (me.username) {
        setText("whoami", me.username);
      }
    } catch (e) {}
    initOverview();
  }
  boot();
})();