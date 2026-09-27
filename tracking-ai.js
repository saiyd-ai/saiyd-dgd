/* ============================================================
   TRACKING — AI SCREENSHOT UPDATE (additive, does not touch tracking.js)
   For AWBs not linked to TrackCargo: check the airline website manually,
   take a screenshot, paste it here -> AI reads the AWB + status history ->
   saved as manual updates (with the carrier's last event time) in jfs_tracking.
   ============================================================ */
(function () {
  "use strict";
  var CODES = "BKD (booked), RCS (received from shipper / freight received), MAN (manifested / prepared for loading), " +
    "DEP (departed), ARR (arrived on flight), RCF (received from flight), NFD (consignee notified / informed of arrival), " +
    "AWD (documents delivered), DLV (delivered to consignee), TFD (transferred), HLD (on hold)";

  function digits(v) { return String(v || "").replace(/\D/g, ""); }
  function keyFor(awbDigits) { return awbDigits.slice(0, 3) + "-" + awbDigits.slice(3); }
  function readTrk() { try { return JSON.parse(localStorage.getItem("jfs_tracking") || "{}") || {}; } catch (e) { return {}; } }
  function saveTrk(all) {
    localStorage.setItem("jfs_tracking", JSON.stringify(all));
    if (typeof window.cloudPushDebounced === "function") window.cloudPushDebounced("jfs_tracking");
    try { if (window.DgTracking && typeof window.DgTracking.render === "function") window.DgTracking.render(); } catch (e) {}
    try { if (typeof window.renderDash === "function" && document.getElementById("dashkpi")) window.renderDash(); } catch (e) {}
  }
  function msg(text, color) {
    var m = document.getElementById("trkai_msg");
    if (m) { m.textContent = text; m.style.color = color || "#0e7490"; }
  }
  // carrier times are LOCAL to the event airport — show them exactly as the airline wrote them
  function fmtLocal(dt) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(dt || ""));
    if (!m) return "";
    var mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][parseInt(m[2], 10) - 1] || m[2];
    return m[3] + " " + mon + " " + m[1] + (m[4] ? " " + m[4] + ":" + m[5] : "") + " (local)";
  }
  function fmtDubai(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " Dubai";
  }

  async function readScreenshot(file) {
    if (typeof window.aiCall !== "function" || typeof window.imgFileToB64 !== "function") { msg("AI engine not loaded — reload the page.", "#a40000"); return; }
    if (typeof window.aiKey === "function" && !window.aiKey()) { msg("AI key not loaded yet — reload the page once.", "#a40000"); return; }
    var box = document.getElementById("trkai_box");
    try {
      var url = URL.createObjectURL(file);
      if (box) box.innerHTML = '<div style="display:flex; align-items:center; gap:12px; justify-content:center;"><img src="' + url +
        '" style="max-height:64px; max-width:130px; border:1px solid #b9dde6; border-radius:6px;"><span style="color:#1d6b34; font-weight:bold;">&#10003; Screenshot received — AI reading the tracking history...</span></div>';
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    } catch (e) {}
    msg("🤖 AI reading the airline tracking screenshot...");
    try {
      var b64 = await window.imgFileToB64(file, 2200);
      var today = new Date().toISOString().slice(0, 10);
      var sys = "You read AIRLINE CARGO TRACKING screenshots (airline websites) for a freight forwarder. Today is " + today + ".\n" +
        "Respond ONLY JSON: {\"awb\":\"11-digit master AWB e.g. 147-93884184\",\"origin\":\"IATA code\",\"destination\":\"IATA code\"," +
        "\"current_status\":\"short text of the latest status e.g. Delivered to consignee\"," +
        "\"events\":[{\"code\":\"one of the codes\",\"description\":\"status text exactly as shown\",\"location\":\"city or airport\"," +
        "\"flight\":\"flight no or empty\",\"pieces\":number or null,\"weight\":number or null,\"datetime\":\"ISO 8601 local time e.g. 2026-09-17T11:30\"}]}\n" +
        "Codes: " + CODES + ".\n" +
        "Rules: list EVERY status row shown, newest first. Dates without a year (e.g. 17SEP 11:30) belong to the most recent past " +
        "occurrence relative to today. If only a date is shown use 00:00. Never invent rows that are not in the screenshot.";
      var content = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: "Extract the AWB and full status history from this airline tracking screenshot." }];
      var j = window.aiJson(await window.aiCall(sys, content, 6000));
      applyResult(j);
    } catch (e) {
      msg("AI read failed: " + String((e && e.message) || e).slice(0, 90), "#a40000");
    }
  }

  function applyResult(j) {
    var awbD = digits(j && j.awb);
    if (awbD.length !== 11) {
      var typed = prompt("AI could not read the AWB number from the screenshot.\nType the 11-digit master AWB (e.g. 147-93884184):", "");
      awbD = digits(typed);
      if (awbD.length !== 11) { msg("No valid AWB — nothing saved.", "#a40000"); return; }
    }
    var events = (j.events || []).filter(function (e) { return e && (e.description || e.code); });
    if (!events.length) { msg("AI found no status rows in the screenshot — nothing saved.", "#a40000"); return; }
    // oldest -> newest so the latest event is the last manual entry
    events.forEach(function (e) { e._t = Date.parse(e.datetime) || 0; });
    events.sort(function (a, b) { return a._t - b._t; });
    var all = readTrk();
    var key = Object.keys(all).find(function (k) { return digits((all[k] && all[k].awb) || k) === awbD; }) || keyFor(awbD);
    var rec = all[key] || { awb: keyFor(awbD), job: "", route: [j.origin, j.destination].filter(Boolean).join(" - "), shipper: "", consignee: "", milestones: [], updated: 0 };
    rec.milestones = Array.isArray(rec.milestones) ? rec.milestones : [];
    // drop older screenshot imports for this AWB — the new screenshot is the full current history
    rec.milestones = rec.milestones.filter(function (m) { return !(m && m.via === "screenshot"); });
    var by = "";
    try { if (typeof sbUser !== "undefined" && sbUser && typeof userDisplayName === "function") by = userDisplayName(sbUser.email); } catch (e) {}
    var now = Date.now();
    events.forEach(function (e, i) {
      var when = fmtLocal(e.datetime);
      rec.milestones.push({
        code: String(e.code || "UPD").toUpperCase().slice(0, 3),
        note: [e.description, e.location, e.flight ? "Flight " + e.flight : "", e.pieces ? e.pieces + " pcs" : "", e.weight ? e.weight + " kg" : "",
          when ? "Carrier time: " + when : ""].filter(Boolean).join(" · "),
        ts: now + i,                        // recorded order = carrier chronological order
        eventDate: e._t ? new Date(e._t).toISOString() : null,
        by: by, src: "Airline website screenshot", via: "screenshot"
      });
    });
    var last = events[events.length - 1];
    rec.lastCarrierEvent = last._t ? new Date(last._t).toISOString() : null;
    rec.lastCarrierEventLocal = fmtLocal(last.datetime);
    rec.lastCarrierStatus = j.current_status || last.description || "";
    rec.lastScreenshotAt = new Date(now).toISOString();
    rec.updated = now;
    if (!rec.route && (j.origin || j.destination)) rec.route = [j.origin, j.destination].filter(Boolean).join(" - ");
    all[key] = rec;
    saveTrk(all);
    var box = document.getElementById("trkai_box");
    if (box) box.innerHTML = "&#10003; " + keyFor(awbD) + " updated — " + events.length + " events. Paste another screenshot any time.";
    msg("✓ " + keyFor(awbD) + " updated from screenshot · latest: " + (rec.lastCarrierStatus || last.code) +
      (rec.lastCarrierEventLocal ? " · carrier time " + rec.lastCarrierEventLocal : "") +
      " · last updated " + fmtDubai(rec.lastScreenshotAt), "#1d6b34");
  }

  function build() {
    if (document.getElementById("trkai_card")) return;
    var anchor = document.getElementById("tracking-search");
    if (!anchor) return;
    var host = anchor.closest(".card") || anchor.parentNode;
    var card = document.createElement("div");
    card.id = "trkai_card";
    card.className = "card";
    card.style.cssText = "border-left:5px solid #0e7490;";
    card.innerHTML =
      '<h2 style="background:#e0f2f7; color:#0e7490;">&#128247; MANUAL TRACKING &mdash; paste the airline website screenshot, AI updates the AWB</h2>' +
      '<div class="body">' +
      '<div style="font-size:12.5px; color:#5b6b7d; margin-bottom:8px;">For AWBs not linked to TrackCargo: open <b>Track airline &#8599;</b>, take a screenshot of the status history, then paste it below. ' +
      'AI reads the AWB number and every status row, saves them as updates with the carrier time and the last-updated time.</div>' +
      '<div id="trkai_box" tabindex="0" style="border:2px dashed #0e7490; border-radius:10px; padding:16px; text-align:center; color:#0e7490; font-weight:bold; font-size:13px; cursor:pointer; background:#f1fafc;">' +
      '&#128203; CLICK HERE then PASTE (Ctrl+V) or DRAG the tracking screenshot</div>' +
      '<div style="display:flex; gap:10px; align-items:center; margin-top:8px; flex-wrap:wrap;">' +
      '<button class="smallbtn sb-blue" id="trkai_pick">&#128193; Choose screenshot file</button>' +
      '<span id="trkai_msg" style="font-size:12.5px; font-weight:bold; color:#0e7490;"></span></div>' +
      '</div>';
    host.parentNode.insertBefore(card, host);
    var box = document.getElementById("trkai_box");
    box.addEventListener("click", function () { box.focus(); });
    box.addEventListener("paste", function (e) {
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) { e.preventDefault(); readScreenshot(items[i].getAsFile()); return; }
      }
      msg("No image in the clipboard — copy the screenshot first, then Ctrl+V here.", "#b45309");
    });
    box.addEventListener("dragover", function (e) { e.preventDefault(); box.style.background = "#dff3f8"; });
    box.addEventListener("dragleave", function () { box.style.background = "#f1fafc"; });
    box.addEventListener("drop", function (e) {
      e.preventDefault(); box.style.background = "#f1fafc";
      var f = [].slice.call((e.dataTransfer || {}).files || []).find(function (x) { return (x.type || "").indexOf("image/") === 0; });
      if (f) readScreenshot(f); else msg("Drop an image (PNG/JPG) screenshot.", "#b45309");
    });
    document.getElementById("trkai_pick").addEventListener("click", function () {
      var inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*";
      inp.onchange = function () { if (inp.files && inp.files[0]) readScreenshot(inp.files[0]); };
      inp.click();
    });
  }

  /* ---------- ADMIN: select + delete tracking AWBs (owner only) ---------- */
  function adminOn() { return typeof window.isAdmin === "function" && window.isAdmin(); }
  function injectAdminBoxes() {
    var body = document.getElementById("tracking-body");
    if (!body || !adminOn()) return;
    if (!document.getElementById("adm_trkbar")) {
      var anchor = document.getElementById("tracking-search");
      if (anchor && anchor.parentNode) {
        var bar = document.createElement("span");
        bar.id = "adm_trkbar";
        bar.style.cssText = "display:inline-flex; gap:8px; align-items:center; margin-left:8px;";
        bar.innerHTML = '<label style="margin:0; font-size:12px; font-weight:bold; color:#a40000; display:inline-flex; gap:4px; align-items:center;">' +
          '<input type="checkbox" id="adm_trkall"> all</label>' +
          '<button class="smallbtn sb-red" id="adm_trkdel" style="font-weight:800;">&#128465; DELETE SELECTED (<span id="adm_trkcnt">0</span>)</button>';
        anchor.parentNode.insertBefore(bar, anchor.nextSibling);
        document.getElementById("adm_trkall").addEventListener("change", function () {
          var on = this.checked;
          document.querySelectorAll(".adm_trk").forEach(function (x) { x.checked = on; });
          if (typeof window.admCount === "function") window.admCount("adm_trk");
        });
        document.getElementById("adm_trkdel").addEventListener("click", function () {
          var awbs = [].slice.call(document.querySelectorAll(".adm_trk:checked")).map(function (x) { return x.dataset.trkawb; });
          if (typeof window.admDeleteTracking === "function") window.admDeleteTracking(awbs);
        });
      }
    }
    // only the real shipment rows (direct <tr data-awb> children) — never nested elements
    [].slice.call(body.children).filter(function (row) { return row.matches && row.matches("tr[data-awb]"); }).forEach(function (row) {
      if (row.querySelector(".adm_trk")) return;
      var first = row.firstElementChild || row;
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "adm_trk";
      cb.dataset.trkawb = row.dataset.awb;
      cb.title = "Select for delete (admin)";
      cb.style.cssText = "margin:0 8px 6px 0; transform:scale(1.25); cursor:pointer;";
      cb.addEventListener("click", function (e) { e.stopPropagation(); });
      cb.addEventListener("change", function () { if (typeof window.admCount === "function") window.admCount("adm_trk"); });
      first.insertBefore(cb, first.firstChild);
    });
  }
  var obsStarted = false;
  function startAdminObserver() {
    var body = document.getElementById("tracking-body");
    if (!body || obsStarted) return;
    obsStarted = true;
    new MutationObserver(function () { try { injectAdminBoxes(); } catch (e) {} }).observe(body, { childList: true, subtree: false });
    injectAdminBoxes();
  }
  setInterval(function () { try { startAdminObserver(); injectAdminBoxes(); } catch (e) {} }, 3000);

  window.trkAiApply = applyResult;   // for testing
  var tries = 0;
  var t = setInterval(function () { build(); if (document.getElementById("trkai_card") || ++tries > 60) clearInterval(t); }, 1000);
})();
