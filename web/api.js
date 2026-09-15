/* ═══════════════════════════════════════════════════════════════
   ShinnPanel — API client.
   Single fetch wrapper for the /api/* endpoints (mc + authbot).
   Every request sets X-Requested-With (CSRF parity with the Go proxy),
   and sends credentials so the session cookie travels along.
   ═══════════════════════════════════════════════════════════════ */
"use strict";

const SHINNAPI = (() => {
  async function request(method, path, body, opts = {}) {
    let headers = Object.assign(
      { "X-Requested-With": "XMLHttpRequest" },
      opts.headers || {}
    );
    // string body → raw (CSV/text cho files/write); object/undefined → JSON
    if (typeof body === "string") headers["Content-Type"] = "text/plain; charset=utf-8";
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: typeof body === "string" ? body : (body !== undefined ? JSON.stringify(body) : undefined),
    });
    // 401 = session hết hạn hoặc chưa login → quay về trang login
    if (r.status === 401) {
      const d = await r.json().catch(() => ({}));
      if (d.error === "not_authenticated") {
        window.location.href = "/login";
        throw new Error("not_authenticated");
      }
    }
    // 423/429 cũng trả lỗi mềm để UI hiển thị mà không cần thoát trang
    if (!r.ok && r.status !== 423 && r.status !== 429) {
      let msg = "http_" + r.status;
      try { const j = await r.json(); msg = j.error || msg; } catch (e) {}
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return r;
  }

  async function json(method, path, body, opts) {
    const r = await request(method, path, body, opts);
    return r.json().catch(() => ({}));
  }

  // Stream (SSE) mở connection với fetch reader (thay EventSource vì cần POST-like header + credentials same-origin)
  async function stream(path, onLine, onError) {
    let last = 0; // byte offset — MC agent stream dùng offset dòng
    let aborted = false;
    const loop = async () => {
      while (!aborted) {
        try {
          const r = await request("GET", path + (path.includes("?") ? "&" : "?") + "last=" + last, undefined, {});
          if (!r.ok) { throw new Error("stream_" + r.status); }
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
              let data = "";
              for (const line of ev.split("\n")) {
                if (line.startsWith("data:")) data += line.slice(5).trim();
              }
              if (!data) continue;
              let obj;
              try { obj = JSON.parse(data); } catch (e) { continue; }
              // mc agent: dữ liệu là array dòng; cập nhật last == tổng số dòng
              if (Array.isArray(obj)) {
                last = obj.length;
                (obj || []).forEach(l => onLine && onLine(l));
              } else if (obj && typeof obj.line === "string") {
                onLine && onLine(obj.line);
              }
            }
          }
        } catch (e) {
          if (aborted) return;
          onError && onError(e);
        }
        // nghỉ giữa các lần reconnect (agent stream là poll-based)
        await new Promise(res => setTimeout(res, 1500));
      }
    };
    loop();
    return { abort: () => { aborted = true; } };
  }

  return {
    get:   (p, o) => json("GET", p, undefined, o),
    post:  (p, b, o) => json("POST", p, b, o),
    stream,
    request,
  };
})();

window.SHINNAPI = SHINNAPI;