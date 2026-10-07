/* ============================================================
   DGDOC MOBILE — full phone experience (additive, no core edits)
   - responsive layout + hamburger menu
   - sticky DGD action bar (Draft / Confirm / Print / Share PDF)
   - camera capture for label & packing-list AI
   - Share DGD as PDF (WhatsApp / e-mail via Web Share)
   - PWA install (Add to Home Screen)
   ============================================================ */
(function () {
  "use strict";
  var MQ = 900; // px — below this = mobile layout

  /* ---------------- responsive CSS ---------------- */
  var css = [
    "@media screen and (max-width:" + MQ + "px){",
    "  html{ -webkit-text-size-adjust:100%; }",
    "  body{ padding:0 !important; }",
    "  .nav{ position:fixed !important; left:0; top:0; bottom:0; width:264px; transform:translateX(-105%);",
    "    transition:transform .25s ease; z-index:9500; overflow-y:auto; box-shadow:6px 0 24px rgba(0,0,0,.45); display:block !important; }",
    "  .nav.mopen{ transform:translateX(0) !important; }",
    /* the desktop sidebar style only applies >900px — give the phone drawer its own full sidebar look:
       one option per row, full width, readable size (was: 2 cramped items per row) */
    "  .nav{ display:flex !important; flex-direction:column !important; flex-wrap:nowrap !important; align-items:stretch !important;",
    "    overflow-x:hidden !important; overflow-y:auto !important; gap:3px !important; margin:0 !important;",
    "    padding:62px 12px 24px !important; background:linear-gradient(168deg,#0c1a3c 0%,#13244f 60%,#182c5e 100%) !important; }",
    "  .nav button{ width:100% !important; flex:0 0 auto !important; text-align:left !important; white-space:normal !important;",
    "    font-size:14px !important; padding:12px 14px !important; border-radius:10px !important; color:#e3e9fb !important;",
    "    background:transparent !important; border:none !important; border-left:4px solid transparent !important; }",
    "  .nav button.on{ background:rgba(255,255,255,.13) !important; color:#fff !important; border-left-color:var(--acc,#ff6b4a) !important; }",
    "  .nav button:active{ background:rgba(255,255,255,.2) !important; }",
    "  #mob_burger{ display:flex !important; }",
    "  #mob_dim{ display:none; position:fixed; inset:0; background:rgba(5,15,30,.55); z-index:9400; }",
    "  #mob_dim.on{ display:block; }",
    "  .main, .content, .page, .wrap{ margin-left:0 !important; width:100% !important; }",
    "  .tab{ padding:8px 6px 96px !important; }",
    "  .card .body{ padding:12px 10px !important; }",
    "  .card h2{ font-size:14px !important; padding:10px 12px !important; }",
    "  input[type=text], input[type=password], input[type=number], textarea, select{",
    "    font-size:16px !important; width:100% !important; max-width:100% !important; box-sizing:border-box; }",
    "  .body > div[style*='flex']{ flex-wrap:wrap !important; overflow-x:visible !important; }",
    "  .btn{ padding:13px 16px !important; font-size:14px !important; }",
    "  .smallbtn{ padding:9px 12px !important; font-size:12.5px !important; }",
    "  table{ display:block; overflow-x:auto; white-space:nowrap; max-width:100%; }",
    "  .previewwrap{ overflow-x:auto !important; -webkit-overflow-scrolling:touch; }",
    "  .topbar, #topbar{ padding-left:58px !important; }",
    "}",
    "#mob_burger{ display:none; position:fixed; left:10px; top:10px; z-index:9600; width:42px; height:42px;",
    "  border:none; border-radius:12px; background:#0f2b4c; color:#fff; font-size:20px; font-weight:800;",
    "  box-shadow:0 4px 14px rgba(0,0,0,.35); align-items:center; justify-content:center; cursor:pointer; }",
    "#mob_actions{ display:none; position:fixed; left:0; right:0; bottom:0; z-index:9300; gap:6px;",
    "  background:rgba(11,21,38,.97); padding:8px 8px calc(8px + env(safe-area-inset-bottom)); ",
    "  box-shadow:0 -6px 18px rgba(0,0,0,.4); }",
    "#mob_actions button{ flex:1; border:none; border-radius:10px; padding:12px 4px; color:#fff;",
    "  font-weight:800; font-size:12px; letter-spacing:.3px; cursor:pointer; }",
    "@media print{ #mob_burger, #mob_actions, #mob_dim, #mob_install{ display:none !important; } }"
  ].join("\n");
  var st = document.createElement("style");
  st.id = "mobilecss";
  st.textContent = css;
  document.head.appendChild(st);

  function isMobile() { return window.innerWidth <= MQ; }

  /* ---------------- hamburger menu ---------------- */
  function buildBurger() {
    if (document.getElementById("mob_burger")) return;
    var nav = document.querySelector(".nav");
    if (!nav) return;
    var b = document.createElement("button");
    b.id = "mob_burger";
    b.innerHTML = "&#9776;";
    b.title = "Menu";
    b.onclick = function () {
      nav.classList.toggle("mopen");
      dim.classList.toggle("on", nav.classList.contains("mopen"));
    };
    var dim = document.createElement("div");
    dim.id = "mob_dim";
    dim.onclick = function () { nav.classList.remove("mopen"); dim.classList.remove("on"); };
    document.body.appendChild(dim);
    document.body.appendChild(b);
    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON") { nav.classList.remove("mopen"); dim.classList.remove("on"); }
    });
  }

  /* ---------------- sticky DGD action bar ---------------- */
  function buildActions() {
    if (document.getElementById("mob_actions")) return;
    var bar = document.createElement("div");
    bar.id = "mob_actions";
    bar.innerHTML =
      '<button style="background:#b45309;" onclick="if(typeof dgdSaveDraft===\'function\')dgdSaveDraft()">&#128190; DRAFT</button>' +
      '<button style="background:#1d6b34;" onclick="if(typeof dgdConfirm===\'function\')dgdConfirm()">&#10004; CONFIRM</button>' +
      '<button style="background:#a40000;" onclick="if(typeof printDGD===\'function\')printDGD()">&#128424; PRINT</button>' +
      '<button style="background:#7b2d8b;" onclick="if(window.mobSharePdf)mobSharePdf()">&#128228; SHARE PDF</button>';
    document.body.appendChild(bar);
    updateActions();
  }
  function updateActions() {
    var bar = document.getElementById("mob_actions");
    if (!bar) return;
    var dgdOn = document.getElementById("tab-dgd") && document.getElementById("tab-dgd").classList.contains("on");
    bar.style.display = (isMobile() && dgdOn) ? "flex" : "none";
  }
  // follow tab changes
  if (typeof window.showTab === "function") {
    var _origShowTab = window.showTab;
    window.showTab = function () { var r = _origShowTab.apply(this, arguments); try { updateActions(); } catch (e) {} return r; };
  }
  window.addEventListener("resize", function () { try { updateActions(); } catch (e) {} });

  /* ---------------- camera capture buttons ---------------- */
  function addCamera(boxId, handlerName, label) {
    var box = document.getElementById(boxId);
    if (!box || document.getElementById(boxId + "_cam")) return;
    var b = document.createElement("button");
    b.id = boxId + "_cam";
    b.className = "smallbtn sb-blue";
    b.innerHTML = "&#128247; " + label;
    b.style.cssText = "margin-top:8px; font-weight:800;";
    b.onclick = function (ev) {
      ev.stopPropagation();
      var inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/*";
      inp.setAttribute("capture", "environment");
      inp.multiple = true;   /* v25.11-H: several labels / packing lists picked from the gallery */
      inp.onchange = function () {
        var fl = Array.prototype.slice.call(inp.files || []);
        if (fl.length > 1 && handlerName === "awbFromImage" && typeof window.hdReadMulti === "function") return window.hdReadMulti(fl);
        if (fl.length > 1 && handlerName === "ptFromImage" && typeof window.ptReadMulti === "function") return window.ptReadMulti(fl);
        var f = fl[0];
        if (f && typeof window[handlerName] === "function") window[handlerName](f);
      };
      inp.click();
    };
    box.parentNode.insertBefore(b, box.nextSibling);
  }

  /* ---------------- Share DGD as PDF ---------------- */
  function loadHtml2Pdf() {
    return new Promise(function (res, rej) {
      if (window.html2pdf) return res();
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
      s.onload = res; s.onerror = function () { rej(new Error("PDF engine load failed")); };
      document.head.appendChild(s);
    });
  }
  window.mobSharePdf = async function () {
    var src = document.querySelector(".previewwrap");
    if (!src || !src.innerHTML.trim()) { alert("Open the DG SHIPMENT tab first — the DGD preview is what gets shared."); return; }
    try {
      await loadHtml2Pdf();
      var job = (document.getElementById("f_job") || {}).value || "DGD";
      var opt = { margin: 0, filename: "DGD_" + job.replace(/[^A-Za-z0-9-]/g, "_") + ".pdf",
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"] } };
      var blob = await html2pdf().set(opt).from(src).outputPdf("blob");
      var file = new File([blob], opt.filename, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: opt.filename, text: "DGD " + job + " — JFS Logistics" });
      } else {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = opt.filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }
    } catch (e) {
      if ((e && e.name) !== "AbortError") alert("Share failed: " + (e.message || e).slice(0, 80));
    }
  };

  /* ---------------- PWA install ---------------- */
  if ("serviceWorker" in navigator) {
    try { navigator.serviceWorker.register("/sw.js"); } catch (e) {}
  }
  var deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    addInstallItem();
  });
  function addInstallItem() {
    var nav = document.querySelector(".nav");
    if (!nav || document.getElementById("mob_install")) return;
    var b = document.createElement("button");
    b.id = "mob_install";
    b.innerHTML = "&#128241; INSTALL APP";
    b.style.cssText = "margin-top:6px; background:linear-gradient(135deg,#ff6b4a,#d94f30); color:#fff; font-weight:800;";
    b.onclick = function () {
      if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; b.remove(); }
    };
    nav.appendChild(b);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    buildBurger();
    buildActions();
    addCamera("awb_photobox", "awbFromImage", "TAKE LABEL PHOTO (camera)");
    addCamera("pt_photobox", "ptFromImage", "TAKE PACKING LIST PHOTO (camera)");
    updateActions();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  // late-rendered elements (tabs render on demand)
  var tries = 0;
  var t = setInterval(function () { boot(); if (++tries > 15) clearInterval(t); }, 2000);
})();
