/* ============================================================
   MSDS PLUS — reference numbers, stored PDFs, duplicate detection
   - every uploaded MSDS PDF is stored once (Supabase msds_files) with a ref MSDS-0001...
   - same PDF uploaded again -> "ALREADY IN HISTORY: MSDS-00xx, uploaded <date>" + VIEW
   - history shows the LATEST check per MSDS, with date, ref, check count and VIEW
   (additive — wraps the existing MSDS functions, no core edits)
   ============================================================ */
(function () {
  "use strict";
  var current = null;          // {ref, hash, id, name, isNew, created_at}
  var fileCache = {};          // hash -> row (without data)

  function client() { try { return (typeof sb !== "undefined" && sb) ? sb : null; } catch (e) { return null; } }
  function me() { try { return (typeof sbUser !== "undefined" && sbUser) ? sbUser.email : ""; } catch (e) { return ""; } }
  function h(s) { return (typeof esc === "function") ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(d) { var x = new Date(d); return isNaN(x.getTime()) ? "" : x.toLocaleString("en-GB"); }

  async function sha256(buf) {
    var d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  function toDataUrl(file) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(file); });
  }
  function banner(html, color, bg) {
    var b = document.getElementById("msds_dupbanner");
    if (!b) {
      var fileEl = document.getElementById("msdsfile");
      if (!fileEl) return;
      b = document.createElement("div");
      b.id = "msds_dupbanner";
      var row = fileEl.closest("div") || fileEl.parentNode;
      row.parentNode.insertBefore(b, row.nextSibling);
    }
    b.style.cssText = "margin:8px 0 10px; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:bold; border:1.5px solid " + color + "; background:" + bg + "; color:" + color + ";";
    b.innerHTML = html;
    b.style.display = html ? "" : "none";
  }

  async function findByHash(hash) {
    var c = client(); if (!c) return null;
    if (fileCache[hash]) return fileCache[hash];
    var r = await c.from("msds_files").select("id,ref,name,product,created_at,created_by,size").eq("hash", hash).maybeSingle();
    if (r && r.data) fileCache[hash] = r.data;
    return r && r.data ? r.data : null;
  }
  async function nextRef() {
    var c = client(); var n = 0;
    try {
      var r = await c.from("msds_files").select("ref").order("created_at", { ascending: false }).limit(1000);
      (r.data || []).forEach(function (x) { var m = /^MSDS-(\d+)$/.exec(x.ref || ""); if (m) n = Math.max(n, parseInt(m[1], 10)); });
    } catch (e) {}
    return "MSDS-" + String(n + 1).padStart(4, "0");
  }

  /* file picked -> duplicate check immediately */
  async function onFilePicked() {
    current = null;
    var el = document.getElementById("msdsfile");
    var f = el && el.files && el.files[0];
    if (!f) { banner(""); return; }
    try {
      var hash = await sha256(await f.arrayBuffer());
      var row = await findByHash(hash);
      if (row) {
        current = { ref: row.ref, hash: hash, id: row.id, name: row.name, isNew: false, created_at: row.created_at };
        var last = latestCheckFor(row.ref);
        banner("&#9888; ALREADY IN HISTORY — <span style='font-size:15px;'>" + h(row.ref) + "</span> · uploaded " + h(fmt(row.created_at)) +
          (row.created_by ? " by " + h(row.created_by) : "") +
          (last ? " · last result: " + h(last.verdict || "?") + (last.un ? " " + h(last.un) : "") + " (" + h(last.when || "") + ")" : "") +
          " &nbsp;<button class='smallbtn sb-blue' onclick='msdsView(\"" + h(row.ref) + "\")'>&#128065; VIEW MSDS</button>" +
          " <button class='smallbtn sb-green' onclick='msdsShowRef(\"" + h(row.ref) + "\")'>&#128270; SHOW IN HISTORY</button>",
          "#b45309", "#fff4e5");
      } else {
        current = { ref: null, hash: hash, id: null, name: f.name, isNew: true };
        banner("&#10133; NEW MSDS — a reference number is created when you check it.", "#1d6b34", "#eef8f0");
      }
    } catch (e) { banner(""); }
  }

  /* store the PDF once (new ones only) and return its ref */
  async function ensureStored() {
    var el = document.getElementById("msdsfile");
    var f = el && el.files && el.files[0];
    if (!f) return null;
    if (!current || !current.hash) await onFilePicked();
    if (current && current.ref) return current.ref;
    var c = client(); if (!c) return null;
    try {
      var data = await toDataUrl(f);
      for (var attempt = 0; attempt < 3; attempt++) {
        var ref = await nextRef();
        var ins = await c.from("msds_files").insert({ ref: ref, hash: current.hash, name: f.name, size: f.size, data: data,
          product: (document.getElementById("msds_name") || {}).value || "", created_by: me() }).select("id,ref,created_at").maybeSingle();
        if (!ins.error && ins.data) {
          current.ref = ins.data.ref; current.id = ins.data.id; current.created_at = ins.data.created_at;
          fileCache[current.hash] = { id: ins.data.id, ref: ins.data.ref, name: f.name, created_at: ins.data.created_at, created_by: me() };
          banner("&#10004; SAVED AS <span style='font-size:15px;'>" + h(ins.data.ref) + "</span> — attached to the history, VIEW any time.", "#1d6b34", "#eef8f0");
          return ins.data.ref;
        }
        // hash already stored by someone else at the same moment -> use theirs
        var ex = await findByHash(current.hash);
        if (ex) { current.ref = ex.ref; current.id = ex.id; return ex.ref; }
      }
    } catch (e) {}
    return null;
  }

  window.msdsView = async function (ref) {
    var c = client(); if (!c) { alert("Cloud not connected."); return; }
    var w = window.open("", "_blank");
    try {
      var r = await c.from("msds_files").select("data,name").eq("ref", ref).maybeSingle();
      if (!r.data) { if (w) w.close(); alert("MSDS file not found for " + ref + "."); return; }
      var b = await (await fetch(r.data.data)).blob();
      var url = URL.createObjectURL(new Blob([b], { type: "application/pdf" }));
      if (w) w.location.href = url; else window.open(url, "_blank");
    } catch (e) { if (w) w.close(); alert("Could not open " + ref + ": " + (e.message || e)); }
  };
  window.msdsShowRef = function (ref) {
    var s = document.getElementById("msds_search");
    if (s) { s.value = ref; }
    if (typeof window.msdsHistRender === "function") window.msdsHistRender();
    var t = document.getElementById("msds_hist_table");
    if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  function latestCheckFor(ref) {
    try { return (window.msdsHist ? window.msdsHist() : []).find(function (x) { return x.ref === ref; }) || null; } catch (e) { return null; }
  }

  /* ---- wrap existing functions ---- */
  function wrap() {
    if (window.__msdsPlusWrapped) return true;
    if (typeof window.msdsHistAdd !== "function" || typeof window.readMsdsPdf !== "function" || typeof window.msdsHistRender !== "function") return false;
    window.__msdsPlusWrapped = true;

    var origAdd = window.msdsHistAdd;
    window.msdsHistAdd = function (rec) {
      if (rec && current && current.ref && /pdf|•/i.test(rec.src || "") ) { rec.ref = current.ref; rec.hash = current.hash; }
      return origAdd.apply(this, arguments);
    };

    var origRead = window.readMsdsPdf;
    window.readMsdsPdf = async function () {
      try { await ensureStored(); } catch (e) {}
      return origRead.apply(this, arguments);
    };

    // history: latest check per MSDS (by ref, else by product name), with REF + date + VIEW
    window.msdsHistRender = function () {
      var tb = document.getElementById("msds_hist_table"); if (!tb) return;
      var q = ((document.getElementById("msds_search") || {}).value || "").toLowerCase();
      var all = window.msdsHist ? window.msdsHist() : [];
      var groups = [], byKey = {};
      all.forEach(function (x, i) {           // list is newest-first
        var k = x.ref ? "R:" + x.ref : "N:" + String(x.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!byKey[k]) { byKey[k] = { rec: x, idx: i, count: 0, key: k }; groups.push(byKey[k]); }
        byKey[k].count++;
      });
      var html = "<tr><th>REF</th><th>LAST CHECKED</th><th>PRODUCT / MSDS</th><th>VERDICT</th><th>UN / ID</th><th>CLASS</th><th>PG</th><th>DETAILS</th><th></th></tr>";
      var shown = 0;
      groups.forEach(function (g) {
        var x = g.rec;
        if (q && !((x.ref || "") + " " + (x.name || "") + " " + (x.un || "") + " " + (x.psn || "") + " " + (x.src || "")).toLowerCase().includes(q)) return;
        shown++;
        var vd = x.verdict === "DG" ? "<b style='color:#a40000;'>&#9888; DG</b>" : (x.verdict === "NON-DG" ? "<b style='color:#1d6b34;'>&#10004; NON-DG</b>" : "<span style='color:#b45309;'>?</span>");
        html += "<tr>" +
          "<td style='white-space:nowrap;'>" + (x.ref ? "<b style='color:#0f2b4c;'>" + h(x.ref) + "</b><div><button class='smallbtn sb-blue' style='margin-top:4px;' onclick='msdsView(\"" + h(x.ref) + "\")'>&#128065; VIEW</button></div>" : "<span style='color:#8a97a5; font-size:11px;'>text only</span>") + "</td>" +
          "<td style='white-space:nowrap;'>" + h(x.when || "") + (g.count > 1 ? "<div style='font-size:10.5px; color:#8a97a5;'>checked " + g.count + "×</div>" : "") + "</td>" +
          "<td><b>" + h(x.name || "") + "</b>" + (x.src ? "<div style='font-size:10.5px; color:#8a97a5;'>" + h(x.src) + "</div>" : "") + "</td>" +
          "<td>" + vd + "</td><td><b>" + h(x.un || "—") + "</b></td><td>" + h(x.cls || "") + "</td><td>" + h(x.pg || "") + "</td>" +
          "<td style='font-size:11.5px; max-width:340px;'>" + h(x.psn || "") + (x.note ? "<div style='color:#5b6b7d;'>" + h(x.note) + "</div>" : "") + "</td>" +
          "<td><button class='smallbtn sb-red' title='Remove this history entry' onclick='msdsPlusDel(\"" + h(g.key) + "\")'>x</button></td></tr>";
      });
      if (!all.length) html += "<tr><td colspan='9' style='color:#8a97a5;'>No checks yet — every MSDS check is saved here automatically.</td></tr>";
      else if (!shown) html += "<tr><td colspan='9' style='color:#8a97a5;'>No match for the search.</td></tr>";
      tb.innerHTML = html;
    };
    window.msdsPlusDel = function (key) {
      if (!confirm("Remove this MSDS from the history list? (the stored PDF stays)")) return;
      var l = window.msdsHist().filter(function (x) {
        var k = x.ref ? "R:" + x.ref : "N:" + String(x.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        return k !== key;
      });
      if (typeof window.setStore === "function") window.setStore("jfs_msds_history", l);
      window.msdsHistRender();
    };

    var el = document.getElementById("msdsfile");
    if (el) el.addEventListener("change", onFilePicked);
    try { window.msdsHistRender(); } catch (e) {}
    return true;
  }
  var tries = 0;
  var t = setInterval(function () { if (wrap() || ++tries > 60) clearInterval(t); }, 1000);
})();
