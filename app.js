// @ts-check
/* Dumanaltı — Utku & Gözde sigo takip PWA
   Veriler Supabase'de bulutta tutulur ve cihazlar arasında gerçek zamanlı
   senkronlanır. Çevrimdışıyken yerel önbellekten okunur, internet gelince
   bekleyen kayıtlar otomatik gönderilir. */

(function () {
  "use strict";

  // Semver: majör = büyük yeniden tasarım, minör = yeni özellik, patch = ince ayar.
  // Derleme numarası service worker önbellek sürümüyle (her dağıtımda artar) aynı.
  var APP_VERSION = "8.0.2";
  var APP_BUILD = 155;

  // Milat: 4 Ekim 2026 00:00:00 TSI (öncesi kayıtlar kabul edilmez ve temizlenir)
  var EPOCH_TS = 1791061200000;

  var THEME_KEY = "dumanalti.theme";
  var SETTINGS_KEY = "dumanalti.settings.v1";
  var ONBOARD_KEY = "dumanalti.onboarded.v1";
  var SESSION_KEY = "dumanalti.session.v1";
  var TRASH_KEY = "dumanalti.trash.v1";
  var PIN_KEY = "dumanalti.pin.v1";
  var BIO_KEY = "dumanalti.biometric.v1";
  var BACKUP_KEY = "dumanalti.lastBackupAt";
  var BADGES_KEY = "dumanalti.customBadges.v1";
  var CONFLICT_KEY = "dumanalti.conflicts.v1";

  var CFG = window.DUMANALTI_CONFIG || {};

  // ---------- Kategori tanımı ----------
  var CATS = {
    sigo: { label: "Sigo", emoji: "🚬", table: CFG.table || "dumanalti_entries", cacheKey: "dumanalti.entries.v1", outboxKey: "dumanalti.outbox.v1", unit: "sigo", unitPlural: "sigo" }
  };
  var CAT_ORDER = ["sigo"];
  var activeCat = "sigo";

  // Her kategorinin kendi veri deposu
  var catStore = {};
  CAT_ORDER.forEach(function (c) {
    catStore[c] = { entries: [], outbox: [] };
  });

  var WHO = {
    utku:  { label: "Utku", emoji: "👨", avatar: "icons/avatar-utku.png", cls: "utku-bg" },
    gozde: { label: "Gözde", emoji: "👩", avatar: "icons/avatar-gozde.png", cls: "gozde-bg" },
    both:  { label: "Ortak", emoji: "👫", avatar: "icons/avatar-both.png", cls: "both-bg" },
    hepberaber: { label: "Hep beraber", emoji: "🎉", avatar: "icons/avatar-hepberaber.svg", cls: "hepberaber-bg" }
  };

  var KINDS = {
    sigo: { label: "Sigo", emoji: "🚬", cls: "kind-sigo" },
    bong: { label: "Bong", emoji: "🫧", cls: "kind-bong" }
  };

  function entryKind(e) { return (e && e.kind) || "sigo"; }

  function countKinds(list) {
    var c = { sigo: 0, bong: 0 };
    for (var i = 0; i < list.length; i++) {
      var k = entryKind(list[i]);
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }

  // Ortak ve hep beraber içilenler ikisinin de kişisel sayacına işlenir
  function isShared(w) { return w === "both" || w === "hepberaber"; }

  function makeAvatar(who, cls) {
    var img = document.createElement("img");
    img.className = "avatar" + (cls ? " " + cls : "");
    img.src = WHO[who].avatar;
    img.alt = WHO[who].label;
    return img;
  }

  /** @type {Settings} */
  var settings = { dailyLimit: 0, confetti: "full", owner: "", sound: "off", locationEnabled: false };

  function updateQuickActions() {
    var me = el("quickMeBtn");
    var together = el("quickTogetherBtn");
    var hint = el("quickOwnerHint");
    if (!me || !together) return;
    var owner = settings.owner;
    me.textContent = owner ? "Ben içtim" : "Kişi seç";
    together.textContent = "Ortak içtik";
    if (hint) {
      hint.textContent = owner
        ? "Bu cihaz " + WHO[owner].label + " için ayarlı · " + CATS[activeCat].label + " kaydı"
        : "Tek dokunuş için Ayarlar’dan bu cihazın sahibini seç.";
    }
    document.querySelectorAll(".portal-card").forEach(function (card) {
      var selected = card.getAttribute("data-cat") === activeCat;
      card.classList.toggle("active", selected);
      card.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  var DAY_NAMES = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];

  // entries ve outbox aktif kategoriye alias olur (switchCat ile güncellenir)
  /** @type {Entry[]} */
  var entries = catStore.sigo.entries;
  /** @type {OutboxOp[]} */
  var outbox = catStore.sigo.outbox;
  var lastUndo = null;
  var undoTimer = null;
  var comboCount = 0;
  var comboTimer = null;
  var selectedAddKind = "sigo";
  var historyFilter = "all";
  var historyKind = "all";
  var historyQuery = "";
  var historyVisible = 30;
  var historyFromTs = 0;
  var historyToTs = Infinity;
  var editingId = null; // Geçmişte düzenleme paneli açık olan kaydın id'si
  var statsScope = "all"; // İstatistik kişi filtresi: all | both | hepberaber | gozde | utku
  var statsKind = "all"; // İstatistik tür filtresi: all | sigo | bong
  var scopeIncludeBoth = true; // Gözde/Utku seçiliyken ortak/beraber içilenler dahil mi
  var comparisonPeriod = "7";
  var activeSession = null;
  var trash = [];
  var conflicts = [];
  var customBadges = [];

  // Tek Sigo kategorisini etkinleştir ve arayüzü yeniden çiz.
  function switchCat(cat) {
    if (cat !== "sigo") cat = "sigo";
    // Mevcut veriyi depoya geri kaydet
    catStore[activeCat].entries = entries;
    catStore[activeCat].outbox = outbox;
    activeCat = cat;
    entries = catStore[cat].entries;
    outbox = catStore[cat].outbox;
    document.body.setAttribute("data-cat", cat);
    var sigoSeg = el("sigoKindSeg");
    if (sigoSeg) sigoSeg.style.display = "";

    var kBar = el("kindScopeBar");
    if (kBar) kBar.style.display = "";
    var hkFilters = el("histKindFilters");
    if (hkFilters) hkFilters.style.display = "";

    document.querySelectorAll(".add-opt[data-who='both'], .add-opt[data-who='hepberaber']").forEach(function (b) {
      /** @type {HTMLElement} */ (b).style.display = "";
    });
    // Bugün kartında Ortak ve Hep beraber satırlarını gizle/göster
    var duoBoth = document.querySelector(".duo-row:has(#todayBoth)");
    if (!duoBoth) {
      // Browser compatibility fallback for :has
      var elBoth = el("todayBoth");
      if (elBoth && elBoth.parentElement) duoBoth = elBoth.parentElement;
    }
    if (duoBoth) /** @type {HTMLElement} */ (duoBoth).style.display = "";

    var duoHep = document.querySelector(".duo-row:has(#todayHepberaber)");
    if (!duoHep) {
      var elHep = el("todayHepberaber");
      if (elHep && elHep.parentElement) duoHep = elHep.parentElement;
    }
    if (duoHep) /** @type {HTMLElement} */ (duoHep).style.display = "";

    var rememberedKind = localStorage.getItem("dumanalti.lastKind." + cat);
    if (KINDS[rememberedKind]) selectedAddKind = rememberedKind;
    if (!selectedAddKind || !KINDS[selectedAddKind]) {
      selectedAddKind = "sigo";
      if (sigoSeg) {
        sigoSeg.querySelectorAll(".add-kind-btn").forEach(function (btn) {
          btn.classList.toggle("active", btn.getAttribute("data-kind") === "sigo");
        });
      }
    }
    updateQuickActions();
    document.querySelectorAll(".portal-card").forEach(function (card) {
      card.classList.toggle("active", card.getAttribute("data-cat") === cat);
      card.setAttribute("aria-pressed", card.getAttribute("data-cat") === cat ? "true" : "false");
    });
    render();
    try { localStorage.setItem("dumanalti.activeCat", cat); } catch (e) {}
  }

  function scopedEntries() {
    var list = entries;
    if (statsKind === "sigo") list = list.filter(function (e) { return entryKind(e) === "sigo"; });
    else if (statsKind === "bong") list = list.filter(function (e) { return entryKind(e) === "bong"; });

    if (statsScope === "both") return list.filter(function (e) { return e.who === "both"; });
    if (statsScope === "hepberaber") return list.filter(function (e) { return e.who === "hepberaber"; });
    if (statsScope === "gozde") return list.filter(function (e) { return e.who === "gozde" || (scopeIncludeBoth && isShared(e.who)); });
    if (statsScope === "utku") return list.filter(function (e) { return e.who === "utku" || (scopeIncludeBoth && isShared(e.who)); });
    return list;
  }

  var sb = null;        // Supabase client
  var cloudReady = false;
  var lastCloudError = null;
  var lastSyncAt = 0;
  var onlineUsers = {};
  var lastKnownLocation = null;

  function updatePresenceUI() {
    var presEl = el("presenceStatus");
    var presText = el("presenceText");
    if (!presEl || !presText) return;
    var names = Object.keys(onlineUsers);
    if (names.length === 0) {
      presEl.classList.add("hidden");
    } else {
      presEl.classList.remove("hidden");
      presText.textContent = names.join(" & ") + " online";
    }
  }


  function cloudError(err) {
    var msg = (err && (err.message || err.error_description || err.details)) || String(err);
    lastCloudError = msg;
    try { console.error("Dumanaltı bulut hatası:", err); } catch (e) {}
    refreshStatus();
  }

  function refreshStatus() {
    var info = el("syncInfo");
    if (!info) return;
    var totalOutbox = 0;
    CAT_ORDER.forEach(function (c) { totalOutbox += catStore[c].outbox.length; });
    if (!navigator.onLine) {
      info.textContent = "Durum: Çevrimdışı (İnternet yok" + (totalOutbox ? " · " + totalOutbox + " işlem bekliyor" : "") + ") 📴";
      return;
    }
    if (!sb) {
      info.textContent = "Durum: Yerel mod ⚠️";
      return;
    }
    if (lastCloudError) {
      info.textContent = "Durum: Bulut hatası (" + lastCloudError + ") ⚠️";
      return;
    }
    if (totalOutbox > 0) {
      info.textContent = "Durum: " + totalOutbox + " kayıt senkronlanmayı bekliyor... ⏳";
      return;
    }
    if (cloudReady) {
      var timeStr = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "az önce";
      info.textContent = "Durum: Bulut senkronize (" + timeStr + ") 🟢";
      return;
    }
    info.textContent = "Durum: Bağlanıyor... 🔄";
  }

  // ---------- Local cache ----------
  function loadCache() {
    CAT_ORDER.forEach(function (c) {
      var cfg = CATS[c];
      try {
        var raw = localStorage.getItem(cfg.cacheKey);
        var parsedEntries = raw ? JSON.parse(raw) : [];
        catStore[c].entries = Array.isArray(parsedEntries) ? parsedEntries.map(function (e) {
          return normalizeEntry(e, c, false);
        }).filter(function (e) { return !!e && e.ts >= EPOCH_TS; }) : [];
        if (!Array.isArray(catStore[c].entries)) catStore[c].entries = [];
        catStore[c].entries.sort(function (a, b) { return a.ts - b.ts; });
        saveCatCache(c);
      } catch (e) { catStore[c].entries = []; }
      try {
        var ob = localStorage.getItem(cfg.outboxKey);
        catStore[c].outbox = ob ? JSON.parse(ob) : [];
        if (!Array.isArray(catStore[c].outbox)) catStore[c].outbox = [];
        catStore[c].outbox = catStore[c].outbox.filter(function (op) {
          if (op.row && op.row.ts && op.row.ts < EPOCH_TS) return false;
          return true;
        });
        saveCatOutbox(c);
      } catch (e) { catStore[c].outbox = []; }
    });
    // Aktif kategoriyi alias'a bağla
    entries = catStore[activeCat].entries;
    outbox = catStore[activeCat].outbox;
    sortEntries();
    // Kayıtlı aktif kategoriyi yükle
    try {
      var saved = localStorage.getItem("dumanalti.activeCat");
      if (saved && CATS[saved]) activeCat = saved;
    } catch (e) {}
    entries = catStore[activeCat].entries;
    outbox = catStore[activeCat].outbox;
  }

  function saveCache() {
    try { localStorage.setItem(CATS[activeCat].cacheKey, JSON.stringify(entries)); } catch (e) {}
  }
  function saveOutbox() {
    try { localStorage.setItem(CATS[activeCat].outboxKey, JSON.stringify(outbox)); } catch (e) {}
  }
  // Belirli bir kategorinin önbelleğini kaydet (sync sonrası)
  function saveCatCache(cat) {
    try { localStorage.setItem(CATS[cat].cacheKey, JSON.stringify(catStore[cat].entries)); } catch (e) {}
  }
  function saveCatOutbox(cat) {
    try { localStorage.setItem(CATS[cat].outboxKey, JSON.stringify(catStore[cat].outbox)); } catch (e) {}
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (s && typeof s === "object") {
        settings.dailyLimit = +s.dailyLimit || 0;
        settings.confetti = s.confetti === "lite" || s.confetti === "off" ? s.confetti : "full";
        settings.owner = s.owner === "utku" || s.owner === "gozde" ? s.owner : "";
        settings.sound = s.sound === "on" ? "on" : "off";
        settings.locationEnabled = s.locationEnabled === true;
        
      }
    } catch (e) {}
    try {
      trash = JSON.parse(localStorage.getItem(TRASH_KEY) || "[]");
      if (!Array.isArray(trash)) trash = [];
      trash = trash.filter(function (item) { return !!(item && CATS[item.cat] && item.row); });
    } catch (e3) { trash = []; }
    try {
      conflicts = JSON.parse(localStorage.getItem(CONFLICT_KEY) || "[]");
      if (!Array.isArray(conflicts)) conflicts = [];
      conflicts = conflicts.filter(function (item) { return !!(item && CATS[item.cat]); });
    } catch (e4) { conflicts = []; }
    try { customBadges = JSON.parse(localStorage.getItem(BADGES_KEY) || "[]"); if (!Array.isArray(customBadges)) customBadges = []; } catch (e5) { customBadges = []; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  // Yerel dosya, cache ve buluttan gelen kayıtları tek güvenli biçime dönüştür.
  function normalizeEntry(raw, cat, allowNewId) {
    if (!raw || typeof raw !== "object" || !WHO[raw.who]) return null;
    var ts = Number(raw.ts);
    if (!isFinite(ts) || ts <= 0) return null;
    if (ts < EPOCH_TS) return null; // Milat: 4 Ekim öncesi kayıtlar elenir
    var validId = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(raw.id);
    if (!validId && !allowNewId) return null;
    var kind = KINDS[raw.kind] ? raw.kind : "sigo";
    var row = { id: validId ? raw.id : uuid(), who: raw.who, ts: ts, kind: kind };
    if (typeof raw.tag === "string" && raw.tag.length <= 120) row.tag = raw.tag;
    var lat = Number(raw.lat), lng = Number(raw.lng);
    if (isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      row.lat = lat;
      row.lng = lng;
    }
    if (typeof raw.session_id === "string" || typeof raw.sessionId === "string") row.sessionId = String(raw.session_id || raw.sessionId).slice(0, 100);
    if (typeof raw.deleted_at === "string" || typeof raw.deletedAt === "string") row.deletedAt = String(raw.deleted_at || raw.deletedAt);
    if (typeof raw.updated_at === "string" || typeof raw.updatedAt === "string") row.updatedAt = String(raw.updated_at || raw.updatedAt);
    return row;
  }

  function sortEntries() {
    entries.sort(function (a, b) { return a.ts - b.ts; });
  }
  function findIndexById(id) {
    for (var i = 0; i < entries.length; i++) { if (entries[i].id === id) return i; }
    return -1;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ---------- Date helpers ----------
  // Mantıksal gün: gün gece yarısı değil 04:00'te biter. Gece 00:00-04:00 arası
  // içilenler önceki güne sayılır (gerçek saat korunur, sadece gruplama kayar).
  var DAY_START_HOUR = 4;

  // ts'i 4 saat geri kaydırılmış takvimde okur (gruplama için)
  function logicalDate(d) {
    var t = d instanceof Date ? d.getTime() : d;
    return new Date(t - DAY_START_HOUR * 3600000);
  }
  // Mantıksal günün gerçek başlangıcı: o günün 04:00'ü
  function startOfDay(d) {
    var x = logicalDate(d);
    x.setHours(0, 0, 0, 0);
    return new Date(x.getTime() + DAY_START_HOUR * 3600000);
  }
  function dayKey(d) {
    var x = logicalDate(d);
    return x.getFullYear() + "-" + (x.getMonth() + 1) + "-" + x.getDate();
  }
  function isSameDay(a, b) { return dayKey(a) === dayKey(b); }
  // Ayın gerçek başlangıcı: mantıksal takvimde ayın 1'i, gerçek zamanda 04:00
  function startOfMonth() {
    var m = logicalDate(Date.now());
    m.setDate(1);
    m.setHours(0, 0, 0, 0);
    return m.getTime() + DAY_START_HOUR * 3600000;
  }
  function startOfWeek(d) {
    var x = startOfDay(d);
    var day = (x.getDay() + 6) % 7; // Pzt=0
    x.setDate(x.getDate() - day);
    return x;
  }
  function formatTime(ts) {
    var d = new Date(ts);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function relativeTime(ts) {
    var diff = Date.now() - ts;
    var min = Math.floor(diff / 60000);
    if (min < 1) return "az önce";
    if (min < 60) return min + " dk önce";
    var hr = Math.floor(min / 60);
    var remMin = min % 60;
    if (hr < 24) {
      return remMin > 0 ? hr + " sa " + remMin + " dk önce" : hr + " sa önce";
    }
    var day = Math.floor(hr / 24);
    if (day === 1) return "dün";
    return day + " gün önce";
  }

  // İki sigara arasındaki süreyi formatlar (ör. "1 sa 18 dk")
  function fmtGap(ms) {
    if (!ms || ms <= 0 || !isFinite(ms)) return null;
    var min = Math.floor(ms / 60000);
    if (min < 1) return "<1 dk";
    if (min < 60) return min + " dk";
    var hr = Math.floor(min / 60);
    var remMin = min % 60;
    if (hr < 24) {
      return remMin > 0 ? hr + " sa " + remMin + " dk" : hr + " sa";
    }
    var day = Math.floor(hr / 24);
    var remHr = hr % 24;
    return remHr > 0 ? day + "g " + remHr + " sa" : day + "g";
  }

  // Bir kaydın kendisinden önceki sigarayla arasındaki süreyi hesaplar (günün ilk sigarasında sayılmaz)
  function entryPrevGap(e, list) {
    var arr = list || entries;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === e.id) {
        if (i > 0) {
          var prev = arr[i - 1];
          // Günün ilk sigarası: önceki kayıt farklı bir mantıksal güne aitse sayma
          if (dayKey(e.ts) !== dayKey(prev.ts)) return null;
          return e.ts - prev.ts;
        }
        return null;
      }
    }
    return null;
  }

  // Gün içi sigo aralıklarını (gece uykusunu hariç tutarak) dizi olarak döndürür
  function calcIntraDayGaps(list) {
    var byD = {};
    (list || []).forEach(function (e) {
      var k = dayKey(e.ts);
      if (!byD[k]) byD[k] = [];
      byD[k].push(e);
    });
    var gaps = [];
    Object.keys(byD).forEach(function (k) {
      var dayList = byD[k].slice().sort(function (a, b) { return a.ts - b.ts; });
      for (var i = 1; i < dayList.length; i++) {
        var g = dayList[i].ts - dayList[i - 1].ts;
        if (g > 0) gaps.push(g);
      }
    });
    return gaps;
  }

  // ---------- Stats ----------
  function countWho(list) {
    var c = { utku: 0, gozde: 0, both: 0, hepberaber: 0, total: 0 };
    for (var i = 0; i < list.length; i++) {
      var w = list[i].who;
      if (c[w] === undefined) c[w] = 0;
      c[w]++;
      c.total++;
    }
    return c;
  }
  function calcAverages(list, days) {
    if (!days || days <= 0) {
      return { utku: 0, gozde: 0, total: 0, utkuStr: "0.0", gozdeStr: "0.0", totalStr: "0.0", breakdown: "🧔 0.0 · 👩 0.0" };
    }
    var c = countWho(list);
    var uCount = c.utku + c.both + c.hepberaber;
    var gCount = c.gozde + c.both + c.hepberaber;
    var uAvg = uCount / days;
    var gAvg = gCount / days;
    var tAvg = list.length / days;
    var uStr = uAvg.toFixed(1);
    var gStr = gAvg.toFixed(1);
    var tStr = tAvg.toFixed(1);
    return {
      utku: uAvg,
      gozde: gAvg,
      total: tAvg,
      utkuStr: uStr,
      gozdeStr: gStr,
      totalStr: tStr,
      breakdown: "🧔 " + uStr + " · 👩 " + gStr
    };
  }
  function entriesSince(ts) { return entries.filter(function (e) { return e.ts >= ts; }); }
  function todayEntries() { return entries.filter(function (e) { return isSameDay(e.ts, Date.now()); }); }

  // ---------- Rendering ----------
  function el(id) { return document.getElementById(id); }

  function saveTrash() { try { localStorage.setItem(TRASH_KEY, JSON.stringify(trash)); } catch (e) {} }
  function saveConflicts() { try { localStorage.setItem(CONFLICT_KEY, JSON.stringify(conflicts.slice(-25))); } catch (e) {} }

  function commonStreak() {
    var days = {};
    CAT_ORDER.forEach(function (cat) {
      catStore[cat].entries.forEach(function (e) { if (isShared(e.who)) days[dayKey(e.ts)] = true; });
    });
    var run = 0;
    for (var t = startOfDay(Date.now()).getTime(); days[dayKey(t)]; t -= 86400000) run++;
    return run;
  }

  function renderSession() {}

  function renderWeeklySummary() {
    var box = el("weeklySummary"); if (!box) return;
    var start = startOfWeek(Date.now()).getTime();
    var previous = start - 7 * 86400000;
    var nowCount = entries.filter(function (e) { return e.ts >= start; }).length;
    var prevCount = entries.filter(function (e) { return e.ts >= previous && e.ts < start; }).length;
    var delta = nowCount - prevCount;
    box.innerHTML = '<div><span class="eyebrow">Haftalık özet</span><strong>' + nowCount + ' ' + CATS[activeCat].unitPlural + '</strong><p>' + (delta === 0 ? 'Geçen haftayla aynı' : 'Geçen haftadan ' + Math.abs(delta) + (delta > 0 ? ' fazla' : ' az')) + '</p></div><div class="streak-pill">🔥 Ortak seri ' + commonStreak() + ' gün</div>';
  }

  function periodRange() {
    var now = Date.now(), start, end = now, days;
    if (comparisonPeriod === "today") { start = startOfDay(now).getTime(); days = 1; }
    else if (comparisonPeriod === "custom") {
      var from = /** @type {HTMLInputElement} */ (el("periodFrom")), to = /** @type {HTMLInputElement} */ (el("periodTo"));
      start = from && from.value ? new Date(from.value + "T04:00:00").getTime() : startOfDay(now).getTime() - 6 * 86400000;
      end = to && to.value ? new Date(to.value + "T04:00:00").getTime() + 86400000 - 1 : now;
      days = Math.max(1, Math.ceil((end - start) / 86400000));
    } else { days = Number(comparisonPeriod) || 7; start = startOfDay(now).getTime() - (days - 1) * 86400000; }
    return { start: start, end: end, span: Math.max(86400000, end - start), days: days };
  }

  function renderPeriodComparison() {
    var card = el("periodCompareCard"); if (!card) return;
    var r = periodRange();
    var current = entries.filter(function (e) { return e.ts >= r.start && e.ts <= r.end; });
    var previous = entries.filter(function (e) { return e.ts >= r.start - r.span && e.ts < r.start; });
    var c = countWho(current), p = countWho(previous), diff = current.length - previous.length;
    card.innerHTML = '<div><span class="eyebrow">Seçili dönem</span><strong>' + current.length + '</strong><small>' + c.utku + ' Utku · ' + c.gozde + ' Gözde · ' + (c.both + c.hepberaber) + ' ortak</small></div><div class="period-delta ' + (diff <= 0 ? 'good' : 'warn') + '">' + (diff === 0 ? 'Önceki dönemle aynı' : 'Önceki dönemden ' + Math.abs(diff) + (diff > 0 ? ' fazla' : ' az')) + '<small>Önceki: ' + previous.length + '</small></div>';
  }

  function renderTrash() {
    var list = el("trashList"), count = el("trashCount");
    if (count) count.textContent = String(trash.length);
    if (!list) return;
    list.innerHTML = "";
    if (!trash.length) { list.innerHTML = '<p class="set-note">Çöp kutusu boş.</p>'; return; }
    trash.slice().reverse().forEach(function (item) {
      var row = document.createElement("div"); row.className = "trash-row";
      var text = document.createElement("span");
      text.textContent = CATS[item.cat].label + " · " + WHO[item.row.who].label + " · " + new Date(item.row.ts).toLocaleString("tr-TR");
      var btn = document.createElement("button"); btn.className = "ghost-btn small"; btn.textContent = "Geri al";
      btn.addEventListener("click", function () { restoreTrash(item); });
      row.appendChild(text); row.appendChild(btn); list.appendChild(row);
    });
  }

  function renderSyncCenter() {
    var box = el("syncCenter"); if (!box) return;
    var rows = CAT_ORDER.map(function (cat) { return '<div><span>' + CATS[cat].emoji + ' ' + CATS[cat].label + '</span><b>' + catStore[cat].outbox.length + ' bekliyor</b></div>'; }).join("");
    var conflictHtml = conflicts.length ? '<p class="set-note">Son çakışmalar (yerel değişiklik korundu): ' + conflicts.slice(-3).map(function (c) { return CATS[c.cat].label + ' / ' + new Date(c.at).toLocaleString("tr-TR"); }).join(' · ') + '</p>' : '<p class="set-note">Kaydedilmiş çakışma yok.</p>';
    box.innerHTML = rows + '<p class="set-note">Son başarılı eşitleme: ' + (lastSyncAt ? new Date(lastSyncAt).toLocaleString("tr-TR") : 'henüz yok') + '</p>' + conflictHtml;
  }

  function renderBackupReminder() {
    var box = el("backupReminder"); if (!box) return;
    var last = Number(localStorage.getItem(BACKUP_KEY) || 0);
    box.classList.toggle("hidden", Date.now() - last < 7 * 86400000);
  }

  function render() {
    renderToday();
    renderLimit();
    renderStats();
    renderSince();
    renderBadges();
    renderRecords();
    renderInsights();
    renderHistory();
    renderPortalSummaries();
    renderSession();
    renderWeeklySummary();
    renderPeriodComparison();
    renderTrash();
    renderSyncCenter();
    renderBackupReminder();
    if (el("setCount")) el("setCount").textContent = String(entries.length);
    if (el("profileSub")) {
      var days = entries.length ? Math.round((startOfDay(Date.now()).getTime() - startOfDay(entries[0].ts).getTime()) / 86400000) + 1 : 0;
      el("profileSub").textContent = entries.length + " kayıt · " + days + " gün takip";
    }
  }



  // ---------- Arc UI Motion Helpers ----------
  function updateNumberWithRoll(elem, newNum) {
    if (!elem) return;
    var str = String(newNum);
    if (elem.textContent !== str) {
      elem.textContent = str;
      elem.classList.remove("num-roll-animate");
      void elem.offsetWidth; // Force reflow
      elem.classList.add("num-roll-animate");
    }
  }

  function renderSparkline(svgId, vals, strokeColor) {
    var svg = el(svgId);
    if (!svg || !vals || vals.length < 2) return;
    var max = Math.max(1, Math.max.apply(null, vals));
    var w = 100, h = 24;
    var pts = [];
    for (var i = 0; i < vals.length; i++) {
      var x = Math.round((i / (vals.length - 1)) * w);
      var y = Math.round(h - 3 - ((vals[i] / max) * (h - 6)));
      pts.push(x + "," + y);
    }
    var lineD = "M " + pts.join(" L ");
    var areaD = lineD + " L " + w + "," + h + " L 0," + h + " Z";
    var color = strokeColor || "var(--accent)";
    var gradId = "sg_" + svgId;
    svg.innerHTML =
      '<defs>' +
        '<linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.38"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.0"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="' + areaD + '" fill="url(#' + gradId + ')"/>' +
      '<path d="' + lineD + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function renderToday() {
    var tEnts = todayEntries();
    var t = countWho(tEnts);
    var tk = countKinds(tEnts);
    var uTotal = t.utku + t.both + t.hepberaber;
    var gTotal = t.gozde + t.both + t.hepberaber;
    var bothTotal = t.both;
    var hepTotal = t.hepberaber;

    var elUtku = el("todayUtku");
    if (elUtku) {
      updateNumberWithRoll(elUtku, uTotal);
      var pU = elUtku.closest(".duo-row");
      if (pU) pU.classList.toggle("zero", uTotal === 0);
    }
    var elGozde = el("todayGozde");
    if (elGozde) {
      updateNumberWithRoll(elGozde, gTotal);
      var pG = elGozde.closest(".duo-row");
      if (pG) pG.classList.toggle("zero", gTotal === 0);
    }
    var elBoth = el("todayBoth");
    if (elBoth) {
      updateNumberWithRoll(elBoth, bothTotal);
      var pB = elBoth.closest(".duo-row");
      if (pB) pB.classList.toggle("zero", bothTotal === 0);
    }
    var elHep = el("todayHepberaber");
    if (elHep) {
      updateNumberWithRoll(elHep, hepTotal);
      var pH = elHep.closest(".duo-row");
      if (pH) pH.classList.toggle("zero", hepTotal === 0);
    }
    updateNumberWithRoll(el("todayTotal"), t.total);

    // Tarih çipi mantıksal günü gösterir; 04:00 öncesi 🌙 ile "gece devam ediyor"
    var now = new Date();
    var dayRef = logicalDate(now);
    if (el("todayDate")) {
      el("todayDate").textContent =
        ("0" + dayRef.getDate()).slice(-2) + "." + ("0" + (dayRef.getMonth() + 1)).slice(-2) + "." + dayRef.getFullYear() +
        (now.getHours() < DAY_START_HOUR ? " 🌙" : "");
    }

    // Dün bu saate kadar içilenle kıyasla: azsa yeşil, fazlaysa kırmızı rozet
    var yStart = startOfDay(now).getTime() - 86400000;
    var yCut = now.getTime() - 86400000;
    var ySame = entries.filter(function (e) { return e.ts >= yStart && e.ts <= yCut; }).length;
    var trend = el("todayTrend");
    if (trend) {
      var diff = t.total - ySame;
      trend.classList.remove("up", "down");
      if (diff > 0) { trend.classList.add("up"); trend.textContent = "▲ " + diff; }
      else if (diff < 0) { trend.classList.add("down"); trend.textContent = "▼ " + (-diff); }
      else { trend.textContent = "＝"; }
    }

    var elSigo = el("todayKindSigo");
    if (elSigo) elSigo.textContent = "🚬 " + tk.sigo + " sigo";
    var elBong = el("todayKindBong");
    if (elBong) elBong.textContent = "🫧 " + tk.bong + " bong";
    var elComp = el("todayCompareText");
    if (elComp) {
      var tGaps = calcIntraDayGaps(tEnts);
      var bestTodayGap = tGaps.length ? Math.max.apply(null, tGaps) : 0;
      elComp.textContent = "Dün bu saatte " + ySame + (bestTodayGap > 0 ? (" · 🧘 En uzun: " + (fmtGap(bestTodayGap) || "")) : "");
    }

    var catInfo = CATS.sigo;
    var oldHeroSub = el("todayHeroSub");
    if (oldHeroSub) {
      oldHeroSub.textContent = "toplam " + catInfo.unit + " (" + tk.sigo + " sigo · " + tk.bong + " bong) · dün bu saatte " + ySame;
    }

    renderTodayFlow();

    var lastLbl = el("lastRowLabel");
    if (lastLbl) lastLbl.textContent = "⏱️ Son " + catInfo.unit + ":";

    var lastSmoke = el("lastSmoke");
    if (lastSmoke) {
      lastSmoke.innerHTML = "";
      if (entries.length) {
        var last = entries[entries.length - 1];
        lastSmoke.appendChild(makeAvatar(last.who, "avatar-sm"));
        var extraText = " (" + (KINDS[entryKind(last)] || KINDS.sigo).emoji + " " + (KINDS[entryKind(last)] || KINDS.sigo).label + ")";
        lastSmoke.appendChild(document.createTextNode(" " + WHO[last.who].label + extraText + " · " + formatTime(last.ts) + " · " + relativeTime(last.ts)));
      } else {
        lastSmoke.textContent = "Henüz kayıt yok";
      }
    }
  }

  function renderPortalSummaries() {
    var now = Date.now();
    var allEntries = [];
    CAT_ORDER.forEach(function (cat) {
      if (!catStore[cat]) return;
      allEntries = allEntries.concat(catStore[cat].entries.map(function(e) { e._cat = cat; return e; }));
      var todayEnts = catStore[cat].entries.filter(function (e) { return isSameDay(e.ts, now); });
      var todayCount = todayEnts.length;
      var elCount = el("portal" + cat.charAt(0).toUpperCase() + cat.slice(1) + "Count");
      if (elCount) {
        elCount.textContent = String(todayCount);
      }
      var cWho = countWho(todayEnts);
      var elU = el("portalUtkuCount");
      if (elU) elU.textContent = String(cWho.utku + cWho.both + cWho.hepberaber);
      var elG = el("portalGozdeCount");
      if (elG) elG.textContent = String(cWho.gozde + cWho.both + cWho.hepberaber);
      var elB = el("portalBothCount");
      if (elB) elB.textContent = String(cWho.both);
    });

    var pDuel = el("portalDuel");
    var pDuelText = el("portalDuelText");
    if (pDuel && pDuelText && catStore.sigo) {
      var wStart = startOfWeek(now).getTime();
      var wSigo = catStore.sigo.entries.filter(function (e) { return e.ts >= wStart; });
      var wC = countWho(wSigo);
      var wU = wC.utku + wC.both + wC.hepberaber;
      var wG = wC.gozde + wC.both + wC.hepberaber;
      if (wU > wG) {
        pDuelText.innerHTML = "Sigo'da <b>Utku</b> (" + wU + ") önde gidiyor!";
      } else if (wG > wU) {
        pDuelText.innerHTML = "Sigo'da <b>Gözde</b> (" + wG + ") önde gidiyor!";
      } else {
        pDuelText.innerHTML = "Sigo'da bu hafta <b>Berabere!</b> (" + wU + " - " + wG + ")";
      }
      pDuel.classList.remove("hidden");
    }

    var plaTime = el("portalLastAction").querySelector(".pla-time");
    var plaDesc = el("portalLastAction").querySelector(".pla-desc");
    if (allEntries.length > 0) {
      allEntries.sort(function(a, b) { return b.ts - a.ts; });
      var last = allEntries[0];
      plaTime.textContent = formatTime(last.ts);
      plaDesc.innerHTML = "<b>" + WHO[last.who].label + "</b> az önce bir Sigo yaktı (" + relativeTime(last.ts) + ")";
    } else {
      plaTime.textContent = "--:--";
      plaDesc.textContent = "Henüz bir aktivite yok.";
    }
  }

  // Günün akışı: mantıksal gün şeridi (04:00 → ertesi 04:00) üzerinde her sigo
  // kişi renginde bir nokta, ince çizgi şu anı gösterir (dakikada bir yenilenir)
  function renderTodayFlow() {
    var track = el("todayFlow");
    if (!track) return;
    track.innerHTML = "";
    var dayStart = startOfDay(Date.now()).getTime();
    var tList = todayEntries().slice().sort(function (a, b) { return a.ts - b.ts; });
    if (tList.length >= 2) {
      var bestI = 1, bestG = tList[1].ts - tList[0].ts;
      for (var fi = 2; fi < tList.length; fi++) {
        var fg = tList[fi].ts - tList[fi - 1].ts;
        if (fg > bestG) { bestG = fg; bestI = fi; }
      }
      if (bestG > 0) {
        var p1 = Math.min(100, Math.max(0, (tList[bestI - 1].ts - dayStart) / 86400000 * 100));
        var p2 = Math.min(100, Math.max(0, (tList[bestI].ts - dayStart) / 86400000 * 100));
        if (p2 > p1) {
          var bridge = document.createElement("span");
          bridge.className = "flow-bridge";
          bridge.style.left = p1 + "%";
          bridge.style.width = (p2 - p1) + "%";
          bridge.title = "🧘 En uzun mola: " + (fmtGap(bestG) || "");
          track.appendChild(bridge);
        }
      }
    }
    tList.forEach(function (e) {
      var dot = document.createElement("span");
      dot.className = "flow-dot " + WHO[e.who].cls;
      dot.style.left = Math.min(100, Math.max(0, (e.ts - dayStart) / 86400000 * 100)) + "%";
      dot.title = WHO[e.who].label + " · " + formatTime(e.ts);
      track.appendChild(dot);
    });
    var tick = document.createElement("span");
    tick.className = "flow-now";
    tick.style.left = Math.min(100, (Date.now() - dayStart) / 86400000 * 100) + "%";
    track.appendChild(tick);
  }

  function breakdownText(c) {
    var s = "🧔 " + (c.utku + c.both + c.hepberaber) + " · 👩 " + (c.gozde + c.both + c.hepberaber) + " · 👩‍❤️‍👨 " + c.both;
    if (c.hepberaber) s += " · 🎉 " + c.hepberaber;
    return s;
  }

  // Küçük trend rozeti: bu dönem vs geçen dönem (az = iyi → düşüş yeşil)
  function setTrend(id, cur, prev) {
    var n = el(id); if (!n) return;
    n.className = "stat-trend";
    if (prev === 0 && cur === 0) { n.textContent = ""; return; }
    var d = cur - prev;
    if (d < 0) { n.classList.add("down"); n.textContent = "▼" + (-d); }
    else if (d > 0) { n.classList.add("up"); n.textContent = "▲" + d; }
    else { n.textContent = "="; }
  }

  function renderStatCards() {
    var list = scopedEntries();
    var showBreakdown = statsScope === "all";

    var wStart = startOfWeek(Date.now()).getTime();
    var week = countWho(list.filter(function (e) { return e.ts >= wStart; }));
    var lastWeek = list.filter(function (e) { return e.ts >= wStart - 7 * 86400000 && e.ts < wStart; }).length;
    el("weekTotal").textContent = String(week.total);
    el("weekBreakdown").textContent = showBreakdown ? (week.total ? breakdownText(week) : "—") : "";
    setTrend("weekTrend", week.total, lastWeek);

    var mStart = startOfMonth();
    var month = countWho(list.filter(function (e) { return e.ts >= mStart; }));
    var lastMonthN = list.filter(function (e) {
      var d = logicalDate(e.ts), md = logicalDate(mStart);
      var pm = md.getMonth() - 1, py = md.getFullYear();
      return d.getFullYear() === py + Math.floor(pm / 12) && d.getMonth() === ((pm % 12) + 12) % 12;
    }).length;
    el("monthTotal").textContent = String(month.total);
    el("monthBreakdown").textContent = showBreakdown ? (month.total ? breakdownText(month) : "—") : "";
    setTrend("monthTrend", month.total, lastMonthN);

    var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
    var last7 = list.filter(function (e) { return e.ts >= sevenAgo; });
    var avg7Info = calcAverages(last7, 7);
    el("dailyAvg").textContent = showBreakdown ? (avg7Info.utkuStr + " / " + avg7Info.gozdeStr) : avg7Info.totalStr;
    el("dailyAvgSub").textContent = showBreakdown ? avg7Info.breakdown : "son 7 gün";

    var all = countWho(list);
    el("allTotal").textContent = String(all.total);
    el("allBreakdown").textContent = showBreakdown ? (all.total ? breakdownText(all) : "—") : "";

    // Arc UI: Mini Sparkline trend grafikleri
    var sparkDays = [];
    for (var sdi = 6; sdi >= 0; sdi--) {
      var sDate = startOfDay(Date.now());
      sDate.setDate(sDate.getDate() - sdi);
      var sKey = dayKey(sDate);
      var sDayCount = list.filter(function (e) { return dayKey(e.ts) === sKey; }).length;
      sparkDays.push(sDayCount);
    }
    renderSparkline("sparkWeek", sparkDays, "var(--accent)");
    renderSparkline("sparkAvg", sparkDays, "var(--accent)");

  }

  // ⏱️ Sigara arası süre analizi (Bugün, Son 7 gün, En kısa/uzun aralıklar)
  function renderIntervalStats() {
    var todayAvgEl = el("intervalTodayAvg");
    if (!todayAvgEl) return;

    var scoped = scopedEntries();

    function calcDayGaps(list) {
      var byD = {};
      list.forEach(function (e) {
        var k = dayKey(e.ts);
        if (!byD[k]) byD[k] = [];
        byD[k].push(e);
      });
      var gaps = [];
      Object.keys(byD).forEach(function (k) {
        var dayList = byD[k];
        for (var i = 1; i < dayList.length; i++) {
          var g = dayList[i].ts - dayList[i - 1].ts;
          if (g > 0) gaps.push(g);
        }
      });
      return gaps;
    }

    function fmtIntDur(ms) {
      if (!ms || ms <= 0 || !isFinite(ms)) return "—";
      var min = Math.round(ms / 60000);
      if (min < 60) return min + " dk";
      var hr = Math.floor(min / 60);
      var rem = min % 60;
      return rem > 0 ? (hr + " sa " + rem + " dk") : (hr + " sa");
    }

    // Bugünün gün içi aralıkları
    var todayKeyStr = dayKey(Date.now());
    var todayList = scoped.filter(function (e) { return dayKey(e.ts) === todayKeyStr; });
    var todayGaps = [];
    for (var i = 1; i < todayList.length; i++) {
      var g = todayList[i].ts - todayList[i - 1].ts;
      if (g > 0) todayGaps.push(g);
    }

    if (todayGaps.length) {
      var tSum = todayGaps.reduce(function (a, b) { return a + b; }, 0);
      todayAvgEl.textContent = fmtIntDur(tSum / todayGaps.length);
      var sub = el("intervalTodaySub");
      if (sub) sub.textContent = todayGaps.length + " aralık ölçüldü";
    } else {
      todayAvgEl.textContent = "—";
      var sub = el("intervalTodaySub");
      if (sub) sub.textContent = todayList.length ? "tek sigo (ara yok)" : "henüz kayıt yok";
    }

    // Son 7 günün gün içi ortalaması
    var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
    var last7List = scoped.filter(function (e) { return e.ts >= sevenAgo; });
    var weekGaps = calcDayGaps(last7List);
    var weekAvgEl = el("intervalWeekAvg");
    if (weekAvgEl) {
      if (weekGaps.length) {
        var wSum = weekGaps.reduce(function (a, b) { return a + b; }, 0);
        weekAvgEl.textContent = fmtIntDur(wSum / weekGaps.length);
        var wsub = el("intervalWeekSub");
        if (wsub) wsub.textContent = "haftalık tempo (" + weekGaps.length + " ara)";
        renderSparkline("sparkInterval", weekGaps.map(function(g){ return Math.round(g / 60000); }), "var(--accent)");
      } else {
        weekAvgEl.textContent = "—";
        var wsub = el("intervalWeekSub");
        if (wsub) wsub.textContent = "yeterli veri yok";
      }
    }
    if (todayGaps.length >= 2) {
      renderSparkline("sparkTodayInt", todayGaps.map(function(g){ return Math.round(g / 60000); }), "#22c39a");
    }

    // Gün içi en kısa ve en uzun aralıklar
    var allGaps = calcDayGaps(scoped);
    var minEl = el("intervalMin");
    var maxEl = el("intervalMax");
    if (minEl && maxEl) {
      if (allGaps.length) {
        var minG = Math.min.apply(null, allGaps);
        var maxG = Math.max.apply(null, allGaps);
        minEl.textContent = fmtIntDur(minG);
        var minSub = el("intervalMinSub");
        if (minSub) minSub.textContent = "en hızlı sigo";
        maxEl.textContent = fmtIntDur(maxG);
        var maxSub = el("intervalMaxSub");
        if (maxSub) maxSub.textContent = "en uzun gün içi mola";
      } else {
        minEl.textContent = "—";
        maxEl.textContent = "—";
      }
    }

    // v8.0 M3: Sigo vs Bong sonrası mola & Gündüz (04-20) vs Gece (20-04) mola analizi
    var afterSigoGaps = [], afterBongGaps = [], daytimeGaps = [], nighttimeGaps = [];
    var byDayDeep = {};
    scoped.forEach(function (e) {
      var k = dayKey(e.ts);
      if (!byDayDeep[k]) byDayDeep[k] = [];
      byDayDeep[k].push(e);
    });
    Object.keys(byDayDeep).forEach(function (k) {
      var dl = byDayDeep[k].slice().sort(function (a, b) { return a.ts - b.ts; });
      for (var di = 1; di < dl.length; di++) {
        var prevE = dl[di - 1], curE = dl[di];
        var gp = curE.ts - prevE.ts;
        if (gp <= 0) continue;
        if (entryKind(prevE) === "bong") afterBongGaps.push(gp);
        else afterSigoGaps.push(gp);
        var hr = new Date(curE.ts).getHours();
        if (hr >= 4 && hr < 20) daytimeGaps.push(gp);
        else nighttimeGaps.push(gp);
      }
    });
    var avgGapFmt = function (arr) {
      return arr.length ? fmtIntDur(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length) : "—";
    };
    if (el("intAfterSigo")) el("intAfterSigo").textContent = avgGapFmt(afterSigoGaps);
    if (el("intAfterBong")) el("intAfterBong").textContent = avgGapFmt(afterBongGaps);
    if (el("intDayPace")) el("intDayPace").textContent = avgGapFmt(daytimeGaps);
    if (el("intNightPace")) el("intNightPace").textContent = avgGapFmt(nighttimeGaps);

    // Detay satırı: kişi bazlı kırılım
    var detailEl = el("intervalDetail");
    if (detailEl) {
      if (statsScope === "all") {
        var uList = entries.filter(function (e) { return (e.ts >= EPOCH_TS) && (e.who === "utku" || isShared(e.who)); });
        var gList = entries.filter(function (e) { return (e.ts >= EPOCH_TS) && (e.who === "gozde" || isShared(e.who)); });
        var uGaps = calcDayGaps(uList.filter(function (e) { return e.ts >= sevenAgo; }));
        var gGaps = calcDayGaps(gList.filter(function (e) { return e.ts >= sevenAgo; }));
        var uAvgStr = uGaps.length ? fmtIntDur(uGaps.reduce(function(a,b){return a+b;},0)/uGaps.length) : "—";
        var gAvgStr = gGaps.length ? fmtIntDur(gGaps.reduce(function(a,b){return a+b;},0)/gGaps.length) : "—";
        detailEl.innerHTML = '<span class="int-tag">7 Günlük Tempo:</span> 🧔 Utku: <b>' + uAvgStr + '</b> · 👩 Gözde: <b>' + gAvgStr + '</b>';
      } else {
        detailEl.textContent = WHO[statsScope] ? (WHO[statsScope].label + " için gün içi ortalama sigo aralıkları") : "";
      }
    }
  }

  function renderChart() {
    var chart = el("chart");
    if (!chart) return;
    chart.innerHTML = "";
    var scoped = scopedEntries();

    var days = [];
    var maxTotal = 1;
    for (var i = 6; i >= 0; i--) {
      var d = startOfDay(Date.now());
      d.setDate(d.getDate() - i);
      var key = dayKey(d);
      var dayList = scoped.filter(function (e) { return dayKey(e.ts) === key; });
      var c = countWho(dayList);
      if (c.total > maxTotal) maxTotal = c.total;
      days.push({
        date: d,
        counts: c,
        isToday: i === 0,
        label: i === 0 ? "Bugün" : DAY_NAMES[d.getDay()],
        fullLabel: i === 0 ? "Bugün" : ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"][d.getDay()]
      });
    }

    if (typeof d3 === "undefined") return; // Fallback if D3 fails to load

    var width = chart.clientWidth || 300;
    var height = 140;
    var margin = { top: 20, right: 0, bottom: 20, left: 0 };
    var innerWidth = width - margin.left - margin.right;
    var innerHeight = height - margin.top - margin.bottom;

    var svg = d3.select(chart).append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("preserveAspectRatio", "xMidYMid meet");

    var g = svg.append("g")
      .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    var x = d3.scaleBand()
      .range([0, innerWidth])
      .padding(0.4)
      .domain(days.map(function(d) { return d.label; }));

    var y = d3.scaleLinear()
      .range([innerHeight, 0])
      .domain([0, maxTotal]);

    var colorScale = {
      "utku": "var(--utku)",
      "gozde": "var(--gozde)",
      "both": "var(--both)",
      "hepberaber": "var(--hepberaber)"
    };

    var stack = d3.stack().keys(["utku", "gozde", "both", "hepberaber"]);
    var series = stack(days.map(function(d) { return Object.assign({}, d.counts, { label: d.label }); }));

    var tooltip = d3.select("#d3Tooltip");

    // X Axis Labels
    g.append("g")
      .attr("transform", "translate(0," + (innerHeight + 5) + ")")
      .selectAll("text")
      .data(days)
      .enter()
      .append("text")
      .attr("x", function(d) { return x(d.label) + x.bandwidth() / 2; })
      .attr("y", 0)
      .attr("dy", "0.71em")
      .attr("text-anchor", "middle")
      .style("font-size", "10px")
      .style("fill", function(d) { return d.isToday ? "var(--accent)" : "var(--muted)"; })
      .style("font-weight", function(d) { return d.isToday ? "700" : "400"; })
      .text(function(d) { return d.label; });

    // Bars
    var barGroups = g.selectAll("g.layer")
      .data(series)
      .enter()
      .append("g")
      .classed("layer", true)
      .style("fill", function(d) { return colorScale[d.key]; });

    barGroups.selectAll("rect")
      .data(function(d) { return d; })
      .enter()
      .append("rect")
      .attr("x", function(d) { return x(d.data.label); })
      .attr("width", x.bandwidth())
      .attr("y", innerHeight)
      .attr("height", 0)
      .attr("rx", 2)
      .transition()
      .duration(600)
      .ease(d3.easeCubicOut)
      .attr("y", function(d) { return y(d[1]); })
      .attr("height", function(d) { return Math.max(0, y(d[0]) - y(d[1])); })
      .attr("visibility", function(d) { return d[1] > d[0] ? "visible" : "hidden"; });

    // Total Labels on top of bars
    g.selectAll(".total-label")
      .data(days.filter(function(d) { return d.counts.total > 0; }))
      .enter()
      .append("text")
      .attr("class", "total-label")
      .attr("x", function(d) { return x(d.label) + x.bandwidth() / 2; })
      .attr("y", function(d) { return y(d.counts.total) - 4; })
      .attr("text-anchor", "middle")
      .style("font-size", "11px")
      .style("font-weight", "700")
      .style("fill", "var(--text)")
      .text(function(d) { return d.counts.total; });

    // Empty bars for 0 counts
    g.selectAll(".empty-bar")
      .data(days.filter(function(d) { return d.counts.total === 0; }))
      .enter()
      .append("rect")
      .attr("class", "empty-bar")
      .attr("x", function(d) { return x(d.label); })
      .attr("width", x.bandwidth())
      .attr("y", innerHeight - 3)
      .attr("height", 3)
      .attr("rx", 1.5)
      .style("fill", "var(--bg-elev-2)");

    // Invisible rects for tooltip interaction (full height for easier tapping)
    g.selectAll(".interaction-rect")
      .data(days)
      .enter()
      .append("rect")
      .attr("class", "interaction-rect")
      .attr("x", function(d) { return x(d.label) - x.paddingInner() * x.step() / 2; })
      .attr("width", x.step())
      .attr("y", 0)
      .attr("height", innerHeight)
      .style("fill", "transparent")
      .style("cursor", "pointer")
      .on("mouseover touchstart", function(event, d) {
        if (event.cancelable) event.preventDefault();
        var html = "<div class='d3-tooltip-title'>" + d.fullLabel + " (" + d.counts.total + " sigo)</div>";
        ["utku", "gozde", "both", "hepberaber"].forEach(function(key) {
          if (d.counts[key] > 0) {
            html += "<div class='d3-tooltip-row'>" +
                    "<span class='d3-tooltip-label'><i class='dot " + key + "-bg'></i>" + WHO[key].label + "</span>" +
                    "<span class='d3-tooltip-val'>" + d.counts[key] + "</span></div>";
          }
        });
        if (d.counts.total === 0) {
          html += "<div class='d3-tooltip-row'><span class='d3-tooltip-label'>Henüz içilmedi</span></div>";
        }
        tooltip.html(html);
        var bb = this.getBoundingClientRect();
        var tbb = tooltip.node().getBoundingClientRect();
        tooltip
          .style("left", (bb.left + bb.width / 2) + "px")
          .style("top", (bb.top - tbb.height - 5) + "px")
          .classed("visible", true);
      })
      .on("mouseout touchend", function(event) {
        tooltip.classed("visible", false);
      });
  }

  // 🔎 Bilgiler: metin listesi yerine görsel mini-pano
  //   1) haftalık düello mini-bar  2) öne çıkan içgörü  3) istatistik kutucukları
  function renderInsights() {
    var body = el("insightBody");
    if (!body) return;
    body.innerHTML = "";
    var all = countWho(entries);

    if (all.total === 0) {
      var empty = document.createElement("div");
      empty.className = "ins-empty";
      empty.innerHTML = '<span class="ins-empty-e">✨</span><span>Henüz veri yok. İlk sigoyu eklediğinde burada içgörüler belirir.</span>';
      body.appendChild(empty);
      return;
    }

    // --- Ortak veriler ---
    var utkuTotal = all.utku + all.both + all.hepberaber;
    var gozdeTotal = all.gozde + all.both + all.hepberaber;
    var pct = Math.round((all.both + all.hepberaber) / all.total * 100);
    var monthTotal = entriesSince(startOfMonth()).length;
    var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
    var avgInfo = calcAverages(entriesSince(sevenAgo), 7);
    var avg = avgInfo.total;
    var todayCount = todayEntries().length;

    var byDay = {};
    entries.forEach(function (e) { var k = dayKey(e.ts); byDay[k] = (byDay[k] || 0) + 1; });
    var maxDay = null, maxDayCount = 0;
    Object.keys(byDay).forEach(function (k) { if (byDay[k] > maxDayCount) { maxDayCount = byDay[k]; maxDay = k; } });

    var byDow = [0, 0, 0, 0, 0, 0, 0];
    entries.forEach(function (e) { byDow[logicalDate(e.ts).getDay()]++; });
    var maxDow = 0;
    for (var w = 1; w < 7; w++) if (byDow[w] > byDow[maxDow]) maxDow = w;
    var DOW_SHORT = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];

    // --- 1) Haftalık düello mini-bar ---
    var wk = weekTotals(0);
    if (wk.utku > 0 || wk.gozde > 0) {
      var wmax = Math.max(wk.utku, wk.gozde, 1);
      var leader = wk.utku === wk.gozde ? "" : (wk.utku < wk.gozde ? "utku" : "gozde");
      var duel = document.createElement("div");
      duel.className = "ins-duel";
      var dh = document.createElement("div");
      dh.className = "ins-duel-head";
      dh.innerHTML = "<span>⚔️ Bu hafta düello</span><span class=\"ins-duel-tip\">az içen önde</span>";
      duel.appendChild(dh);
      [{ who: "utku", val: wk.utku }, { who: "gozde", val: wk.gozde }].forEach(function (p) {
        var who = p.who, val = p.val;
        var row = document.createElement("div");
        row.className = "ins-duel-row";
        var av = makeAvatar(who, "avatar-sm");
        var track = document.createElement("div");
        track.className = "ins-bar";
        var fill = document.createElement("div");
        fill.className = "ins-bar-fill " + who + "-bg";
        fill.style.width = Math.round(val / wmax * 100) + "%";
        track.appendChild(fill);
        var num = document.createElement("span");
        num.className = "ins-bar-val";
        num.textContent = val + (leader === who ? " 🏆" : "");
        row.appendChild(av);
        row.appendChild(track);
        row.appendChild(num);
        duel.appendChild(row);
      });
      body.appendChild(duel);
    }

    // --- 2) Öne çıkan içgörü (duruma göre seçilir) ---
    var spot = null;
    var myOwner = settings.owner;
    var myToday = todayCount;
    var myAvg = avg;
    if (myOwner === "utku") {
      var tc1 = countWho(todayEntries());
      myToday = tc1.utku + tc1.both + tc1.hepberaber;
      myAvg = avgInfo.utku;
    } else if (myOwner === "gozde") {
      var tc2 = countWho(todayEntries());
      myToday = tc2.gozde + tc2.both + tc2.hepberaber;
      myAvg = avgInfo.gozde;
    }
    if (myToday > 0 && myAvg > 0 && myToday < myAvg) {
      spot = { tone: "good", e: "🌿", t: "Bugün ortalamanın altındasın (" + myToday + " < " + myAvg.toFixed(1) + ") — aferin!" };
    } else if (myToday > 0 && myAvg > 0 && myToday > myAvg) {
      spot = { tone: "warn", e: "⚠️", t: "Bugün ortalamanın üstündesin (" + myToday + " > " + myAvg.toFixed(1) + ")." };
    } else if (maxDay) {
      var parts = String(maxDay).split("-");
      var dd = ("0" + parts[2]).slice(-2) + "." + ("0" + parts[1]).slice(-2);
      spot = { tone: "neutral", e: "🔥", t: "En yoğun gün " + dd + " · " + maxDayCount + " sigo." };
    }
    if (spot) {
      var sEl = document.createElement("div");
      sEl.className = "ins-spot tone-" + spot.tone;
      sEl.innerHTML = '<span class="ins-spot-e">' + spot.e + '</span><span class="ins-spot-t"></span>';
      sEl.querySelector(".ins-spot-t").textContent = spot.t;
      body.appendChild(sEl);
    }

    // --- 3) İstatistik kutucukları ---
    var lead = utkuTotal === gozdeTotal
      ? { v: "berabere", l: "🤝 Toplam" }
      : { v: (utkuTotal > gozdeTotal ? "Utku" : "Gözde") + " +" + Math.abs(utkuTotal - gozdeTotal), l: "🏆 Lider" };
    var tiles = [
      { e: "📅", v: monthTotal, l: "Bu ay" },
      { e: "📊", v: avgInfo.utkuStr + " / " + avgInfo.gozdeStr, l: "Günlük ort." },
      { e: "🤝", v: "%" + pct, l: "Birlikte" },
      { e: "🗓️", v: DOW_SHORT[maxDow], l: "En sık gün" },
      { e: lead.l.split(" ")[0], v: lead.v, l: lead.l.split(" ")[1] },
      { e: "🚬", v: all.total, l: "Toplam" }
    ];
    var grid = document.createElement("div");
    grid.className = "ins-grid";
    tiles.forEach(function (t) {
      var tile = document.createElement("div");
      tile.className = "ins-tile";
      var e = document.createElement("span"); e.className = "ins-tile-e"; e.textContent = t.e;
      var v = document.createElement("span"); v.className = "ins-tile-v"; v.textContent = String(t.v);
      if (String(t.v).length > 6) v.style.fontSize = "13px";
      var l = document.createElement("span"); l.className = "ins-tile-l"; l.textContent = t.l;
      tile.appendChild(e); tile.appendChild(v); tile.appendChild(l);
      grid.appendChild(tile);
    });
    body.appendChild(grid);
  }

  function isPending(id) {
    for (var i = 0; i < outbox.length; i++) {
      if (outbox[i].type === "insert" && outbox[i].row && outbox[i].row.id === id) return true;
      if (outbox[i].type === "update" && outbox[i].id === id) return true;
    }
    return false;
  }

  // datetime-local girdisi için yerel "YYYY-MM-DDTHH:MM" biçimi
  function toLocalInput(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function dayLabel(ts) {
    var diff = Math.round((startOfDay(Date.now()).getTime() - startOfDay(ts).getTime()) / 86400000);
    if (diff === 0) return "Bugün";
    if (diff === 1) return "Dün";
    var d = logicalDate(ts); // 00:00-04:00 arası kayıtlar önceki günün başlığında
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"][d.getDay()];
  }

  function historyItem(e, list) {
    var pending = isPending(e.id);
    var row = document.createElement("div");
    row.className = "history-item who-" + e.who + (pending ? " is-pending" : "");

    var em = makeAvatar(e.who, "h-emoji");

    var main = document.createElement("div");
    main.className = "h-main";
    var who = document.createElement("div");
    who.className = "h-who";

    var whoTitle = document.createElement("span");
    whoTitle.className = "h-who-title";
    whoTitle.textContent = WHO[e.who].label + " içti";
    who.appendChild(whoTitle);

    var kInfo = KINDS[entryKind(e)] || KINDS.sigo;
    var kindBadge = document.createElement("span");
    kindBadge.className = "h-kind " + kInfo.cls;
    kindBadge.textContent = kInfo.emoji + " " + kInfo.label;
    who.appendChild(kindBadge);

    // Günün ilk sigarası değilse aralık rozetini üst satıra (who yanına) ekle
    var gapMs = entryPrevGap(e, historyFilter === "all" ? entries : (list || entries));
    var gapText = fmtGap(gapMs);
    if (gapText) {
      var gapChip = document.createElement("span");
      gapChip.className = "h-gap-chip";
      gapChip.textContent = "⏱️ " + gapText;
      who.appendChild(gapChip);
    }
    main.appendChild(who);

    var time = document.createElement("div");
    time.className = "h-time";
    time.textContent = formatTime(e.ts) + " · " + relativeTime(e.ts) + (pending ? " · ⏳ bekliyor" : "");
    main.appendChild(time);

    var openHint = document.createElement("span");
    openHint.className = "h-open";
    openHint.textContent = "Ayrıntı";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-label", WHO[e.who].label + " kaydını düzenle");
    function toggleEdit() {
      editingId = editingId === e.id ? null : e.id;
      renderHistory();
    }
    row.addEventListener("click", toggleEdit);
    row.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleEdit(); }
    });

    row.appendChild(em);
    row.appendChild(main);
    row.appendChild(openHint);
    return row;
  }

  // Düzenleme paneli: tür (sigo/bong) + kişi seçimi (4 çip) + etiket + tarih/saat + kaydet/vazgeç
  function historyEditPanel(e) {
    var panel = document.createElement("div");
    panel.className = "hist-edit";
    var selectedWho = e.who;
    var selectedKind = entryKind(e);
    var topControlSection = document.createElement("div");
    topControlSection.className = "hist-edit-who";

    Object.keys(KINDS).forEach(function (k) {
      var b = document.createElement("button");
      b.className = "hist-chip" + (k === selectedKind ? " active" : "");
      b.textContent = KINDS[k].emoji + " " + KINDS[k].label;
      b.addEventListener("click", function () {
        selectedKind = k;
        topControlSection.querySelectorAll(".hist-chip").forEach(function (c) { c.classList.toggle("active", c === b); });
      });
      topControlSection.appendChild(b);
    });

    var chips = document.createElement("div");
    chips.className = "hist-edit-who";
    var whoList = Object.keys(WHO);
    whoList.forEach(function (w) {
      var b = document.createElement("button");
      b.className = "hist-chip" + (w === selectedWho ? " active" : "");
      b.appendChild(makeAvatar(w, "avatar-tiny"));
      b.appendChild(document.createTextNode(" " + WHO[w].label));
      b.addEventListener("click", function () {
        selectedWho = w;
        chips.querySelectorAll(".hist-chip").forEach(function (c) { c.classList.toggle("active", c === b); });
      });
      chips.appendChild(b);
    });

    var timeRow = document.createElement("div");
    timeRow.className = "hist-edit-time";
    var input = document.createElement("input");
    input.type = "datetime-local";
    input.value = toLocalInput(e.ts);
    input.max = toLocalInput(Date.now());
    timeRow.appendChild(input);

    var btns = document.createElement("div");
    btns.className = "hist-edit-btns";
    var save = document.createElement("button");
    save.className = "ghost-btn small";
    save.textContent = "💾 Kaydet";
    save.addEventListener("click", function () {
      var ts = new Date(input.value).getTime();
      if (!input.value || isNaN(ts)) { alert("Geçerli bir tarih/saat seç."); return; }
      if (ts > Date.now()) { alert("Gelecekteki bir saat seçilemez."); return; }
      updateEntry(e.id, selectedWho, ts, selectedKind, e.tag);
    });
    var cancel = document.createElement("button");
    cancel.className = "ghost-btn small";
    cancel.textContent = "Vazgeç";
    cancel.addEventListener("click", function () { editingId = null; renderHistory(); });
    var remove = document.createElement("button");
    remove.className = "ghost-btn small danger";
    remove.textContent = "Kaydı sil";
    remove.addEventListener("click", function () { deleteEntry(e.id); });
    btns.appendChild(save);
    btns.appendChild(cancel);
    btns.appendChild(remove);

    if (topControlSection.childNodes.length > 0) panel.appendChild(topControlSection);
    panel.appendChild(chips);
    panel.appendChild(timeRow);
    panel.appendChild(btns);
    return panel;
  }

  function renderHistory() {
    var list = el("historyList");
    var empty = el("historyEmpty");
    list.innerHTML = "";
    el("historyCount").textContent = entries.length ? entries.length + " kayıt" : "";

    // Özet şeridi: toplam · bu hafta · günlük ortalama
    var sum = el("histSummary");
    if (sum) {
      if (!entries.length) { sum.innerHTML = ""; }
      else {
        var wk = entriesSince(startOfWeek(Date.now()).getTime()).length;
        var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
        var avgInfo = calcAverages(entriesSince(sevenAgo), 7);
        var td = todayEntries().length;
        sum.innerHTML =
          '<div class="hs-item"><span class="hs-v">' + td + '</span><span class="hs-l">bugün</span></div>' +
          '<div class="hs-item"><span class="hs-v">' + wk + '</span><span class="hs-l">bu hafta</span></div>' +
          '<div class="hs-item"><span class="hs-v" style="font-size:13px">' + avgInfo.utkuStr + ' / ' + avgInfo.gozdeStr + '</span><span class="hs-l">günlük ort.</span></div>' +
          '<div class="hs-item"><span class="hs-v">' + entries.length + '</span><span class="hs-l">toplam</span></div>';
      }
    }

    var filtered = entries.filter(function (e) {
      var whoMatch = historyFilter === "all" || e.who === historyFilter;
      var kindMatch = historyKind === "all" || entryKind(e) === historyKind;
      var searchMatch = true;
      if (historyQuery) {
        var kindLabel = activeCat === "sigo" && KINDS[entryKind(e)] ? KINDS[entryKind(e)].label : CATS[activeCat].label;
        var haystack = (WHO[e.who].label + " " + kindLabel + " " + dayLabel(e.ts) + " " + new Date(e.ts).toLocaleDateString("tr-TR")).toLocaleLowerCase("tr-TR");
        searchMatch = haystack.indexOf(historyQuery) !== -1;
      }
      var dateMatch = e.ts >= historyFromTs && e.ts <= historyToTs;
      return whoMatch && kindMatch && searchMatch && dateMatch;
    });
    el("historyCount").textContent = filtered.length ? filtered.length + " kayıt" : "";
    var moreBtn = el("historyMoreBtn");
    if (filtered.length === 0) {
      empty.classList.remove("hidden");
      empty.textContent = entries.length ? "Bu filtrede kayıt yok." : "Henüz kayıt yok. Sol alttaki + ile ekle 👆";
      if (moreBtn) moreBtn.classList.add("hidden");
      return;
    }
    empty.classList.add("hidden");

    var recent = filtered.slice(-historyVisible).reverse();
    if (moreBtn) {
      moreBtn.classList.toggle("hidden", filtered.length <= historyVisible);
      moreBtn.textContent = "Daha fazla göster · " + Math.min(30, filtered.length - historyVisible) + " kayıt";
    }
    var byKey = {}, groups = [];
    recent.forEach(function (e) {
      var k = dayKey(e.ts);
      if (!byKey[k]) { byKey[k] = { ts: e.ts, items: [] }; groups.push(byKey[k]); }
      byKey[k].items.push(e);
    });

    groups.forEach(function (g) {
      var head = document.createElement("div");
      head.className = "hist-day";
      var lbl = document.createElement("span");
      lbl.className = "hist-day-label";
      lbl.textContent = dayLabel(g.ts);
      // Gün başlığında kişi renkli mini noktalar (o gün kim içmiş)
      var dots = document.createElement("span");
      dots.className = "hist-day-dots";
      var dc = countWho(g.items);
      ["utku", "gozde", "both", "hepberaber"].forEach(function (w) {
        for (var n = 0; n < dc[w]; n++) {
          var dt = document.createElement("i");
          dt.className = "hd-dot " + WHO[w].cls;
          dots.appendChild(dt);
        }
      });
      var cnt = document.createElement("span");
      cnt.className = "hist-day-count";
      cnt.textContent = String(g.items.length);
      head.appendChild(lbl);
      head.appendChild(dots);
      var dayGaps = calcIntraDayGaps(g.items);
      if (dayGaps.length > 0) {
        var dayAvgMs = dayGaps.reduce(function (a, b) { return a + b; }, 0) / dayGaps.length;
        var paceSpan = document.createElement("span");
        paceSpan.className = "hist-day-pace";
        paceSpan.textContent = "⏱️ Ort. " + (fmtGap(dayAvgMs) || "");
        head.appendChild(paceSpan);
      }
      head.appendChild(cnt);
      list.appendChild(head);
      g.items.forEach(function (e) {
        list.appendChild(historyItem(e, filtered));
        if (editingId === e.id) list.appendChild(historyEditPanel(e));
      });
    });
  }

  // ---------- Extra analytics ----------
  var MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

  function pad2(n) { return ("0" + n).slice(-2); }

  function fmtDuration(ms) {
    if (ms < 0 || isNaN(ms)) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var hms = pad2(h) + ":" + pad2(m) + ":" + pad2(s);
    return d > 0 ? (d + "g " + hms) : hms;
  }

  function sinceData(who) {
    // Ortak veya hep beraber içilen sigo, Utku ve Gözde'nin de sayacını sıfırlar.
    var sub = entries.filter(function (e) {
      return (e.ts >= EPOCH_TS) && (e.who === who || ((who === "utku" || who === "gozde") && isShared(e.who)));
    });
    if (!sub.length) return null;
    var lastTs = sub[sub.length - 1].ts;
    var since = Date.now() - lastTs;
    var maxGap = 0;
    for (var i = 1; i < sub.length; i++) {
      var g = sub[i].ts - sub[i - 1].ts;
      if (g > maxGap) maxGap = g;
    }
    var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
    var recentGaps = calcIntraDayGaps(sub.filter(function (e) { return e.ts >= sevenAgo; }));
    if (recentGaps.length < 2) recentGaps = calcIntraDayGaps(sub);
    var avgGap = recentGaps.length
      ? (recentGaps.reduce(function (a, b) { return a + b; }, 0) / recentGaps.length)
      : 90 * 60000;
    var smokedToday = dayKey(lastTs) === dayKey(Date.now());
    return {
      since: since,
      record: Math.max(maxGap, since),
      avgGap: avgGap,
      smokedToday: smokedToday
    };
  }

  function renderSince() {
    if (!el("sinceUtku")) return;
    var head = el("sinceCardHead");
    if (head) {
      var catUnit = (CATS[activeCat] || CATS.sigo).unit;
      head.textContent = "Son " + catUnit + "dan beri";
    }
    var headChip = el("paceHeadChip");
    if (headChip) {
      var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
      var allRecentGaps = calcIntraDayGaps(entries.filter(function (e) { return e.ts >= Math.max(EPOCH_TS, sevenAgo); }));
      if (allRecentGaps.length) {
        var avgAll = allRecentGaps.reduce(function (a, b) { return a + b; }, 0) / allRecentGaps.length;
        headChip.textContent = "🎯 7G Ort: " + (fmtGap(avgAll) || "—");
      } else {
        headChip.textContent = "";
      }
    }
    var circ = 94.25;
    var ids = { utku: "Utku", gozde: "Gozde" };
    Object.keys(ids).forEach(function (who) {
      var sfx = ids[who];
      var t = el("since" + sfx);
      var r = el("rec" + sfx);
      var ring = el("paceRing" + sfx);
      var badge = el("paceBadge" + sfx);
      var d = sinceData(who);
      if (!d) {
        if (t) t.textContent = "—";
        if (r) r.textContent = "";
        if (badge) badge.textContent = "";
        return;
      }
      if (t) t.textContent = fmtDuration(d.since);
      if (r) r.textContent = "🏆 " + fmtDuration(d.record);
      if (ring && badge) {
        ring.style.strokeDasharray = String(circ);
        if (!d.smokedToday) {
          ring.style.strokeDashoffset = "0";
          ring.setAttribute("class", "pace-ring-fg calm");
          badge.className = "pace-badge calm";
          badge.textContent = "🌅 Yeni gün";
        } else {
          var ratio = Math.min(1, Math.max(0.05, d.since / d.avgGap));
          ring.style.strokeDashoffset = String(Math.round((1 - ratio) * circ * 10) / 10);
          if (d.since >= d.avgGap) {
            ring.setAttribute("class", "pace-ring-fg bonus");
            badge.className = "pace-badge bonus";
            badge.textContent = "✨ +" + (fmtGap(d.since - d.avgGap) || "1 dk");
          } else {
            ring.setAttribute("class", "pace-ring-fg charging");
            badge.className = "pace-badge charging";
            badge.textContent = "🎯 " + (fmtGap(d.avgGap - d.since) || "1 dk") + " kaldı";
          }
        }
      }
    });
  }

  function renderWeeklyComparison() {
    var chart = el("weeklyComparisonChart");
    if (!chart) return;
    chart.innerHTML = "";
    if (typeof d3 === "undefined") return;

    var scoped = scopedEntries(); // uses current filter, but we should use ALL entries and filter by who for comparison
    // Actually, comparison usually implies ignoring the current 'who' filter to show both.
    // Wait, if the user is looking at 'Utku' scope, showing Utku vs Gözde might be weird or intended.
    // Let's use the unfiltered global `entries` but filter by time/kind.
    var currentKind = statsKind || "all";
    var filtered = entries.filter(function(e) {
      if (currentKind !== "all" && e.kind !== currentKind) return false;
      return true;
    });

    var days = [];
    var maxTotal = 1;
    for (var i = 6; i >= 0; i--) {
      var d = startOfDay(Date.now());
      d.setDate(d.getDate() - i);
      var key = dayKey(d);
      var dayList = filtered.filter(function (e) { return dayKey(e.ts) === key; });
      var c = countWho(dayList);
      
      var uCount = (c.utku || 0) + (c.both || 0) + (c.hepberaber || 0);
      var gCount = (c.gozde || 0) + (c.both || 0) + (c.hepberaber || 0);
      if (uCount > maxTotal) maxTotal = uCount;
      if (gCount > maxTotal) maxTotal = gCount;
      
      days.push({
        date: d,
        label: i === 0 ? "Bugün" : DAY_NAMES[d.getDay()],
        fullLabel: i === 0 ? "Bugün" : ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"][d.getDay()],
        utku: uCount,
        gozde: gCount
      });
    }

    var width = chart.clientWidth || 300;
    var height = 140;
    var margin = { top: 20, right: 0, bottom: 20, left: 0 };
    var innerWidth = width - margin.left - margin.right;
    var innerHeight = height - margin.top - margin.bottom;

    var svg = d3.select(chart).append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("preserveAspectRatio", "xMidYMid meet");

    var g = svg.append("g")
      .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    var x0 = d3.scaleBand()
      .rangeRound([0, innerWidth])
      .paddingInner(0.2)
      .domain(days.map(function(d) { return d.label; }));

    var x1 = d3.scaleBand()
      .padding(0.1)
      .domain(["utku", "gozde"])
      .rangeRound([0, x0.bandwidth()]);

    var y = d3.scaleLinear()
      .rangeRound([innerHeight, 0])
      .domain([0, maxTotal]);

    var colors = {
      utku: "var(--utku)",
      gozde: "var(--gozde)"
    };

    var tooltip = d3.select("#d3Tooltip");
    var detail = el("comparisonDetail");
    if (detail) detail.textContent = "Çubuklara dokunarak sayıları gör 👆";

    // X Axis Labels
    g.append("g")
      .attr("transform", "translate(0," + (innerHeight + 5) + ")")
      .selectAll("text")
      .data(days)
      .enter()
      .append("text")
      .attr("x", function(d) { return x0(d.label) + x0.bandwidth() / 2; })
      .attr("y", 0)
      .attr("dy", "0.71em")
      .attr("text-anchor", "middle")
      .style("font-size", "10px")
      .style("fill", "var(--muted)")
      .text(function(d) { return d.label; });

    // Day Groups
    var dayGroup = g.selectAll(".day-group")
      .data(days)
      .enter().append("g")
      .attr("class", "day-group")
      .attr("transform", function(d) { return "translate(" + x0(d.label) + ",0)"; });

    // Utku bars
    dayGroup.append("rect")
      .attr("class", "bar-utku")
      .attr("x", function(d) { return x1("utku"); })
      .attr("width", x1.bandwidth())
      .attr("rx", 3)
      .style("fill", colors.utku)
      .attr("y", innerHeight)
      .attr("height", 0)
      .transition()
      .duration(600)
      .ease(d3.easeCubicOut)
      .attr("y", function(d) { return d.utku === 0 ? innerHeight - 2 : y(d.utku); })
      .attr("height", function(d) { return d.utku === 0 ? 2 : Math.max(4, innerHeight - y(d.utku)); });

    // Gozde bars
    dayGroup.append("rect")
      .attr("class", "bar-gozde")
      .attr("x", function(d) { return x1("gozde"); })
      .attr("width", x1.bandwidth())
      .attr("rx", 3)
      .style("fill", colors.gozde)
      .attr("y", innerHeight)
      .attr("height", 0)
      .transition()
      .duration(600)
      .ease(d3.easeCubicOut)
      .attr("y", function(d) { return d.gozde === 0 ? innerHeight - 2 : y(d.gozde); })
      .attr("height", function(d) { return d.gozde === 0 ? 2 : Math.max(4, innerHeight - y(d.gozde)); });

    // Interaction overlays
    dayGroup.append("rect")
      .attr("class", "interaction-rect")
      .attr("x", 0)
      .attr("width", x0.bandwidth())
      .attr("y", 0)
      .attr("height", innerHeight)
      .style("fill", "transparent")
      .on("mouseover touchstart", function(event, d) {
        if (detail) {
          detail.innerHTML = '<strong>' + d.fullLabel + '</strong>: ' +
            '<span style="color:var(--utku)">' + d.utku + ' Utku</span> - ' +
            '<span style="color:var(--gozde)">' + d.gozde + ' Gözde</span>';
        }
        tooltip.html('<div class="d3-tooltip-title">' + d.fullLabel + '</div>' +
                     '<div class="d3-tooltip-row"><span class="d3-tooltip-label"><i class="dot" style="background:var(--utku)"></i>Utku:</span><span class="d3-tooltip-val">' + d.utku + '</span></div>' +
                     '<div class="d3-tooltip-row"><span class="d3-tooltip-label"><i class="dot" style="background:var(--gozde)"></i>Gözde:</span><span class="d3-tooltip-val">' + d.gozde + '</span></div>')
               .classed("visible", true);
        d3.select(this.parentNode).selectAll("rect:not(.interaction-rect)").style("filter", "brightness(1.2)");
      })
      .on("mousemove touchmove", function(event) {
        tooltip.style("left", (event.pageX) + "px")
               .style("top", (event.pageY - 40) + "px");
      })
      .on("mouseout touchend", function(event) {
        if (detail) detail.textContent = "Çubuklara dokunarak sayıları gör 👆";
        tooltip.classed("visible", false);
        d3.select(this.parentNode).selectAll("rect:not(.interaction-rect)").style("filter", "none");
      });
  }

  function renderTod() {
    var chart = el("todChart");
    if (!chart) return;
    var list = scopedEntries();
    var blocks = [
      { id: "sabah", label: "🌅 Sabah", hours: [6,7,8,9,10,11], count: 0 },
      { id: "ogle", label: "☀️ Öğle", hours: [12,13,14,15,16,17], count: 0 },
      { id: "aksam", label: "🌆 Akşam", hours: [18,19,20,21,22,23], count: 0 },
      { id: "gece", label: "🌙 Gece", hours: [0,1,2,3,4,5], count: 0 }
    ];
    
    list.forEach(function (e) { 
      var h = new Date(e.ts).getHours();
      for (var i=0; i<4; i++) {
        if (blocks[i].hours.indexOf(h) !== -1) {
          blocks[i].count++;
          break;
        }
      }
    });

    var maxCount = 0, peakBlock = blocks[0];
    blocks.forEach(function(b) {
      if (b.count > maxCount) {
        maxCount = b.count;
        peakBlock = b;
      }
    });
    
    if (el("todPeak")) {
      el("todPeak").textContent = peakBlock && list.length ? "en yoğun: " + peakBlock.label.split(" ")[1] : "";
    }
    
    var html = "";
    blocks.forEach(function(b) {
      var w = list.length > 0 ? Math.max(2, (b.count / maxCount) * 100) : 2;
      html += '<div class="tod-row">' +
              '<div class="tod-label" title="' + b.label.split(" ")[1] + '">' + b.label.split(" ")[0] + ' ' + b.label.split(" ")[1].substring(0,3) + '</div>' +
              '<div class="tod-track"><div class="tod-fill" style="width: 0%" data-w="' + w + '"></div></div>' +
              '<div class="tod-val">' + b.count + '</div>' +
              '</div>';
    });
    chart.innerHTML = html;
    
    setTimeout(function() {
      var fills = chart.querySelectorAll('.tod-fill');
      for(var i=0; i<fills.length; i++) {
        (/** @type {HTMLElement} */ (fills[i])).style.width = fills[i].getAttribute('data-w') + "%";
      }
    }, 50);
  }

  function renderShare() {
    var bar = el("shareBar");
    if (!bar) return;
    var card = el("shareCard");
    if (card) card.classList.toggle("hidden", statsScope !== "all");
    if (statsScope !== "all") return;
    var c = countWho(entries);
    var total = c.total || 1;
    var data = ["utku", "gozde", "both", "hepberaber"]
      .filter(function(w) { return c[w] > 0; })
      .map(function(w) { return { key: w, count: c[w] }; });

    if (typeof d3 !== "undefined") {
      var d3bar = d3.select(bar);
      var segs = d3bar.selectAll(".share-seg")
        .data(data, function(d) { return d.key; });

      segs.enter()
        .append("div")
        .attr("class", function(d) { return "share-seg " + WHO[d.key].cls; })
        .style("width", "0%")
        .attr("title", function(d) { return WHO[d.key].label + " " + d.count; })
        .merge(segs)
        .attr("title", function(d) { return WHO[d.key].label + " " + d.count; })
        .transition()
        .duration(600)
        .ease(d3.easeCubicOut)
        .style("width", function(d) { return (d.count / total * 100) + "%"; });

      segs.exit().transition().duration(600).style("width", "0%").remove();
    } else {
      bar.innerHTML = "";
      data.forEach(function (d) {
        if (d.count > 0) {
          var seg = document.createElement("div");
          seg.className = "share-seg " + WHO[d.key].cls;
          seg.style.width = (d.count / total * 100) + "%";
          seg.title = WHO[d.key].label + " " + d.count;
          bar.appendChild(seg);
        }
      });
    }
    var leg = el("shareLegend");
    leg.innerHTML = "";
    ["utku", "gozde", "both", "hepberaber"].forEach(function (w) {
      var pct = c.total ? Math.round(c[w] / c.total * 100) : 0;
      var item = document.createElement("span");
      item.className = "share-leg-item";
      var dot = document.createElement("i");
      dot.className = "dot " + WHO[w].cls;
      var txt = document.createElement("span");
      txt.textContent = WHO[w].label + " %" + pct;
      item.appendChild(dot);
      item.appendChild(makeAvatar(w, "avatar-tiny"));
      item.appendChild(txt);
      leg.appendChild(item);
    });
  }

  function renderDow() {
    var chart = el("dowChart");
    if (!chart) return;
    chart.innerHTML = "";
    var list = scopedEntries();
    var counts = [0, 0, 0, 0, 0, 0, 0]; // Pzt=0 .. Paz=6
    var listByDay = [[], [], [], [], [], [], []];
    list.forEach(function (e) {
      var idx = (logicalDate(e.ts).getDay() + 6) % 7;
      counts[idx]++;
      listByDay[idx].push(e);
    });
    var max = 1, peak = 0;
    for (var i = 0; i < 7; i++) { if (counts[i] > max) max = counts[i]; if (counts[i] > counts[peak]) peak = i; }
    var DOW_FULL = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
    var labels = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
    var detail = el("dowDetail");

    function selectDow(idx) {
      chart.querySelectorAll(".dow-col").forEach(function (c, k) {
        c.classList.toggle("sel", k === idx);
      });
      if (!detail) return;
      var dayName = DOW_FULL[idx];
      var cnt = counts[idx];
      if (cnt === 0) {
        detail.textContent = dayName + ": Sigo kaydı yok 🍃";
      } else {
        var wCounts = countWho(listByDay[idx]);
        detail.textContent = dayName + ": " + cnt + " sigo (" + breakdownText(wCounts) + ")";
      }
    }

    for (i = 0; i < 7; i++) {
      (function (dayIdx) {
        var col = document.createElement("div");
        col.className = "dow-col";
        col.setAttribute("tabindex", "0");
        col.setAttribute("role", "img");
        col.setAttribute("aria-label", DOW_FULL[dayIdx] + ": " + counts[dayIdx] + " sigo");
        var v = document.createElement("span");
        v.className = "dow-val";
        v.textContent = counts[dayIdx] ? String(counts[dayIdx]) : "";
        var bar = document.createElement("div");
        bar.className = "dow-bar" + (dayIdx === peak && counts[peak] > 0 ? " peak" : "");
        bar.style.height = (counts[dayIdx] === 0 ? 3 : Math.max(6, Math.round(counts[dayIdx] / max * 100))) + "%";
        if (counts[dayIdx] > 0) bar.style.opacity = (0.4 + 0.6 * (counts[dayIdx] / max)).toFixed(2);
        var l = document.createElement("span");
        l.className = "dow-lab";
        l.textContent = labels[dayIdx];
        col.appendChild(v); col.appendChild(bar); col.appendChild(l);
        col.addEventListener(TAP_EVT, function () { selectDow(dayIdx); });
        chart.appendChild(col);
      })(i);
    }
    el("dowPeak").textContent = list.length ? "en yoğun " + DOW_FULL[peak] : "";
  }

  function fmtCoarse(ms) {
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return d + "g " + h + "sa";
    if (h > 0) return h + "sa " + m + "dk";
    return m + "dk";
  }

  function renderRecords() {
    var node = el("recordList");
    if (!node) return;
    node.innerHTML = "";
    var list = scopedEntries();
    if (!list.length) {
      node.innerHTML = '<p class="empty">' + (statsScope === "all" ? "Henüz kayıt yok." : "Bu kişi için henüz kayıt yok.") + '</p>';
      return;
    }
    var byDay = {};
    list.forEach(function (e) { var k = dayKey(e.ts); byDay[k] = (byDay[k] || 0) + 1; });
    var maxDay = null, maxC = 0;
    Object.keys(byDay).forEach(function (k) { if (byDay[k] > maxC) { maxC = byDay[k]; maxDay = k; } });
    var parts = (maxDay || "").split("-");
    var dd = ("0" + parts[2]).slice(-2) + "." + ("0" + parts[1]).slice(-2) + "." + parts[0];

    var maxGap = 0;
    for (var i = 1; i < list.length; i++) { var g = list[i].ts - list[i - 1].ts; if (g > maxGap) maxGap = g; }
    maxGap = Math.max(maxGap, Date.now() - list[list.length - 1].ts);

    var firstDay = startOfDay(list[0].ts).getTime();
    var lastDay = startOfDay(list[list.length - 1].ts).getTime();
    var free = 0;
    for (var t = firstDay; t <= lastDay; t += 86400000) { if (!byDay[dayKey(t)]) free++; }
    var span = Math.round((lastDay - firstDay) / 86400000) + 1;

    // Mantıksal ay toplamı (bu görünüm/scope için)
    function scMonth(off) {
      var d = logicalDate(Date.now()), m = d.getMonth() + off, y = d.getFullYear();
      return list.filter(function (e) {
        var x = logicalDate(e.ts);
        return x.getFullYear() === y + Math.floor(m / 12) && x.getMonth() === ((m % 12) + 12) % 12;
      }).length;
    }
    // En uzun art arda içilen gün serisi
    var actRun = 0, actBest = 0;
    for (var t2 = firstDay; t2 <= lastDay; t2 += 86400000) {
      if (byDay[dayKey(t2)]) { actRun++; if (actRun > actBest) actBest = actRun; } else actRun = 0;
    }
    // Dün bu güne kadar günlük ortalama (tüm takip)
    var allAvgInfo = calcAverages(list, span);
    var dailyAvgAll = statsScope === "all" ? (allAvgInfo.utkuStr + " / " + allAvgInfo.gozdeStr) : allAvgInfo.totalStr;

    var tiles = [
      { e: "🔥", v: maxC, l: "gün rekoru", sub: dd.slice(0, 5) },
      { e: "⏱️", v: fmtCoarse(maxGap), l: "en uzun ara" },
      { e: "🔗", v: actBest, l: "gün üst üste" },
      { e: "🧊", v: longestCleanStreak(list), l: "gün sigosuz seri" },
      { e: "🧹", v: free, l: "toplam sigosuz gün" },
      { e: "📈", v: dailyAvgAll, l: "genel günlük ort." },
      { e: "📆", v: span, l: "gün takip" },
      { e: "🚬", v: list.length, l: "toplam kayıt" }
    ];
    tiles.forEach(function (it) {
      var tile = document.createElement("div");
      tile.className = "record-tile";
      tile.innerHTML = '<span class="rt-emoji">' + it.e + '</span>' +
        '<span class="rt-val"' + (String(it.v).length > 6 ? ' style="font-size:15px"' : '') + '>' + it.v + '</span>' +
        '<span class="rt-lbl">' + it.l + (it.sub ? ' <span class="rt-sub">' + it.sub + '</span>' : '') + '</span>';
      node.appendChild(tile);
    });
  }

  function renderCalendar() {
    var grid = el("calGrid");
    if (!grid) return;
    grid.innerHTML = "";
    var now = logicalDate(Date.now()); // takvim mantıksal güne göre
    var year = now.getFullYear(), month = now.getMonth();
    el("calTitle").textContent = MONTHS[month] + " " + year;

    var perDay = {};
    var dayEntriesMap = {};
    scopedEntries().forEach(function (e) {
      var d = logicalDate(e.ts);
      if (d.getFullYear() === year && d.getMonth() === month) {
        var dayNum = d.getDate();
        perDay[dayNum] = (perDay[dayNum] || 0) + 1;
        if (!dayEntriesMap[dayNum]) dayEntriesMap[dayNum] = [];
        dayEntriesMap[dayNum].push(e);
      }
    });

    var detail = el("calDetail");
    function selectDay(dayNum) {
      grid.querySelectorAll(".cal-cell").forEach(function (c) {
        c.classList.remove("selected");
      });
      var cellEl = grid.querySelector('.cal-cell[data-day="' + dayNum + '"]');
      if (cellEl) cellEl.classList.add("selected");
      if (!detail) return;
      var c = perDay[dayNum] || 0;
      if (c === 0) {
        detail.textContent = dayNum + " " + MONTHS[month] + ": Sigo kaydı yok 🍃";
      } else {
        var wCounts = countWho(dayEntriesMap[dayNum] || []);
        detail.textContent = dayNum + " " + MONTHS[month] + ": " + c + " sigo (" + breakdownText(wCounts) + ")";
      }
    }

    var offset = (new Date(year, month, 1).getDay() + 6) % 7; // Pzt=0
    var daysIn = new Date(year, month + 1, 0).getDate();
    for (var i = 0; i < offset; i++) {
      var blank = document.createElement("span");
      blank.className = "cal-cell blank";
      grid.appendChild(blank);
    }
    for (var day = 1; day <= daysIn; day++) {
      (function (dNum) {
        var c = perDay[dNum] || 0;
        var lvl = c === 0 ? 0 : c <= 2 ? 1 : c <= 4 ? 2 : c <= 6 ? 3 : 4;
        var cell = document.createElement("span");
        cell.className = "cal-cell l" + lvl + (dNum === now.getDate() ? " today" : "");
        cell.setAttribute("data-day", String(dNum));
        cell.title = dNum + " " + MONTHS[month] + " · " + c + " sigo";
        cell.textContent = String(dNum);
        cell.addEventListener(TAP_EVT, function () { selectDay(dNum); });
        grid.appendChild(cell);
      })(day);
    }
  }

  function weeklyDuelText() {
    var sow = startOfWeek(Date.now()).getTime();
    var c = countWho(entries.filter(function (e) { return e.ts >= sow; }));
    var u = c.utku + c.both + c.hepberaber, g = c.gozde + c.both + c.hepberaber;
    if (u === 0 && g === 0) return null;
    if (u < g) return "Bu hafta düello: Utku daha az içti (" + u + " - " + g + ").";
    if (g < u) return "Bu hafta düello: Gözde daha az içti (" + g + " - " + u + ").";
    return "Bu hafta düello: berabere (" + u + " - " + g + ").";
  }

  // Bir haftanın kişisel toplamları (offset 0=bu hafta, -1=geçen hafta)
  function weekTotals(offset) {
    var sow = startOfWeek(Date.now()).getTime() + offset * 7 * 86400000;
    var eow = sow + 7 * 86400000;
    var c = countWho(entries.filter(function (e) { return e.ts >= sow && e.ts < eow; }));
    return { utku: c.utku + c.both + c.hepberaber, gozde: c.gozde + c.both + c.hepberaber };
  }

  // ⚔️ Haftalık düello: az içen önde. İki çubuk + geçen hafta kazananı.
  function renderDuel() {
    var card = el("duelCard");
    if (!card) return;
    var w = weekTotals(0);
    if (w.utku === 0 && w.gozde === 0) {
      card.innerHTML = '<p class="empty">Bu hafta henüz kayıt yok. İlk içen geride başlar 😏</p>';
      return;
    }
    var leader = w.utku === w.gozde ? "" : (w.utku < w.gozde ? "utku" : "gozde");
    var max = Math.max(w.utku, w.gozde, 1);
    card.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "duel";
    ["utku", "gozde"].forEach(function (who) {
      var row = document.createElement("div");
      row.className = "duel-row";
      var name = document.createElement("span");
      name.className = "duel-name";
      name.appendChild(makeAvatar(who, "avatar-sm"));
      name.appendChild(document.createTextNode(" " + WHO[who].label));
      var track = document.createElement("div");
      track.className = "duel-track";
      var fill = document.createElement("div");
      fill.className = "duel-fill " + WHO[who].cls;
      fill.style.width = (w[who] / max * 100) + "%";
      track.appendChild(fill);
      var val = document.createElement("span");
      val.className = "duel-val";
      val.textContent = w[who] + (leader === who ? " 🏆" : "");
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(val);
      wrap.appendChild(row);
    });
    card.appendChild(wrap);

    var foot = document.createElement("div");
    foot.className = "duel-verdict";
    var msg = leader ? WHO[leader].label + " önde (az içen kazanır) 🏆" : "Şu an berabere 🤝";
    var lw = weekTotals(-1);
    if (lw.utku !== 0 || lw.gozde !== 0) {
      var lwWin = lw.utku === lw.gozde ? "berabere" : (lw.utku < lw.gozde ? WHO.utku.label : WHO.gozde.label) + " kazandı";
      msg += " · Geçen hafta: " + lwWin;
    }
    foot.textContent = msg;
    card.appendChild(foot);
  }

  // En uzun ardışık sigosuz gün serisi (takip aralığı içinde)
  function longestCleanStreak(list) {
    if (!list.length) return 0;
    var byDay = {};
    list.forEach(function (e) { byDay[dayKey(e.ts)] = true; });
    var first = startOfDay(list[0].ts).getTime(), last = startOfDay(list[list.length - 1].ts).getTime();
    var run = 0, best = 0;
    for (var t = first; t <= last; t += 86400000) {
      if (byDay[dayKey(t)]) run = 0; else { run++; if (run > best) best = run; }
    }
    return best;
  }

  // Mantıksal ay toplamı (offset 0=bu ay, -1=geçen ay)
  function monthCount(offset) {
    var d = logicalDate(Date.now());
    var y = d.getFullYear(), m = d.getMonth() + offset;
    return entries.filter(function (e) {
      var x = logicalDate(e.ts);
      return x.getFullYear() === y + Math.floor(m / 12) && x.getMonth() === ((m % 12) + 12) % 12;
    }).length;
  }

  // Kayıtlar arası en uzun tamamlanmış ara ve son kayıttan beri geçen süre.
  function longestGap() {
    var m = 0;
    for (var i = 1; i < entries.length; i++) { var g = entries[i].ts - entries[i - 1].ts; if (g > m) m = g; }
    return m;
  }
  function runningGap() { return entries.length ? Date.now() - entries[entries.length - 1].ts : 0; }

  // 🏅 Rozetler: veriden kazanılmış/kilitli başarımlar
  function computeBadges() {
    var c = countWho(entries);
    var total = entries.length;
    var lg = Math.max(longestGap(), runningGap());
    var clean = longestCleanStreak(entries);
    var together = c.both + c.hepberaber;
    var night = false, morning = false;
    entries.forEach(function (e) {
      var h = new Date(e.ts).getHours();
      if (h >= 0 && h < 4) night = true;
      if (h >= 4 && h < 8) morning = true;
    });
    var builtIn = [
      { e: "🌱", t: "İlk adım", d: "İlk sigo kaydı", on: total >= 1 },
      { e: "💯", t: "Yüzler", d: "100 kayıt", on: total >= 100 },
      { e: "🏆", t: "Beşyüz", d: "500 kayıt", on: total >= 500 },
      { e: "⏱️", t: "Yarım gün", d: "12 saat ara", on: lg >= 12 * 3600000 },
      { e: "🌗", t: "Tam gün", d: "24 saat ara", on: lg >= 24 * 3600000 },
      { e: "🧊", t: "Temiz seri", d: "3 gün sigosuz", on: clean >= 3 },
      { e: "💜", t: "Birlikte", d: "50 ortak/beraber", on: together >= 50 },
      { e: "🦉", t: "Gece kuşu", d: "00–04 arası", on: night },
      { e: "🌅", t: "Erkenci", d: "04–08 arası", on: morning }
    ];
    customBadges.forEach(function (b) {
      builtIn.push({ e: b.emoji || "⭐", t: b.name, d: b.target + " toplam kayıt", on: total >= b.target, custom: true });
    });
    return builtIn;
  }

  function renderBadges() {
    var grid = el("badgeGrid");
    if (!grid) return;
    grid.innerHTML = "";
    var list = computeBadges();
    var earned = 0;
    var detail = el("badgeDetail");
    list.forEach(function (b) {
      if (b.on) earned++;
      var cell = document.createElement("div");
      cell.className = "badge" + (b.on ? " got" : "");
      var ic = document.createElement("span");
      ic.className = "badge-emoji";
      ic.textContent = b.on ? b.e : "🔒";
      var nm = document.createElement("span");
      nm.className = "badge-name";
      nm.textContent = b.t;
      cell.appendChild(ic);
      cell.appendChild(nm);
      // Dokununca ne olduğunu detay satırında göster
      cell.addEventListener(TAP_EVT, function () {
        grid.querySelectorAll(".badge").forEach(function (x) { x.classList.remove("sel"); });
        cell.classList.add("sel");
        if (detail) {
          detail.innerHTML = '<span class="bd-emoji">' + b.e + '</span> <b>' + b.t + '</b> — ' + b.d +
            ' <span class="bd-status ' + (b.on ? "on" : "off") + '">' + (b.on ? "✓ kazanıldı" : "🔒 kilitli") + '</span>';
        }
      });
      grid.appendChild(cell);
    });
    var cnt = el("badgeCount");
    if (cnt) cnt.textContent = earned + "/" + list.length;
  }

  var RING_C = 2 * Math.PI * 42; // r=42

  function renderLimit() {
    var card = el("limitCard");
    if (!card) return;
    var lim = settings.dailyLimit;
    if (!lim || lim <= 0) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");

    var today = todayEntries().length;
    var pct = Math.min(1, today / lim);
    var ring = el("limitRing");
    ring.style.strokeDasharray = String(RING_C);
    ring.style.strokeDashoffset = String(RING_C * (1 - pct));

    var color = "#36d399";
    if (today > lim) color = "var(--danger)";
    else if (pct >= 0.8) color = "var(--accent)";
    ring.style.stroke = color;

    el("limitText").textContent = today + " / " + lim;
    el("limitSub").textContent = today > lim ? "limit aşıldı!" : (lim - today) + " kaldı";
    el("limitSub").style.color = today > lim ? "var(--danger)" : "var(--muted)";
  }

  // ---------- Status ----------
  var lastSyncAt = 0;
  // ---------- Actions ----------
  var renderDeferTimer = null;

  // Sabit (kaydırılamayan) öğelerde dokunma anında tepki; kaydırılabilir
  // listelerdeki butonlar bilerek click'te kalır (yanlış tetiklenmesin)
  var TAP_EVT = window.PointerEvent ? "pointerdown" : "click";

  function renderWrapped() {
    var grid = el("wrappedGrid");
    var letter = el("wrappedLetter");
    var title = el("wrappedTitle");
    if (!grid || !letter) return;

    var mStart = startOfMonth();
    var monthList = entriesSince(mStart);
    var now = new Date();
    var monthNames = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    var monthName = monthNames[now.getMonth()];
    if (title) title.textContent = monthName + " Ayı Özeti ✨";

    var catUnit = (CATS[activeCat] || CATS.sigo).unit;
    if (monthList.length === 0) {
      grid.innerHTML = '<div class="wrapped-item" style="grid-column: span 2;"><span class="wrapped-item-title">Henüz bu ay kayıt yok</span></div>';
      letter.textContent = "Bu ay henüz kaydınız yok. İlk " + catUnit + " kaydıyla özetiniz burada görünücek! 🌿";
      return;
    }

    var counts = countWho(monthList);
    var total = monthList.length;
    var sharedCount = counts.both + counts.hepberaber;
    var sharedPct = Math.round((sharedCount / total) * 100) || 0;

    var byHour = []; for (var h = 0; h < 24; h++) byHour[h] = 0;
    monthList.forEach(function (e) {
      byHour[logicalDate(e.ts).getHours()]++;
    });
    var peakH = 0; for (h = 1; h < 24; h++) if (byHour[h] > byHour[peakH]) peakH = h;
    var peakHStr = ("0" + peakH).slice(-2) + ":00 - " + ("0" + ((peakH + 1) % 24)).slice(-2) + ":00";

    var monthDayGaps = calcIntraDayGaps(monthList);
    var maxGap = monthDayGaps.length ? Math.max.apply(null, monthDayGaps) : 0;
    var avgGap = monthDayGaps.length ? (monthDayGaps.reduce(function (a, b) { return a + b; }, 0) / monthDayGaps.length) : 0;
    var maxGapStr = maxGap > 0 ? (fmtGap(maxGap) || fmtCoarse(maxGap)) : "—";
    var avgGapStr = avgGap > 0 ? (fmtGap(avgGap) || fmtCoarse(avgGap)) : "—";

    var whoChamp = "Dengeli 🎉";
    if (counts.utku > counts.gozde + 3) whoChamp = "Utku 🧔";
    else if (counts.gozde > counts.utku + 3) whoChamp = "Gözde 👩";

    grid.innerHTML =
      '<div class="wrapped-item">' +
        '<span class="wrapped-item-ico">🏆</span>' +
        '<span class="wrapped-item-title">Ayın Lideri</span>' +
        '<span class="wrapped-item-val">' + whoChamp + '</span>' +
        '<span class="wrapped-item-sub">Toplam ' + total + ' ' + catUnit + '</span>' +
      '</div>' +
      '<div class="wrapped-item">' +
        '<span class="wrapped-item-ico">👩‍❤️‍👨</span>' +
        '<span class="wrapped-item-title">Ortaklık Uyuşumu</span>' +
        '<span class="wrapped-item-val">%' + sharedPct + '</span>' +
        '<span class="wrapped-item-sub">' + sharedCount + ' birlikte</span>' +
      '</div>' +
      '<div class="wrapped-item">' +
        '<span class="wrapped-item-ico">⏰</span>' +
        '<span class="wrapped-item-title">Favori Saatiniz</span>' +
        '<span class="wrapped-item-val">' + peakHStr + '</span>' +
        '<span class="wrapped-item-sub">Zirve zamanı</span>' +
      '</div>' +
      '<div class="wrapped-item">' +
        '<span class="wrapped-item-ico">⏱️</span>' +
        '<span class="wrapped-item-title">Mola &amp; Ritim</span>' +
        '<span class="wrapped-item-val">' + avgGapStr + '</span>' +
        '<span class="wrapped-item-sub">En uzun: ' + maxGapStr + '</span>' +
      '</div>';

    if (activeCat === "sigo") {
      letter.innerHTML = '<strong>Aylık not 💌:</strong> ' + monthName + ' ayında Utku ve Gözde olarak ' + total + ' kez dumanaltı oldunuz! Sigolarınızın %' + sharedPct + '\'ini birlikte yaktınız, gün içi ortalama molanız <b>' + avgGapStr + '</b> oldu. Favori zamanınız saat ' + peakHStr + ' arası görünüyor! 🌿✨';
    } else {
      letter.innerHTML = '<strong>Özet Not 💌:</strong> ' + monthName + ' ayında Utku ve Gözde olarak toplam ' + total + ' ' + catUnit + ' kaydettiniz. Favori saat aralığınız ' + peakHStr + ' olarak öne çıkıyor! ✨';
    }
  }

  function renderHeatmap() {
    var chart = el("heatmapChart");
    if (!chart) return;
    chart.innerHTML = "";
    if (typeof d3 === "undefined") return;

    var scoped = scopedEntries();
    var now = Date.now();
    var sow = now - 7 * 86400000;
    var last7 = scoped.filter(function(e) { return e.ts >= sow; });

    // Y axis: Days 0..6 (Mon..Sun)
    var DAY_LABELS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
    var getDayIndex = function(ts) { 
      var d = new Date(ts).getDay(); // 0=Sun, 1=Mon ... 6=Sat
      return d === 0 ? 6 : d - 1;
    };

    var matrix = [];
    for (var d = 0; d < 7; d++) {
      for (var h = 0; h < 24; h++) {
        matrix.push({ dayIndex: d, hour: h, count: 0 });
      }
    }

    last7.forEach(function(e) {
      var hr = new Date(e.ts).getHours();
      var dIndex = getDayIndex(e.ts);
      var idx = dIndex * 24 + hr;
      if (matrix[idx]) matrix[idx].count++;
    });

    var maxCount = d3.max(matrix, function(d) { return d.count; }) || 1;
    var colorScale = d3.scaleSequential(d3.interpolateGreens).domain([0, maxCount * 1.2]); // Yüksek değerlerin fosforlu olmasını hafiflet

    var margin = { top: 15, right: 10, bottom: 20, left: 30 };
    var cellSize = 11;
    var cellGap = 3;
    var cellStep = cellSize + cellGap;

    var innerWidth = 24 * cellStep;
    var innerHeight = 7 * cellStep;

    var width = innerWidth + margin.left + margin.right;
    var height = innerHeight + margin.top + margin.bottom;

    var svg = d3.select(chart).append("svg")
      .attr("width", width)
      .attr("height", height);
    var g = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    // Y axis labels
    g.selectAll(".h-day-label")
      .data(d3.range(7))
      .enter().append("text")
      .attr("class", "h-day-label")
      .attr("x", -6)
      .attr("y", function(d) { return d * cellStep + cellSize / 2; })
      .attr("dy", "0.32em")
      .style("text-anchor", "end")
      .style("font-size", "10px")
      .style("fill", "var(--muted)")
      .text(function(d) { return DAY_LABELS[d]; });

    // X axis labels
    var xTicks = [0, 6, 12, 18];
    g.selectAll(".h-hour-label")
      .data(xTicks)
      .enter().append("text")
      .attr("class", "h-hour-label")
      .attr("x", function(d) { return d * cellStep; })
      .attr("y", innerHeight + 14)
      .style("text-anchor", "start")
      .style("font-size", "10px")
      .style("fill", "var(--muted)")
      .text(function(d) { return d; });

    var tooltip = d3.select("#d3Tooltip");

    g.selectAll(".heat-cell")
      .data(matrix)
      .enter().append("rect")
      .attr("class", "heat-cell")
      .attr("x", function(d) { return d.hour * cellStep; })
      .attr("y", function(d) { return d.dayIndex * cellStep; })
      .attr("width", cellSize)
      .attr("height", cellSize)
      .attr("rx", 2)
      .style("fill", function(d) { return d.count === 0 ? "rgba(255, 255, 255, 0.04)" : colorScale(d.count); })
      .on("mouseover touchstart", function(event, d) {
        tooltip.html('<div class="d3-tooltip-title">' + DAY_LABELS[d.dayIndex] + '</div>' +
                     '<div class="d3-tooltip-row"><span>Saat:</span><span class="d3-tooltip-val">' + pad2(d.hour) + ':00</span></div>' +
                     '<div class="d3-tooltip-row"><span>Miktar:</span><span class="d3-tooltip-val">' + d.count + ' sigo</span></div>')
               .classed("visible", true);
      })
      .on("mousemove touchmove", function(event) {
        tooltip.style("left", (event.pageX) + "px")
               .style("top", (event.pageY - 40) + "px");
      })
      .on("mouseout touchend", function(event) {
        tooltip.classed("visible", false);
      });
  }

  function renderTrendChart() {
    var chart = el("trendLineChart");
    if (!chart) return;
    chart.innerHTML = "";
    if (typeof d3 === "undefined") return;

    var scoped = scopedEntries();
    var now = Date.now();
    var eow = startOfDay(now).getTime() + 86400000;
    var sow = eow - 30 * 86400000; // last 30 days
    var list = scoped.filter(function(e) { return e.ts >= sow && e.ts < eow; });

    var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var days = [];
    for (var i = 0; i < 30; i++) {
      var d = new Date(sow + i * 86400000);
      days.push({
        date: d,
        count: 0,
        label: ("0" + d.getDate()).slice(-2) + " " + MONTH_NAMES[d.getMonth()]
      });
    }

    list.forEach(function(e) {
      var idx = Math.floor((e.ts - sow) / 86400000);
      if (idx >= 0 && idx < 30) days[idx].count++;
    });

    var maxTotal = d3.max(days, function(d) { return d.count; }) || 1;

    var margin = { top: 20, right: 15, bottom: 20, left: 25 };
    var width = chart.clientWidth || 300;
    var innerWidth = width - margin.left - margin.right;
    var innerHeight = 140 - margin.top - margin.bottom;

    var svg = d3.select(chart).append("svg")
      .attr("width", width)
      .attr("height", 140);
      
    var defs = svg.append("defs");
    var gradient = defs.append("linearGradient")
      .attr("id", "trend-gradient")
      .attr("x1", "0%").attr("y1", "0%")
      .attr("x2", "0%").attr("y2", "100%");
    gradient.append("stop").attr("offset", "0%").attr("stop-color", "var(--accent)").attr("stop-opacity", 0.4);
    gradient.append("stop").attr("offset", "100%").attr("stop-color", "var(--accent)").attr("stop-opacity", 0);

    var g = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    var x = d3.scalePoint().range([0, innerWidth]).domain(days.map(function(d) { return d.label; }));
    var yMax = maxTotal * 1.1; // 10% headroom
    var y = d3.scaleLinear().range([innerHeight, 0]).domain([0, yMax]); 

    var line = d3.line()
      .x(function(d) { return x(d.label); })
      .y(function(d) { return y(d.count); })
      .curve(d3.curveMonotoneX);

    var area = d3.area()
      .x(function(d) { return x(d.label); })
      .y0(innerHeight)
      .y1(function(d) { return y(d.count); })
      .curve(d3.curveMonotoneX);

    // Draw Gridlines & Axes first so they stay behind
    var yTicks = y.ticks(4);
    
    // Horizontal dotted grid lines
    g.selectAll(".y-grid-line")
      .data(yTicks)
      .enter().append("line")
      .attr("class", "grid-line")
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", function(d) { return y(d); })
      .attr("y2", function(d) { return y(d); })
      .style("stroke", "var(--border)")
      .style("stroke-dasharray", "3,3")
      .style("stroke-width", "1px");

    // Vertical dotted Y axis line
    g.append("line")
      .attr("x1", 0)
      .attr("x2", 0)
      .attr("y1", 0)
      .attr("y2", innerHeight)
      .style("stroke", "var(--border)")
      .style("stroke-dasharray", "3,3")
      .style("stroke-width", "1px");

    // Solid X Axis line at bottom
    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", innerHeight)
      .attr("y2", innerHeight)
      .style("stroke", "var(--border)")
      .style("stroke-width", "1px");

    // Area
    g.append("path")
      .datum(days)
      .attr("class", "trend-area")
      .attr("d", area);

    // Line
    var path = g.append("path")
      .datum(days)
      .attr("class", "trend-line")
      .attr("d", line);
      
    var totalLength = path.node().getTotalLength();
    path.attr("stroke-dasharray", totalLength + " " + totalLength)
      .attr("stroke-dashoffset", totalLength)
      .transition()
      .duration(1500)
      .ease(d3.easeCubicOut)
      .attr("stroke-dashoffset", 0);

    // Y Axis labels
    g.selectAll(".t-y-label")
      .data(yTicks)
      .enter().append("text")
      .attr("class", "t-y-label")
      .attr("x", -8)
      .attr("y", function(d) { return y(d); })
      .attr("dy", "0.32em")
      .style("text-anchor", "end")
      .style("font-size", "10px")
      .style("fill", "var(--muted)")
      .text(function(d) { return d; });

    // X Axis ticks & labels
    var xTickIndices = [0, 7, 14, 21, 29];
    var xTickData = days.filter(function(d, i) { return xTickIndices.indexOf(i) !== -1; });

    g.selectAll(".t-x-tick")
      .data(xTickData)
      .enter().append("line")
      .attr("class", "t-x-tick")
      .attr("x1", function(d) { return x(d.label); })
      .attr("x2", function(d) { return x(d.label); })
      .attr("y1", innerHeight)
      .attr("y2", innerHeight + 5)
      .style("stroke", "var(--border)")
      .style("stroke-width", "1px");

    g.selectAll(".t-x-label")
      .data(xTickData)
      .enter().append("text")
      .attr("class", "t-x-label")
      .attr("x", function(d) { return x(d.label); })
      .attr("y", innerHeight + 16)
      .style("text-anchor", "middle")
      .style("font-size", "10px")
      .style("fill", "var(--muted)")
      .text(function(d) { return d.label; });

    var tooltip = d3.select("#d3Tooltip");

    // Interaction dots
    g.selectAll(".trend-dot")
      .data(days)
      .enter().append("circle")
      .attr("class", "trend-dot")
      .attr("cx", function(d) { return x(d.label); })
      .attr("cy", function(d) { return y(d.count); })
      .attr("r", 0) // animate in
      .on("mouseover touchstart", function(event, d) {
        tooltip.html('<div class="d3-tooltip-title">' + d.label + '</div>' +
                     '<div class="d3-tooltip-row"><span>Toplam:</span><span class="d3-tooltip-val">' + d.count + '</span></div>')
               .classed("visible", true);
        d3.select(this).attr("r", 5);
      })
      .on("mousemove touchmove", function(event) {
        tooltip.style("left", (event.pageX) + "px")
               .style("top", (event.pageY - 30) + "px");
      })
      .on("mouseout touchend", function(event) {
        tooltip.classed("visible", false);
        d3.select(this).attr("r", 3);
      })
      .transition().delay(1000).duration(500).attr("r", 3);

    // Draw max value(s) above peaks
    var peaks = days.filter(function(d) { return d.count === maxTotal && maxTotal > 0; });
    g.selectAll(".trend-peak-label")
      .data(peaks)
      .enter().append("text")
      .attr("class", "trend-peak-label")
      .attr("x", function(d) { return x(d.label); })
      .attr("y", function(d) { return y(d.count) - 10; })
      .style("text-anchor", "middle")
      .style("font-size", "11px")
      .style("font-weight", "800")
      .style("fill", "var(--text)")
      .text(function(d) { return d.count; })
      .attr("opacity", 0)
      .transition().delay(1500).duration(500).attr("opacity", 1);
  }

  // İstatistik sekmesinin bileşenleri: kişi filtresi değişince yalnız bunlar çizilir
  function renderStats() {
    renderDuel();
    renderWrapped();
    renderStatCards();
    renderIntervalStats();
    renderBadges();
    renderChart();
    renderWeeklyComparison();
    renderTod();
    renderHeatmap();
    renderTrendChart();
    renderShare();
    renderDow();
    renderCalendar();
    renderRecords();
  }

  // Dokunma anında akıcılık: sadece görünür hafif kartlar hemen çizilir,
  // ağır DOM işleri (grafikler, takvim, içgörüler...) animasyon sonrasına kalır
  function renderQuick() {
    renderToday();
    renderLimit();
    renderSince();
    renderSession();
    renderWeeklySummary();
    renderTrash();
    var hist = el("view-history");
    if (hist && !hist.classList.contains("hidden")) renderHistory();
    clearTimeout(renderDeferTimer);
    renderDeferTimer = setTimeout(render, 700);
  }

  // iOS Safari'de dokunsal geri bildirim (Taptic) web'den tetiklenemez; onun yerine
  // Web Audio ile üretilen minik bir "pop" sesi (ayarlardan açılır). Dosya/asset yok.
  var _audioCtx = null;
  function playPop(combo) {
    if (settings.sound !== "on") return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!_audioCtx) _audioCtx = new AC();
      if (_audioCtx.state === "suspended") _audioCtx.resume();
      var t = _audioCtx.currentTime;
      var osc = _audioCtx.createOscillator();
      var gain = _audioCtx.createGain();
      osc.connect(gain); gain.connect(_audioCtx.destination);
      var base = combo >= 3 ? 720 : 540; // kombo'da bir tık tiz
      osc.type = "sine";
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.6, t + 0.07);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.start(t); osc.stop(t + 0.16);
    } catch (e) {}
  }

  function addEntry(who, x, y, kind, tag) {
    var k = kind || selectedAddKind || "sigo";
    var duplicate = entries.length ? entries[entries.length - 1] : null;
    if (duplicate && duplicate.who === who && entryKind(duplicate) === k && Date.now() - duplicate.ts < 30000) {
      if (!confirm("Aynı kayıt son 30 saniye içinde eklendi. Yine de eklensin mi?")) return;
    }
    var entry = { id: uuid(), who: who, kind: k, ts: Date.now() };
    if (tag) entry.tag = tag;
    if (settings.locationEnabled && lastKnownLocation) {
      entry.lat = lastKnownLocation.lat;
      entry.lng = lastKnownLocation.lng;
    }
    try { localStorage.setItem("dumanalti.lastKind." + activeCat, k); } catch (e) {}
    entries.push(entry);
    sortEntries();
    // Optimistic UI: önce kuyruğa al, sonra anında çiz (bekliyor işareti doğru görünsün)
    outbox.push({ type: "insert", row: entry });
    saveCache();
    saveOutbox();
    renderQuick();
    showUndo(who);
    var combo = bumpCombo();
    emojiConfetti(who, x, y, combo);
    if (combo >= 3) showCombo(combo);
    // Titreşim (Android) — iOS Safari desteklemez, orada ses efekti devreye girer.
    if (navigator.vibrate) navigator.vibrate(combo >= 3 ? [15, 30, 15] : 15);
    playPop(combo);

    flushOutbox();
    refreshStatus();
  }

  function deleteEntry(id) {
    var idx = findIndexById(id);
    if (idx === -1) return;
    var removed = entries[idx];
    entries.splice(idx, 1);
    trash.push({ cat: activeCat, row: removed, deletedAt: Date.now() });
    saveTrash();
    saveCache();
    renderQuick();

    // Henüz gönderilmemiş bir ekleme ise, kuyruktan iptal et; aksi halde silme kuyruğa gir
    var pendingInsert = false;
    for (var i = 0; i < outbox.length; i++) {
      if (outbox[i].type === "insert" && outbox[i].row && outbox[i].row.id === id) {
        outbox.splice(i, 1);
        pendingInsert = true;
        break;
      }
    }
    if (!pendingInsert) outbox.push({ type: "update", id: id, fields: { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }, baseUpdatedAt: removed.updatedAt || null });
    saveOutbox();
    flushOutbox();
    refreshStatus();
  }

  function shareWrappedImage() {
    var monthList = entriesSince(startOfMonth()), counts = countWho(monthList);
    var canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1350;
    var ctx = canvas.getContext("2d"), grad = ctx.createLinearGradient(0, 0, 1080, 1350);
    grad.addColorStop(0, "#12152b"); grad.addColorStop(0.55, "#32245c"); grad.addColorStop(1, "#0f746c");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 1080, 1350);
    ctx.fillStyle = "rgba(255,255,255,.08)"; ctx.beginPath(); ctx.arc(930, 170, 270, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f4eeff"; ctx.font = "700 44px system-ui"; ctx.fillText("DUMANALTI WRAPPED", 80, 120);
    ctx.font = "800 96px system-ui"; ctx.fillText(String(monthList.length), 80, 330);
    ctx.font = "500 38px system-ui"; ctx.fillStyle = "#cfc7e8"; ctx.fillText("bu ay toplam " + CATS[activeCat].unitPlural, 80, 390);
    ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fillRect(80, 490, 920, 380);
    ctx.fillStyle = "#ffffff"; ctx.font = "700 42px system-ui";
    ctx.fillText("Utku  " + (counts.utku + counts.both + counts.hepberaber), 130, 610);
    ctx.fillText("Gözde  " + (counts.gozde + counts.both + counts.hepberaber), 130, 710);
    ctx.fillText("Birlikte  " + (counts.both + counts.hepberaber), 130, 810);
    var mGaps = calcIntraDayGaps(monthList);
    var mAvgStr = mGaps.length ? (fmtGap(mGaps.reduce(function(a,b){return a+b;},0)/mGaps.length) || "—") : "—";
    ctx.fillStyle = "#bdfcf2"; ctx.font = "700 36px system-ui"; ctx.fillText("🔥 Ortak seri: " + commonStreak() + " gün  ·  ⏱️ Ort. mola: " + mAvgStr, 80, 1000);
    ctx.fillStyle = "#cfc7e8"; ctx.font = "500 30px system-ui"; ctx.fillText("Utku & Gözde · " + new Date().toLocaleDateString("tr-TR", { month: "long", year: "numeric" }), 80, 1215);
    canvas.toBlob(function (blob) {
      if (!blob) return;
      var file = new File([blob], "dumanalti-wrapped.png", { type: "image/png" });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ title: "Dumanaltı Wrapped", files: [file] }).catch(function () {});
      } else {
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      }
    }, "image/png");
  }

  function restoreTrash(item) {
    var idx = trash.indexOf(item); if (idx === -1) return;
    trash.splice(idx, 1); saveTrash();
    var cat = item.cat, row = item.row;
    delete row.deletedAt;
    catStore[cat].entries.push(row);
    catStore[cat].entries.sort(function (a, b) { return a.ts - b.ts; });
    catStore[cat].outbox.push({ type: "insert", row: row });
    catStore[cat].outbox.push({ type: "update", id: row.id, fields: { deleted_at: null, updated_at: new Date().toISOString() }, baseUpdatedAt: row.updatedAt || null });
    saveCatCache(cat); saveCatOutbox(cat);
    if (cat === activeCat) { entries = catStore[cat].entries; outbox = catStore[cat].outbox; render(); }
    flushOutbox(cat);
  }

  function purgeTrash() {
    var cutoff = Date.now() - 7 * 86400000, kept = [];
    trash.forEach(function (item) {
      if (item.deletedAt >= cutoff) kept.push(item);
      else catStore[item.cat].outbox.push({ type: "delete", id: item.row.id });
    });
    trash = kept; saveTrash();
    CAT_ORDER.forEach(function (cat) { saveCatOutbox(cat); flushOutbox(cat); });
  }

  // Bir kaydın alanlarını günceller (kişi/saat/etiket/tür); buluta update olarak gider
  function patchEntry(id, fields) {
    var idx = findIndexById(id);
    if (idx === -1) return;
    var baseUpdatedAt = entries[idx].updatedAt || null;
    Object.keys(fields).forEach(function (k) {
      entries[idx][k] = fields[k];
    });
    sortEntries();
    saveCache();
    // Henüz gönderilmemiş bir ekleme ise satırı yerinde güncelle; değilse update kuyruğa
    var pendingInsert = false;
    for (var i = 0; i < outbox.length; i++) {
      if (outbox[i].type === "insert" && outbox[i].row && outbox[i].row.id === id) {
        Object.keys(fields).forEach(function (k) {
          outbox[i].row[k] = fields[k];
        });
        pendingInsert = true;
        break;
      }
    }
    if (!pendingInsert) {
      outbox.push({ type: "update", id: id, fields: Object.assign({}, fields, { updated_at: new Date().toISOString() }), baseUpdatedAt: baseUpdatedAt });
    }
    saveOutbox();
    flushOutbox();
    refreshStatus();
  }

  // Geçmişten düzenleme: kişi + saat + tür/etiket
  function updateEntry(id, who, ts, kind, tag) {
    editingId = null;
    var fields = { who: who, ts: ts, kind: kind || "sigo" };
    if (tag !== undefined) fields.tag = tag;
    patchEntry(id, fields);
    render();
  }

  function showUndo(who) {
    lastUndo = entries[entries.length - 1];
    var bar = el("undoBar");
    var ut = el("undoText");
    ut.innerHTML = "";
    ut.appendChild(makeAvatar(who, "avatar-sm"));
    var kInfo = KINDS[entryKind(lastUndo)] || KINDS.sigo;
    ut.appendChild(document.createTextNode(" " + WHO[who].label + " (" + kInfo.emoji + " " + kInfo.label + ") eklendi"));

    bar.classList.remove("hidden");
    var quick = el("quickEditBar");
    if (quick) quick.classList.remove("hidden");
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { bar.classList.add("hidden"); if (quick) quick.classList.add("hidden"); lastUndo = null; }, 8000);
  }

  function undoLast() {
    if (!lastUndo) return;
    deleteEntry(lastUndo.id);
    lastUndo = null;
    el("undoBar").classList.add("hidden");
    if (el("quickEditBar")) el("quickEditBar").classList.add("hidden");
    clearTimeout(undoTimer);
  }

  // ---------- Konfeti (canvas-confetti fizik modeli) ----------
  // Tek tam-ekran canvas + yukarı koni fırlatma + decay/gravity/wobble/tilt.
  var CONFETTI_EXTRAS = ["✨", "🎉", "🎊", "🥳", "⭐️", "💥"];
  var CONFETTI_COLORS = {
    utku:  ["#4f9dff", "#2c6fd6", "#9cc6ff", "#ffffff", "#ffd166"],
    gozde: ["#ff5fa2", "#d63d80", "#ffb3d1", "#ffffff", "#ffd166"],
    both:  ["#b07bff", "#7d4fd6", "#4f9dff", "#ff5fa2", "#ffffff", "#ffd166"],
    hepberaber: ["#ffd166", "#ffb347", "#ff8c42", "#b07bff", "#4f9dff", "#ffffff"]
  };

  var confettiCanvas = null, confettiCtx = null, confettiParticles = [], confettiRunning = false;
  var confettiLastFrameAt = 0; // son çizilen karenin zamanı (donma tespiti için)
  var confettiAvatarImgs = {};

  function confettiAvatarImg(who) {
    if (!confettiAvatarImgs[who]) {
      var img = new Image();
      img.src = WHO[who].avatar;
      confettiAvatarImgs[who] = img;
    }
    return confettiAvatarImgs[who];
  }

  // Büyük avatar fotoğrafını her karede ölçeklemek pahalı; bir kez 64px sprite'a indir
  var confettiAvatarSprites = {};
  function avatarSprite(who) {
    var s = confettiAvatarSprites[who];
    if (s) return s;
    var img = confettiAvatarImg(who);
    if (!(img.complete && img.naturalWidth)) return null; // henüz yüklenmediyse bu karede çizme
    s = document.createElement("canvas");
    s.width = 64; s.height = 64;
    s.getContext("2d").drawImage(img, 0, 0, 64, 64);
    confettiAvatarSprites[who] = s;
    return s;
  }

  function ensureConfettiCanvas() {
    if (!confettiCanvas) {
      confettiCanvas = document.createElement("canvas");
      confettiCanvas.className = "confetti-canvas";
      document.body.appendChild(confettiCanvas);
      confettiCtx = confettiCanvas.getContext("2d");
    }
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = window.innerWidth, h = window.innerHeight;
    if (confettiCanvas.width !== (w * dpr | 0) || confettiCanvas.height !== (h * dpr | 0)) {
      confettiCanvas.width = w * dpr | 0;
      confettiCanvas.height = h * dpr | 0;
      confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function fireConfetti(who, ox, oy, count, opts) {
    var radSpread = (opts.spread || 60) * Math.PI / 180;
    var sv = opts.velocity || 30;
    var colors = CONFETTI_COLORS[who] || CONFETTI_COLORS.both;
    for (var i = 0; i < count; i++) {
      // ~%8 fotoğraf, ~%8 emoji, kalanı renkli kağıt parçası (kağıt baskın = doğal)
      var roll = Math.random();
      var shape = roll < 0.08 ? "avatar" : roll < 0.16 ? "emoji" : "paper";
      confettiParticles.push({
        who: who,
        shape: shape,
        x: ox,
        y: oy,
        // yukarı (-90°) merkezli koni içinde rastgele açı
        angle2D: -Math.PI / 2 + (0.5 * radSpread - Math.random() * radSpread),
        velocity: sv * 0.5 + Math.random() * sv,
        decay: opts.decay || 0.9,
        gvel: 0, // yerçekimi hızı: 0'dan başlar, süzülme hızına doğru artar
        drift: (Math.random() - 0.5) * 3.2,
        wobble: Math.random() * 10,
        wobbleSpeed: 0.05 + Math.random() * 0.06,
        tiltAngle: (0.25 + Math.random() * 0.5) * Math.PI,
        tiltSpeed: 0.08 + Math.random() * 0.1,
        rand: Math.random() + 2,
        scalar: opts.scalar || 1,
        color: colors[(Math.random() * colors.length) | 0],
        emoji: CONFETTI_EXTRAS[(Math.random() * CONFETTI_EXTRAS.length) | 0],
        size: shape === "avatar" ? 22 + Math.random() * 12 : 15 + Math.random() * 8,
        tick: 0,
        totalTicks: opts.ticks || 330
      });
    }
  }

  // Kare süresine göre normalize edilmiş fizik: 60/120Hz'de ve kare düşmelerinde
  // aynı hızda akar (dtF = kaç adet 60fps karesi geçti)
  var confettiLastT = 0;

  function confettiFrame(nowT) {
    ensureConfettiCanvas();
    var ctx = confettiCtx;
    var W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);

    var dtF = 1;
    if (typeof nowT === "number") {
      if (confettiLastT) dtF = Math.min(3, Math.max(0.5, (nowT - confettiLastT) / 16.667));
      confettiLastT = nowT;
    }

    var alive = [];
    for (var i = 0; i < confettiParticles.length; i++) {
      var p = confettiParticles[i];
      p.x += (Math.cos(p.angle2D) * p.velocity + p.drift) * dtF;
      // Yerçekimi anında bastırmaz: parçacık önce fırlar, düşüş hızı yavaşça
      // süzülme hızına (kağıt hafif, fotoğraf ağır) ulaşır → doğal patlama+yağmur
      p.gvel = Math.min(p.shape === "paper" ? 2.6 : 3.4, p.gvel + 0.13 * dtF);
      p.y += (Math.sin(p.angle2D) * p.velocity + p.gvel) * dtF;
      p.velocity *= Math.pow(p.decay, dtF); // patlama hızı sönümlenir
      p.wobble += p.wobbleSpeed * dtF;      // yana doğru salınım
      p.tiltAngle += p.tiltSpeed * dtF;     // 3B takla dönüşü
      p.tick += dtF;

      var progress = p.tick / p.totalTicks;
      if (progress >= 1 || p.y > H + 40) continue;
      alive.push(p);

      var alpha = progress > 0.75 ? 1 - (progress - 0.75) / 0.25 : 1; // sona doğru sol
      ctx.globalAlpha = alpha;
      var tiltSin = Math.sin(p.tiltAngle), tiltCos = Math.cos(p.tiltAngle);
      var wobX = Math.cos(p.wobble), wobY = Math.sin(p.wobble);

      if (p.shape === "paper") {
        // canvas-confetti dörtgeni: wobble bir köşeyi, tilt diğerini kaydırır → uçuşan kağıt
        var wobbleX = p.x + 10 * p.scalar * wobX;
        var wobbleY = p.y + 10 * p.scalar * wobY;
        var x1 = p.x + p.rand * tiltCos;
        var y1 = p.y + p.rand * tiltSin;
        var x2 = wobbleX + p.rand * tiltCos;
        var y2 = wobbleY + p.rand * tiltSin;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(wobbleX, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x1, wobbleY);
        ctx.closePath();
        ctx.fill();
      } else if (p.shape === "avatar") {
        var av = avatarSprite(p.who);
        if (av) {
          var s = p.size * p.scalar;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(0.35 * wobX);
          // takla: dikey eksende daralıp genişleme (madeni para dönüşü)
          ctx.scale(1, 0.45 + 0.55 * Math.abs(tiltCos));
          ctx.drawImage(av, -s / 2, -s / 2, s, s);
          ctx.restore();
        }
      } else {
        // fillText her karede pahalı (Safari); emoji bir kez sprite'a çizilir
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(0.5 * wobX);
        var es = p.size * p.scalar;
        ctx.drawImage(emojiSprite(p.emoji), -es / 2, -es / 2, es, es);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    confettiParticles = alive;
    confettiLastFrameAt = Date.now();

    if (confettiParticles.length) {
      requestAnimationFrame(confettiFrame);
    } else {
      confettiRunning = false;
      confettiLastT = 0;
      ctx.clearRect(0, 0, W, H);
    }
  }

  // Konfetiyi tamamen durdur ve temizle (arka plana geçişte / donma sonrası)
  function clearConfetti() {
    confettiParticles = [];
    confettiRunning = false;
    confettiLastT = 0;
    if (confettiCtx) confettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  // iOS Safari sayfayı arka plana alınca requestAnimationFrame'i düşürür ve konfeti
  // ekranda donar. Sekme gizlenince/çıkışta konfetiyi temizle ki takılı kalmasın.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) clearConfetti();
  });
  window.addEventListener("pagehide", clearConfetti);
  window.addEventListener("blur", function () {
    // Odak kaybında da güvence: kısa süre sonra hâlâ donmuşsa temizle
    setTimeout(function () { if (confettiRunning && Date.now() - confettiLastFrameAt > 400) clearConfetti(); }, 500);
  });

  // Emoji sprite önbelleği: her emoji bir kez 48px canvas'a çizilir
  var emojiSprites = {};
  function emojiSprite(ch) {
    var s = emojiSprites[ch];
    if (!s) {
      s = document.createElement("canvas");
      s.width = 48; s.height = 48;
      var c = s.getContext("2d");
      c.font = "40px serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(ch, 24, 26);
      emojiSprites[ch] = s;
    }
    return s;
  }

  function emojiConfetti(who, x, y, combo) {
    if (settings.confetti === "off") return; // kutlama efekti kapalı
    var reduce = settings.confetti === "lite" ||
      (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var W = window.innerWidth, H = window.innerHeight;
    var ox = x != null ? x : W / 2;
    var oy = y != null ? y : H / 2;
    combo = combo || 1;

    if (!reduce) {
      // Sarsıntı blur'lu cam kartların tamamını yeniden boyatıyor (Safari'de pahalı);
      // patlamanın ilk karelerini yemesin diye sadece combo anlarına saklandı
      if (combo >= 3) screenShake(combo);
      flashAt(ox, oy);
    }

    ensureConfettiCanvas();
    // Sprite'ları ilk kare gelmeden ısındır: patlama anında tek seferlik iş kalmasın
    avatarSprite(who);
    for (var ei = 0; ei < CONFETTI_EXTRAS.length; ei++) emojiSprite(CONFETTI_EXTRAS[ei]);

    var total = reduce ? 14 : Math.min(200, 100 + (combo - 1) * 25);
    // Fırlatma hızını üstteki boşluğa göre ölçekle: buton tepedeyse parçalar
    // ekrandan taşmasın, patlama görünür kalsın.
    var vk = Math.max(0.55, Math.min(1, oy / 450));

    // canvas-confetti "realistic look" reçetesi: farklı hız/açı/boyutta 5 dalga.
    // Geniş açılar + yüksek yanal hız = tüm ekranı kaplayan yağmur.
    fireConfetti(who, ox, oy, Math.round(total * 0.25), { spread: 70, velocity: 52 * vk });
    fireConfetti(who, ox, oy, Math.round(total * 0.20), { spread: 110, velocity: 46 * vk });
    fireConfetti(who, ox, oy, Math.round(total * 0.35), { spread: 150, velocity: 46 * vk, decay: 0.91, scalar: 0.8 });
    fireConfetti(who, ox, oy, Math.round(total * 0.10), { spread: 180, velocity: 28 * vk, decay: 0.92, scalar: 1.2 });
    fireConfetti(who, ox, oy, Math.round(total * 0.10), { spread: 180, velocity: 46 * vk });

    // Döngü ölmüşse (rAF düştüyse) yeniden başlat: confettiRunning true olsa bile
    // son kareden 300ms+ geçtiyse donmuş sayılır, temiz başlat.
    if (confettiRunning && Date.now() - confettiLastFrameAt > 300) confettiRunning = false;
    if (!confettiRunning) {
      confettiRunning = true;
      confettiLastFrameAt = Date.now();
      confettiLastT = 0;
      requestAnimationFrame(confettiFrame);
    }
  }

  function screenShake(combo) {
    var app = /** @type {HTMLElement} */ (document.querySelector(".app") || document.body);
    app.classList.remove("shake");
    void app.offsetWidth; // reflow tetikle (animasyonu yeniden başlatmak için)
    app.classList.add(combo >= 3 ? "shake-hard" : "shake");
    setTimeout(function () { app.classList.remove("shake"); app.classList.remove("shake-hard"); }, 520);
  }

  function flashAt(x, y) {
    var f = document.createElement("div");
    f.className = "tap-flash";
    f.style.left = x + "px";
    f.style.top = y + "px";
    document.body.appendChild(f);
    setTimeout(function () { f.remove(); }, 520);
  }

  function bumpCombo() {
    comboCount++;
    clearTimeout(comboTimer);
    comboTimer = setTimeout(function () { comboCount = 0; }, 2500);
    return comboCount;
  }

  function showCombo(n) {
    var node = document.createElement("div");
    node.className = "combo-pop";
    node.textContent = "🔥 x" + n;
    document.body.appendChild(node);
    setTimeout(function () { node.remove(); }, 850);
  }

  // ---------- Cloud sync ----------
  var realtimeChannels = {}; // Kategori bazlı kanallar

  function initCloud() {
    if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) {
      refreshStatus();
      return;
    }
    try {
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
        realtime: { params: { eventsPerSecond: 5 } }
      });
    } catch (e) {
      sb = null;
      refreshStatus();
      return;
    }

    var promises = CAT_ORDER.map(function(c) {
      return flushOutbox(c).then(function() { return syncFromRemote(c); }).then(function() { subscribeRealtime(c); });
    });

    Promise.all(promises).then(function() {
      cloudReady = true;
      refreshStatus();
    });

    window.addEventListener("online", function () {
      CAT_ORDER.forEach(function(c) { flushOutbox(c).then(function() { syncFromRemote(c); }); });
      refreshStatus();
    });
    window.addEventListener("offline", refreshStatus);
  }

  function isMissingColumnResult(res) {
    var err = res && res.error;
    return !!(err && (err.code === "42703" || err.code === "PGRST204") && /column|schema cache/i.test(err.message || ""));
  }

  function legacyDbRow(cat, row) {
    var dbRow = { id: row.id, who: row.who, ts: row.ts };
    // Mevcut üretim şemasında yalnız sigo tablosunda bu alanlar var.
    if (cat === "sigo") {
      if (row.tag) dbRow.tag = row.tag;
      if (row.lat !== undefined) dbRow.lat = row.lat;
      if (row.lng !== undefined) dbRow.lng = row.lng;
    }
    return dbRow;
  }

  function legacyUpdateFields(cat, fields) {
    var safe = {};
    ["who", "ts"].forEach(function (key) {
      if (fields[key] !== undefined) safe[key] = fields[key];
    });
    if (cat === "sigo") {
      ["tag", "lat", "lng"].forEach(function (key) {
        if (fields[key] !== undefined) safe[key] = fields[key];
      });
    }
    return safe;
  }

  function withSchemaFallback(primary, fallback) {
    return Promise.resolve(primary).then(function (res) {
      if (isMissingColumnResult(res)) return fallback();
      return res;
    });
  }

  function flushOutbox(cat) {
    if (!cat) cat = activeCat;
    var catOutbox = catStore[cat].outbox;
    var tableName = CATS[cat].table;
    if (!sb || !navigator.onLine || catOutbox.length === 0) return Promise.resolve();
    var queue = catOutbox.slice();
    var firstErr = null;

    function step(i) {
      if (i >= queue.length) return Promise.resolve();
      var op = queue[i];
      var p;
      if (op.type === "insert") {
        var dbRow = { id: op.row.id, who: op.row.who, ts: op.row.ts, kind: op.row.kind || "sigo" };
        if (op.row.tag) dbRow.tag = op.row.tag;
        if (op.row.lat !== undefined) dbRow.lat = op.row.lat;
        if (op.row.lng !== undefined) dbRow.lng = op.row.lng;
        if (op.row.sessionId) dbRow.session_id = op.row.sessionId;
        p = withSchemaFallback(
          sb.from(tableName).upsert(dbRow, { onConflict: "id", ignoreDuplicates: true }),
          function () { return sb.from(tableName).upsert(legacyDbRow(cat, op.row), { onConflict: "id", ignoreDuplicates: true }); }
        );
      } else if (op.type === "update") {
        var fields = Object.assign({}, op.fields);
        p = withSchemaFallback(
          sb.from(tableName).update(fields).eq("id", op.id),
          function () { return sb.from(tableName).update(legacyUpdateFields(cat, fields)).eq("id", op.id); }
        );
      } else {
        p = sb.from(tableName).delete().eq("id", op.id);
      }
      return p.then(function (res) {
        if (res && res.error) throw res.error;
        // başarılı: gerçek kuyruktan bu işlemi çıkar
        var idx = catOutbox.indexOf(op);
        if (idx !== -1) { catOutbox.splice(idx, 1); saveCatOutbox(cat); }
      }).catch(function (err) {
        // bu işlemi kuyrukta bırak ama diğerlerini engelleme
        if (!firstErr) firstErr = err;
      }).then(function () { return step(i + 1); });
    }

    return step(0).then(function () {
      if (cat === activeCat) render(); // senkronlananların "bekliyor" işareti kalksın
      if (firstErr) { cloudError(firstErr); }
      else { lastCloudError = null; refreshStatus(); }
    });
  }

  function syncFromRemote(cat) {
    if (!cat) cat = activeCat;
    var tableName = CATS[cat].table;
    var catOutbox = catStore[cat].outbox;
    if (!sb || !navigator.onLine) return Promise.resolve();
    return sb.from(tableName).select("*").order("ts", { ascending: true }).then(function (res) {
      if (res.error) { cloudError(res.error); return; }
      lastCloudError = null;
      if (!res.data) return;
      var map = {};
      res.data.forEach(function (r) {
        var o = normalizeEntry(r, cat, false);
        if (o && !o.deletedAt) map[o.id] = o;
      });
      // Henüz gönderilmemiş yerel işlemleri uzaktaki veriye uygula
      catOutbox.forEach(function (op) {
        if (op.type === "insert" && op.row) map[op.row.id] = op.row;
        else if (op.type === "delete") delete map[op.id];
        else if (op.type === "update" && map[op.id] && op.fields) {
          var remoteUpdated = map[op.id].updatedAt || null;
          if (op.baseUpdatedAt && remoteUpdated && op.baseUpdatedAt !== remoteUpdated) { conflicts.push({ cat: cat, id: op.id, at: Date.now(), resolution: "local" }); saveConflicts(); }
          Object.keys(op.fields).forEach(function (k) { map[op.id][k] = op.fields[k]; });
        }
      });
      // Yerel kurtarma: Eğer yerelde uzakta henüz bulunmayan geçerli kayıtlar varsa (yeni veritabanına geçiş),
      // uzaktaki veriyi ezmeyelim; yereldeki eski kayıtları outbox'a ekleyip yeni veritabanına aktaralım.
      var hadLocalRecovery = false;
      if (catStore[cat].entries && catStore[cat].entries.length > res.data.length) {
        catStore[cat].entries.forEach(function (localE) {
          if (localE && localE.id && !map[localE.id] && !localE.deletedAt && localE.ts >= EPOCH_TS) {
            map[localE.id] = localE;
            catOutbox.push({ type: "insert", row: localE });
            hadLocalRecovery = true;
          }
        });
        if (hadLocalRecovery) {
          saveCatOutbox(cat);
          flushOutbox(cat);
        }
      }
      catStore[cat].entries = Object.keys(map).map(function (k) { return map[k]; });
      catStore[cat].entries.sort(function (a, b) { return a.ts - b.ts; });
      saveCatCache(cat);
      if (cat === activeCat) {
        entries = catStore[activeCat].entries;
        render();
      }
      lastSyncAt = Date.now();
      refreshStatus();
    }).catch(function (err) { cloudError(err); });
  }

  function subscribeRealtime(cat) {
    if (!cat) cat = activeCat;
    if (!sb) return;
    var tableName = CATS[cat].table;
    var userKey = settings.owner || "guest";
    var chName = "dumanalti-" + tableName;
    var ch = sb.channel(chName, {
      config: { presence: { key: userKey } }
    });
    realtimeChannels[cat] = ch;

    // Helper: sadece o kategorinin entries dizisinde index arar
    function catFindIndex(id) {
      var arr = catStore[cat].entries;
      for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) return i; }
      return -1;
    }

    ch
      .on("postgres_changes", { event: "INSERT", schema: "public", table: tableName }, function (payload) {
        var r = payload.new;
        if (!r || catFindIndex(r.id) !== -1) return;
        var o = normalizeEntry(r, cat, false);
        if (!o) return;
        catStore[cat].entries.push(o);
        catStore[cat].entries.sort(function (a, b) { return a.ts - b.ts; });
        saveCatCache(cat);
        if (cat === activeCat) render();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: tableName }, function (payload) {
        var r = payload.new;
        var idx = r ? catFindIndex(r.id) : -1;
        if (idx === -1) return;
        var updated = normalizeEntry(r, cat, false);
        if (!updated) return;
        if (updated.deletedAt) {
          catStore[cat].entries.splice(idx, 1);
          saveCatCache(cat);
          if (cat === activeCat) render();
          return;
        }
        catStore[cat].entries[idx] = updated;
        catStore[cat].entries.sort(function (a, b) { return a.ts - b.ts; });
        saveCatCache(cat);
        if (cat === activeCat) render();
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: tableName }, function (payload) {
        var id = payload.old && payload.old.id;
        var idx = id ? catFindIndex(id) : -1;
        if (idx === -1) return;
        catStore[cat].entries.splice(idx, 1);
        saveCatCache(cat);
        if (cat === activeCat) render();
      })
      .on("presence", { event: "sync" }, function () {
        var state = ch.presenceState();
        onlineUsers = {};
        Object.keys(state).forEach(function (k) {
          if (k === "utku") onlineUsers["Utku"] = true;
          else if (k === "gozde") onlineUsers["Gözde"] = true;
        });
        updatePresenceUI();
      })
      .subscribe(function (status) {
        if (status === "SUBSCRIBED") {
          refreshStatus();
          if (settings.owner) {
            ch.track({ onlineAt: Date.now() });
          }
        }
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("Realtime durumu (" + cat + "):", status);
        }
      });
  }

  // ---------- Data tools ----------
  function exportData() {
    var categories = {};
    CAT_ORDER.forEach(function (cat) {
      categories[cat] = catStore[cat].entries.slice();
    });
    var payload = { app: "dumanalti", version: 2, exportedAt: new Date().toISOString(), categories: categories };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "dumanalti-tam-yedek-" + dayKey(Date.now()) + ".json";
    a.click();
    URL.revokeObjectURL(url);
    try { localStorage.setItem(BACKUP_KEY, String(Date.now())); } catch (e) {}
    renderBackupReminder();
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(/** @type {string} */ (reader.result));
        var incomingByCat = {};
        if (data && data.version >= 2 && data.categories && typeof data.categories === "object") {
          CAT_ORDER.forEach(function (cat) { incomingByCat[cat] = data.categories[cat] || []; });
        } else {
          var legacy = Array.isArray(data) ? data : data && data.entries;
          if (!Array.isArray(legacy)) throw new Error("Geçersiz veya desteklenmeyen yedek dosyası");
          incomingByCat[activeCat] = legacy;
        }
        var addedCount = 0, invalidCount = 0;
        CAT_ORDER.forEach(function (cat) {
          var incoming = incomingByCat[cat];
          if (!Array.isArray(incoming)) return;
          var map = {};
          catStore[cat].entries.forEach(function (e) { map[e.id] = e; });
          incoming.forEach(function (raw) {
            var row = normalizeEntry(raw, cat, true);
            if (!row) { invalidCount++; return; }
            if (!map[row.id]) {
              map[row.id] = row;
              catStore[cat].outbox.push({ type: "insert", row: row });
              addedCount++;
            }
          });
          catStore[cat].entries = Object.keys(map).map(function (id) { return map[id]; });
          catStore[cat].entries.sort(function (a, b) { return a.ts - b.ts; });
          saveCatCache(cat);
          saveCatOutbox(cat);
        });
        entries = catStore[activeCat].entries;
        outbox = catStore[activeCat].outbox;
        render();
        Promise.all(CAT_ORDER.map(function (cat) { return flushOutbox(cat); }));
        alert("Tam yedek içe aktarıldı. " + addedCount + " yeni kayıt eklendi" + (invalidCount ? ", " + invalidCount + " geçersiz kayıt atlandı." : "."));
      } catch (e) {
        alert("Dosya okunamadı: " + e.message);
      }
    };
    reader.readAsText(file);
  }

  function resetData() {
    var typed = prompt("Tüm kayıtlar (bulut dahil, Utku & Gözde ortak geçmişi) KALICI olarak silinecek.\nOnaylamak için büyük harflerle SIFIRLA yaz:");
    if (typed == null || typed.trim() !== "SIFIRLA") {
      if (typed != null) alert("Sıfırlama iptal edildi.");
      return;
    }
    if (sb.auth && el("authStatus")) {
      sb.auth.getSession().then(function (res) {
        var user = res.data && res.data.session && res.data.session.user;
        el("authStatus").textContent = user ? "Giriş açık · kullanıcı kimliği: " + user.id : "Bulut hesabında giriş açık değil.";
      });
    }
    var deleteCount = 0;
    CAT_ORDER.forEach(function (c) {
      var pendingInsertIds = {};
      catStore[c].outbox.forEach(function (op) {
        if (op.type === "insert" && op.row) pendingInsertIds[op.row.id] = true;
      });
      var deleteOps = [];
      catStore[c].entries.forEach(function (entry) {
        if (!pendingInsertIds[entry.id]) {
          deleteOps.push({ type: "delete", id: entry.id });
          deleteCount++;
        }
      });
      catStore[c].entries = [];
      catStore[c].outbox = deleteOps;
      saveCatCache(c);
      saveCatOutbox(c);
    });
    entries = catStore[activeCat].entries;
    outbox = catStore[activeCat].outbox;
    render();
    refreshStatus();
    if (!sb || !navigator.onLine) {
      alert(deleteCount + " bulut kaydı silme kuyruğuna alındı. İnternet gelince otomatik tamamlanacak.");
      return;
    }
    Promise.all(CAT_ORDER.map(function (cat) { return flushOutbox(cat); })).then(function () {
      var remaining = 0;
      CAT_ORDER.forEach(function (cat) { remaining += catStore[cat].outbox.length; });
      if (remaining) alert("Yerel kayıtlar temizlendi; " + remaining + " bulut silme işlemi yeniden denenecek.");
      else alert("Tüm kategoriler yerel ve bulut ortamından silindi.");
    });
  }

  // ---------- Theme ----------
  // Tema tercihi: "dark" | "light" | "auto". Auto sistemin koyu/açık ayarını izler.
  var themePref = "dark";
  function systemIsLight() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  }
  function applyTheme(theme) {
    themePref = theme === "light" || theme === "auto" ? theme : "dark";
    var light = themePref === "light" || (themePref === "auto" && systemIsLight());
    if (light) {
      document.documentElement.setAttribute("data-theme", "light");
      el("themeToggle").textContent = "☀️";
    } else {
      document.documentElement.removeAttribute("data-theme");
      el("themeToggle").textContent = "🌙";
    }
    var seg = document.getElementById("themeSeg");
    if (seg) {
      seg.querySelectorAll(".seg-btn").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-theme") === themePref);
      });
    }
  }

  function syncNow() {
    if (!sb) { alert("Bulut bağlı değil — yerel moddasın."); return; }
    if (!navigator.onLine) { alert("Çevrimdışısın. İnternet gelince otomatik senkronlanır."); return; }
    lastCloudError = null;
    refreshStatus();
    Promise.all(CAT_ORDER.map(function (cat) {
      return flushOutbox(cat).then(function () { return syncFromRemote(cat); });
    }))
      .then(function () {
        refreshStatus();
        if (lastCloudError) {
          alert("Bulut hatası:\n" + lastCloudError);
        } else {
          alert("Bulut senkronizasyonu başarılı! 🟢");
        }
      })
      .catch(function (err) {
        cloudError(err);
        alert("Bulut hatası: " + ((err && err.message) || String(err)));
      });
  }
  // Başlıktaki 🌙/☀️ düğmesi koyu ↔ açık arasında geçer (auto'yu kırar)
  function toggleTheme() {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    var next = light ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  var TAB_KEY = "dumanalti.tab";
  var closeAddDial = function () {}; // bindAddDial içinde atanır
  var openAddDial = function () {};
  function showTab(name) {
    var tabs = ["home", "history", "stats", "settings"];
    if (name === "portal") name = "home";
    if (name === "map") name = "stats";
    if (tabs.indexOf(name) === -1) name = "home";
    closeAddDial();
    tabs.forEach(function (n) {
      var v = el("view-" + n);
      if (v) v.classList.toggle("hidden", n !== name);
    });
    var picker = el("view-portal");
    if (picker) picker.classList.toggle("hidden", name !== "home");
    document.querySelectorAll(".tab").forEach(function (b) {
      var selected = b.getAttribute("data-tab") === name;
      b.classList.toggle("active", selected);
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.setAttribute("tabindex", selected ? "0" : "-1");
    });
    document.body.setAttribute("data-active-tab", name);
    try { localStorage.setItem(TAB_KEY, name); } catch (e) {}
    window.scrollTo(0, 0);
    
  }

  var leafletMap = null;
  var mapMarkers = [];

  function renderMap() {
    var container = el("mapContainer");
    if (!container) return;
    
    var hasCoords = entries.filter(function(e) { return typeof e.lat === "number" && typeof e.lng === "number"; });
    
    if (hasCoords.length === 0) {
      container.innerHTML = '<div class="map-empty"><div><strong>Henüz konumlu kayıt yok</strong><br>Konum izni verdikten sonra eklenen yeni kayıtlar burada görünecek.</div></div>';
      return;
    }
    
    if (!leafletMap) {
      if (typeof L === "undefined") return;
      var last = hasCoords[hasCoords.length - 1];
      container.innerHTML = ""; // Clear "henüz kayıt yok" text
      leafletMap = L.map("mapContainer").setView([last.lat, last.lng], 14);
      
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors',
        subdomains: 'abcd',
        maxZoom: 19
      }).addTo(leafletMap);
    }
    
    mapMarkers.forEach(function(m) { leafletMap.removeLayer(m); });
    mapMarkers = [];
    
    hasCoords.forEach(function(e) {
      var marker = L.circleMarker([e.lat, e.lng], {
        radius: 6,
        fillColor: (e.who === "utku" ? "#10b981" : (e.who === "gozde" ? "#f43f5e" : (e.who === "both" ? "#8b5cf6" : "#f59e0b"))),
        color: "#1e1e2d", // dark background color for stroke
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.8
      }).addTo(leafletMap);
      
      var dt = new Date(e.ts);
      var whoStr = e.who === "both" ? "Ortak" : (e.who === "hepberaber" ? "Hep Beraber" : (e.who === "utku" ? "Utku" : "Gözde"));
      marker.bindPopup("<b>" + whoStr + "</b><br>" + dt.toLocaleDateString() + " " + pad2(dt.getHours()) + ":" + pad2(dt.getMinutes()));
      mapMarkers.push(marker);
    });
    
    setTimeout(function() {
      if (leafletMap) leafletMap.invalidateSize();
    }, 100);
  }

  // Genişleyen global sigo-ekle butonu (tüm sayfalarda)
  function bindAddDial() {
    var dial = el("addDial"), fab = el("addFab");
    if (!dial || !fab) return;
    var scrim = null;
    function open() {
      dial.classList.add("open");
      fab.classList.remove("morph-pop");
      void fab.offsetWidth;
      fab.classList.add("morph-pop");
      var ub = el("undoBar"); if (ub) ub.classList.add("hidden"); // menü açılınca toast'ı kapat
      if (!scrim) {
        scrim = document.createElement("div");
        scrim.className = "add-scrim";
        document.body.appendChild(scrim);
        scrim.addEventListener(TAP_EVT, close);
        requestAnimationFrame(function () { if (scrim) scrim.classList.add("show"); });
      }
    }
    function close() {
      dial.classList.remove("open");
      fab.classList.remove("morph-pop");
      if (scrim) { var s = scrim; scrim = null; s.classList.remove("show"); setTimeout(function () { s.remove(); }, 200); }
    }
    closeAddDial = close;
    openAddDial = open;
    var lpTimer = null;
    function clearLp() {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    }
    fab.addEventListener(TAP_EVT, function (ev) {
      ev.stopPropagation();
      dial.classList.contains("open") ? close() : open();
      clearLp();
      lpTimer = setTimeout(function () {
        lpTimer = null;
        var quickWho = (settings && (settings.owner === "utku" || settings.owner === "gozde")) ? settings.owner : "both";
        var r = fab.getBoundingClientRect();
        close();
        fab.classList.remove("quick-shock");
        void fab.offsetWidth;
        fab.classList.add("quick-shock");
        setTimeout(function () { fab.classList.remove("quick-shock"); }, 500);
        addEntry(quickWho, r.left + r.width / 2, r.top + r.height / 2, selectedAddKind);
      }, 450);
    });
    fab.addEventListener("pointerup", clearLp);
    fab.addEventListener("pointercancel", clearLp);
    fab.addEventListener("pointerleave", clearLp);
    var kindBtns = dial.querySelectorAll(".add-kind-btn");
    kindBtns.forEach(function (b) {
      b.addEventListener(TAP_EVT, function (ev) {
        ev.stopPropagation();
        var k = b.getAttribute("data-kind");
        if (k && KINDS[k]) {
          selectedAddKind = k;
          var seg = b.parentElement;
          if (seg) {
            seg.querySelectorAll(".add-kind-btn").forEach(function (btn) { btn.classList.toggle("active", btn === b); });
          }
        }
      });
    });

    dial.querySelectorAll(".add-opt").forEach(function (bEl) {
      var b = /** @type {HTMLElement} */ (bEl);
      b.addEventListener(TAP_EVT, function () {
        if (b.dataset.lock === "1") return;
        var who = b.getAttribute("data-who");
        if (!who) return;
        b.dataset.lock = "1"; setTimeout(function () { b.dataset.lock = "0"; }, 350);
        b.classList.add("morph-tap");
        var r = b.getBoundingClientRect();
        setTimeout(function () {
          b.classList.remove("morph-tap");
          close();
          addEntry(who, r.left + r.width / 2, r.top + r.height / 2, selectedAddKind);
        }, 160);
      });
    });

  }

  // ---------- Init ----------
  function arrangeSettingsDom() {
    var view = el("view-settings");
    if (!view) return;
    [
      ".settings-owner-title", ".settings-owner",
      ".settings-appearance-title", ".settings-appearance",
      ".settings-sync-title", ".settings-sync",
      ".settings-security-title", ".settings-security",
      ".settings-fun-title", ".settings-fun",
      ".settings-data-title", ".settings-data",
      ".settings-about-title", ".settings-about", ".settings-profile"
    ].forEach(function (selector) {
      var node = view.querySelector(selector);
      if (node) view.appendChild(node);
    });
  }

  function hashPin(pin) {
    if (!window.crypto || !crypto.subtle) return Promise.resolve(btoa(pin));
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin)).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    });
  }

  function bytesToBase64(buf) {
    var bytes = new Uint8Array(buf), binary = "";
    bytes.forEach(function (b) { binary += String.fromCharCode(b); });
    return btoa(binary);
  }

  function base64ToBytes(value) {
    var binary = atob(value), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function showLockIfNeeded() {
    var lock = el("lockScreen"); if (!lock) return;
    var hasPin = !!localStorage.getItem(PIN_KEY);
    lock.classList.toggle("hidden", !hasPin);
    var bio = el("biometricUnlockBtn");
    if (bio) bio.classList.toggle("hidden", !localStorage.getItem(BIO_KEY));
  }

  function biometricUnlock() {
    var saved = localStorage.getItem(BIO_KEY);
    if (!saved || !navigator.credentials) return Promise.reject(new Error("Biyometri hazır değil"));
    var challenge = crypto.getRandomValues(new Uint8Array(32));
    return navigator.credentials.get({ publicKey: { challenge: challenge, timeout: 60000, userVerification: "required", allowCredentials: [{ id: base64ToBytes(saved), type: "public-key" }] } }).then(function () { el("lockScreen").classList.add("hidden"); });
  }

  function renderCustomBadgeSettings() {
    var box = el("customBadgeList"); if (!box) return;
    box.innerHTML = "";
    customBadges.forEach(function (badge) {
      var row = document.createElement("div"); row.className = "custom-badge-row";
      var span = document.createElement("span"); span.textContent = "⭐ " + badge.name + " · " + badge.target;
      var remove = document.createElement("button"); remove.className = "ghost-btn small"; remove.textContent = "Sil";
      remove.addEventListener("click", function () { customBadges = customBadges.filter(function (x) { return x.id !== badge.id; }); localStorage.setItem(BADGES_KEY, JSON.stringify(customBadges)); renderCustomBadgeSettings(); renderBadges(); });
      row.appendChild(span); row.appendChild(remove); box.appendChild(row);
    });
  }

  function initOnboarding() {
    var modal = el("onboarding"); if (!modal) return;
    if (!localStorage.getItem(ONBOARD_KEY) && settings.owner) localStorage.setItem(ONBOARD_KEY, "1");
    if (localStorage.getItem(ONBOARD_KEY)) return;
    modal.classList.remove("hidden");
    function show(n) { modal.querySelectorAll(".onboarding-step").forEach(function (x) { x.classList.toggle("hidden", Number(x.getAttribute("data-step")) !== n); }); }
    modal.querySelectorAll("[data-onboard-owner]").forEach(function (b) { b.addEventListener("click", function () { var owner = b.getAttribute("data-onboard-owner"); if (owner === "utku" || owner === "gozde") settings.owner = owner; saveSettings(); show(2); }); });
    el("onboardingFinish").addEventListener("click", function () {
      settings.locationEnabled = !!/** @type {HTMLInputElement} */ (el("onboardLocation")).checked; saveSettings(); localStorage.setItem(ONBOARD_KEY, "1"); modal.classList.add("hidden"); switchCat("sigo"); updateQuickActions(); if (settings.locationEnabled) fetchWeather();
    });
  }

  function bindFeaturePack() {
    if (el("sessionToggleBtn")) el("sessionToggleBtn").addEventListener("click", function () {
      activeSession = activeSession ? null : { id: uuid(), label: "Ortak oturum", startedAt: Date.now() };
      if (activeSession) localStorage.setItem(SESSION_KEY, JSON.stringify(activeSession)); else localStorage.removeItem(SESSION_KEY);
      renderSession();
    });

    document.querySelectorAll("#periodSwitcher .period-chip").forEach(function (b) {
      b.addEventListener("click", function () {
        comparisonPeriod = b.getAttribute("data-period") || "7";
        document.querySelectorAll("#periodSwitcher .period-chip").forEach(function (x) { x.classList.toggle("active", x === b); });
        el("periodCustom").classList.toggle("hidden", comparisonPeriod !== "custom"); renderPeriodComparison();
      });
    });
    if (el("periodApplyBtn")) el("periodApplyBtn").addEventListener("click", renderPeriodComparison);
    function applyHistoryDates() {
      var from = /** @type {HTMLInputElement} */ (el("historyFrom")), to = /** @type {HTMLInputElement} */ (el("historyTo"));
      historyFromTs = from.value ? new Date(from.value + "T04:00:00").getTime() : 0;
      historyToTs = to.value ? new Date(to.value + "T04:00:00").getTime() + 86400000 - 1 : Infinity;
      historyVisible = 30; renderHistory();
    }
    if (el("historyFrom")) el("historyFrom").addEventListener("change", applyHistoryDates);
    if (el("historyTo")) el("historyTo").addEventListener("change", applyHistoryDates);
    if (el("historyDateClear")) el("historyDateClear").addEventListener("click", function () { /** @type {HTMLInputElement} */ (el("historyFrom")).value = ""; /** @type {HTMLInputElement} */ (el("historyTo")).value = ""; applyHistoryDates(); });
    if (el("trashToggleBtn")) el("trashToggleBtn").addEventListener("click", function () { el("trashList").classList.toggle("hidden"); renderTrash(); });
    if (el("syncCenterBtn")) el("syncCenterBtn").addEventListener("click", function () { el("syncCenter").classList.toggle("hidden"); renderSyncCenter(); });
    if (el("shareWrappedBtn")) el("shareWrappedBtn").addEventListener("click", shareWrappedImage);
    if (el("backupReminderBtn")) el("backupReminderBtn").addEventListener("click", exportData);
    if (el("backupDismissBtn")) el("backupDismissBtn").addEventListener("click", function () { localStorage.setItem(BACKUP_KEY, String(Date.now())); renderBackupReminder(); });

    var locationSetting = /** @type {HTMLInputElement} */ (el("locationSetting"));
    if (locationSetting) { locationSetting.checked = settings.locationEnabled; locationSetting.addEventListener("change", function () { settings.locationEnabled = locationSetting.checked; saveSettings(); if (settings.locationEnabled) fetchWeather(); }); }
    if (el("customBadgeAddBtn")) el("customBadgeAddBtn").addEventListener("click", function () {
      var nameInput = /** @type {HTMLInputElement} */ (el("customBadgeName")), targetInput = /** @type {HTMLInputElement} */ (el("customBadgeTarget"));
      var name = nameInput.value.trim(), target = Number(targetInput.value);
      if (!name || !target || target < 1) { alert("Rozet adı ve geçerli bir hedef gir."); return; }
      customBadges.push({ id: uuid(), name: name, target: target }); localStorage.setItem(BADGES_KEY, JSON.stringify(customBadges)); nameInput.value = ""; renderCustomBadgeSettings(); renderBadges();
    });
    renderCustomBadgeSettings();

    if (el("quickEditWhoBtn")) el("quickEditWhoBtn").addEventListener("click", function () {
      if (!lastUndo) return; var order = ["utku", "gozde", "both", "hepberaber"];
      var next = order[(order.indexOf(lastUndo.who) + 1) % order.length]; patchEntry(lastUndo.id, { who: next }); lastUndo.who = next; render();
    });
    if (el("quickEditKindBtn")) el("quickEditKindBtn").addEventListener("click", function () {
      if (!lastUndo) return; var order = Object.keys(KINDS);
      var next = order[(order.indexOf(entryKind(lastUndo)) + 1) % order.length]; patchEntry(lastUndo.id, { kind: next }); lastUndo.kind = next; render();
    });

    if (el("pinSetupBtn")) el("pinSetupBtn").addEventListener("click", function () {
      if (localStorage.getItem(PIN_KEY) && confirm("Bu cihazdaki PIN kilidi kaldırılsın mı?")) { localStorage.removeItem(PIN_KEY); el("pinSetupBtn").textContent = "PIN oluştur"; return; }
      var pin = prompt("4-6 haneli bir PIN belirle:"); if (!/^\d{4,6}$/.test(pin || "")) { if (pin !== null) alert("PIN 4-6 rakam olmalı."); return; }
      hashPin(pin).then(function (hash) { localStorage.setItem(PIN_KEY, hash); el("pinSetupBtn").textContent = "PIN'i kaldır"; alert("PIN kilidi etkinleştirildi."); });
    });
    if (localStorage.getItem(PIN_KEY) && el("pinSetupBtn")) el("pinSetupBtn").textContent = "PIN'i kaldır";
    if (el("pinUnlockBtn")) el("pinUnlockBtn").addEventListener("click", function () { var value = /** @type {HTMLInputElement} */ (el("pinUnlockInput")).value; hashPin(value).then(function (hash) { if (hash === localStorage.getItem(PIN_KEY)) el("lockScreen").classList.add("hidden"); else el("lockError").textContent = "PIN yanlış."; }); });
    if (el("biometricUnlockBtn")) el("biometricUnlockBtn").addEventListener("click", function () { biometricUnlock().catch(function () { el("lockError").textContent = "Biyometrik doğrulama tamamlanamadı."; }); });
    if (el("biometricSetupBtn")) el("biometricSetupBtn").addEventListener("click", function () {
      if (!navigator.credentials || !window.PublicKeyCredential) { alert("Bu cihaz biyometrik web kilidini desteklemiyor."); return; }
      var challenge = crypto.getRandomValues(new Uint8Array(32)), userId = new TextEncoder().encode(settings.owner || "dumanalti-user");
      navigator.credentials.create({ publicKey: { challenge: challenge, rp: { name: "Dumanaltı" }, user: { id: userId, name: settings.owner || "kullanici", displayName: settings.owner || "Dumanaltı" }, pubKeyCredParams: [{ alg: -7, type: "public-key" }], authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" }, timeout: 60000 } }).then(function (cred) { localStorage.setItem(BIO_KEY, bytesToBase64(/** @type {PublicKeyCredential} */ (cred).rawId)); el("biometricSetupBtn").textContent = "Etkin"; }).catch(function () { alert("Biyometrik kayıt tamamlanamadı."); });
    });
    if (localStorage.getItem(BIO_KEY) && el("biometricSetupBtn")) el("biometricSetupBtn").textContent = "Etkin";

    if (el("authEmailBtn")) el("authEmailBtn").addEventListener("click", function () {
      var email = /** @type {HTMLInputElement} */ (el("authEmailInput")).value.trim(); if (!email || !sb) { alert("Geçerli e-posta gir ve bulut bağlantısını kontrol et."); return; }
      sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (res) { el("authStatus").textContent = res.error ? res.error.message : "Giriş bağlantısı e-postana gönderildi."; });
    });

  }

  function bind() {
    arrangeSettingsDom();
    bindFeaturePack();
    // Sigo ekleme artık her sayfadaki genişleyen '+' butonundan (bindAddDial)

    // Geri al dokunma anında tepki versin (click parmak kalkınca ateşlenir)
    el("undoBtn").addEventListener(TAP_EVT, undoLast);
    el("themeToggle").addEventListener(TAP_EVT, toggleTheme);
    el("exportBtn").addEventListener("click", exportData);
    el("importBtn").addEventListener("click", function () { el("importFile").click(); });
    el("importFile").addEventListener("change", function (e) {
      var input = /** @type {HTMLInputElement} */ (e.target);
      if (input.files && input.files[0]) importData(input.files[0]);
      input.value = "";
    });
    el("resetBtn").addEventListener("click", resetData);

    // Sekmeler: sabit çubukta kaydırma riski yok, dokunma anında geçiş yap
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener(TAP_EVT, function () {
        showTab(btn.getAttribute("data-tab"));
      });
    });
    showTab(localStorage.getItem(TAB_KEY) || "home");

    // Bugün ekranındaki kategori seçici.
    document.querySelectorAll(".portal-card").forEach(function (btn) {
      btn.addEventListener(TAP_EVT, function () {
        var cat = btn.getAttribute("data-cat");
        if (cat) {
          switchCat(cat);
        }
      });
    });

    var historySearch = el("historySearch");
    if (historySearch) historySearch.addEventListener("input", function () {
      historyQuery = (/** @type {HTMLInputElement} */ (historySearch)).value.trim().toLocaleLowerCase("tr-TR");
      historyVisible = 30;
      renderHistory();
    });
    var historyMore = el("historyMoreBtn");
    if (historyMore) historyMore.addEventListener("click", function () {
      historyVisible += 30;
      renderHistory();
    });

    // Geçmiş kişi filtreleri
    document.querySelectorAll("#histFilters .hist-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        historyFilter = chip.getAttribute("data-f");
        historyVisible = 30;
        document.querySelectorAll("#histFilters .hist-chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
        renderHistory();
      });
    });

    // Geçmiş tür filtreleri (Sigo vs Bong)
    document.querySelectorAll("#histKindFilters .hist-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        historyKind = chip.getAttribute("data-kf");
        historyVisible = 30;
        document.querySelectorAll("#histKindFilters .hist-chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
        renderHistory();
      });
    });

    // İstatistik kişi filtreleri
    document.querySelectorAll(".scope-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        statsScope = chip.getAttribute("data-scope");
        document.querySelectorAll(".scope-chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
        var toggle = el("scopeToggle");
        if (toggle) toggle.classList.toggle("hidden", statsScope !== "gozde" && statsScope !== "utku");
        renderStats(); // tüm uygulamayı değil, sadece görünen istatistikleri çiz
      });
    });

    // İstatistik tür filtreleri (Sigo vs Bong)
    document.querySelectorAll(".kind-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        statsKind = chip.getAttribute("data-kind-scope");
        document.querySelectorAll(".kind-chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
        renderStats();
      });
    });

    // Gözde/Utku seçiliyken: ortak sigoyu dahil et/etme
    document.querySelectorAll("#scopeToggle .seg-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        scopeIncludeBoth = b.getAttribute("data-include") === "yes";
        document.querySelectorAll("#scopeToggle .seg-btn").forEach(function (x) { x.classList.toggle("active", x === b); });
        renderStats();
      });
    });

    document.querySelectorAll(".analysis-switch").forEach(function (button) {
      button.addEventListener(TAP_EVT, function () {
        var section = button.getAttribute("data-analysis") || "summary";
        document.querySelectorAll(".analysis-switch").forEach(function (b) {
          var selected = b === button;
          b.classList.toggle("active", selected);
          b.setAttribute("aria-selected", selected ? "true" : "false");
        });
        document.querySelectorAll(".analysis-section").forEach(function (panel) {
          panel.classList.toggle("hidden", panel.id !== "analysis-" + section);
        });
        if (section === "fun") setTimeout(renderMap, 50);
      });
    });

    // Segment düğmesi yardımcısı: bir gruptaki aktif düğmeyi işaretle, seçilince çalıştır
    function bindSeg(segId, attr, current, onPick) {
      var seg = el(segId);
      if (!seg) return;
      seg.querySelectorAll(".seg-btn").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute(attr) === current);
        b.addEventListener(TAP_EVT, function () {
          var v = b.getAttribute(attr);
          seg.querySelectorAll(".seg-btn").forEach(function (x) { x.classList.toggle("active", x === b); });
          onPick(v);
        });
      });
    }

    // Tema seçici (auto/dark/light)
    bindSeg("themeSeg", "data-theme", themePref, function (t) {
      localStorage.setItem(THEME_KEY, t);
      applyTheme(t);
    });

    // Kutlama efekti (tam/sade/kapalı)
    bindSeg("confettiSeg", "data-confetti", settings.confetti, function (v) {
      settings.confetti = v; saveSettings();
    });

    // Ses efekti (açık/kapalı) — iOS'ta dokunsal yerine minik pop sesi
    bindSeg("soundSeg", "data-sound", settings.sound, function (v) {
      settings.sound = v; saveSettings();
      if (v === "on") playPop(1); // açarken örnek ses
    });

    // Cihaz sahibi (adla selamlama)
    bindSeg("ownerSeg", "data-owner", settings.owner, function (v) {
      settings.owner = v; saveSettings(); updateQuickActions();
    });



    if (el("syncNowBtn")) el("syncNowBtn").addEventListener(TAP_EVT, syncNow);
    if (el("exportCsvBtn")) el("exportCsvBtn").addEventListener("click", exportCsv);


    bindAddDial();
    updateQuickActions();
    function quickKind() {
      return KINDS[selectedAddKind] ? selectedAddKind : "sigo";
    }
    function addQuick(who, source) {
      var rect = source.getBoundingClientRect();
      var kind = quickKind();
      addEntry(who, rect.left + rect.width / 2, rect.top + rect.height / 2, kind);
    }
    var quickMe = el("quickMeBtn");
    if (quickMe) quickMe.addEventListener(TAP_EVT, function () {
      if (!settings.owner) { openAddDial(); return; }
      addQuick(settings.owner, quickMe);
    });
    var quickTogether = el("quickTogetherBtn");
    if (quickTogether) quickTogether.addEventListener(TAP_EVT, function () {
      addQuick("both", quickTogether);
    });
    var quickMore = el("quickMoreBtn");
    if (quickMore) quickMore.addEventListener(TAP_EVT, openAddDial);
    // Bilgiler kartı açılır-kapanır (durum kalıcı)
    var insHead = el("insightsHead");
    if (insHead) {
      var insCard = el("insights");
      var open = localStorage.getItem("dumanalti.insightsOpen") !== "0";
      insCard.classList.toggle("collapsed", !open);
      insHead.setAttribute("aria-expanded", open ? "true" : "false");
      insHead.addEventListener(TAP_EVT, function () {
        var nowOpen = insCard.classList.contains("collapsed");
        insCard.classList.toggle("collapsed", !nowOpen);
        insHead.setAttribute("aria-expanded", nowOpen ? "true" : "false");
        try { localStorage.setItem("dumanalti.insightsOpen", nowOpen ? "1" : "0"); } catch (e) {}
      });
    }

    // Scroll-hide: aşağı kaydırınca FAB'lar gizlensin, yukarı kaydırınca geri gelsin
    (function () {
      var lastY = window.pageYOffset || 0;
      var hidden = false;
      var dial = el("addDial");
      var threshold = 12; // px – küçük titreşimleri görmezden gel
      window.addEventListener("scroll", function () {
        var y = window.pageYOffset || 0;
        var delta = y - lastY;
        if (delta > threshold && !hidden && y > 60) {
          hidden = true;
          if (dial) dial.classList.add("fab-hidden");
        } else if (delta < -threshold || y < 30) {
          if (hidden) {
            hidden = false;
            if (dial) dial.classList.remove("fab-hidden");
          }
        }
        lastY = y;
      }, { passive: true });
    })();

    setInterval(function () { renderToday(); }, 60000);
    setInterval(function () { renderSince(); }, 1000);
  }

  // Hızlı ekleme bağlantısını panoya kopyala (iOS Kısayollar / yer imi için)
  function copyQuickLink(who, btn) {
    var url = location.origin + location.pathname + "?add=" + who;
    var done = function () {
      var old = btn.textContent;
      btn.textContent = "✓ Kopyalandı";
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { prompt("Bağlantı:", url); });
    } else { prompt("Bağlantı:", url); }
  }

  // Kayıtları CSV olarak dışa aktar (Excel/Numbers'ta açılır)
  function exportCsv() {
    function csvCell(value) {
      return '"' + String(value === undefined || value === null ? "" : value).replace(/"/g, '""') + '"';
    }
    var rows = ["kategori,tarih,saat,kisi,tur,etiket,mantiksal_gun,enlem,boylam"];
    CAT_ORDER.forEach(function (cat) {
      catStore[cat].entries.forEach(function (e) {
        var d = new Date(e.ts);
        var tarih = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
        rows.push([
          cat, tarih, formatTime(e.ts), WHO[e.who].label, e.kind || "", e.tag || "",
          dayKey(e.ts), e.lat, e.lng
        ].map(csvCell).join(","));
      });
    });
    var blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "dumanalti-" + dayKey(Date.now()) + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleQuickAction() {
    // iOS Kısayollar uygulaması veya bir yer iminden ?add=utku|gozde|both|hepberaber
    // ile açılırsa uygulamayı açar açmaz o kaydı ekler.
    var who = new URLSearchParams(window.location.search).get("add");
    if (!WHO[who]) return;
    history.replaceState(null, "", window.location.pathname);
    addEntry(who);
  }

  function fetchWeather() {
    var CACHE_KEY = "dumanalti.weather";
    var CACHE_TTL = 30 * 60 * 1000; // 30 minutes
    var cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        var data = JSON.parse(cached);
        if (Date.now() - data.ts < CACHE_TTL) {
          if (typeof data.lat === "number" && typeof data.lng === "number") {
            lastKnownLocation = { lat: data.lat, lng: data.lng };
          }
          updateWeatherUI(data.temp, data.code);
          return;
        }
      } catch (e) {}
    }

    function getWeather(lat, lon, rememberLocation) {
      var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current_weather=true";
      fetch(url).then(function (res) { return res.json(); }).then(function (data) {
        if (data && data.current_weather) {
          var w = data.current_weather;
          var cacheData = { temp: w.temperature, code: w.weathercode, ts: Date.now() };
          if (rememberLocation) {
            lastKnownLocation = { lat: lat, lng: lon };
            cacheData.lat = lat;
            cacheData.lng = lon;
          }
          updateWeatherUI(w.temperature, w.weathercode);
          localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
        }
      }).catch(function () {});
    }

    if (settings.locationEnabled && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function (pos) { getWeather(pos.coords.latitude, pos.coords.longitude, true); },
        function () { getWeather(41.01, 28.97, false); }, // Fallback Istanbul
        { timeout: 5000 }
      );
    } else {
      getWeather(41.01, 28.97, false); // Fallback Istanbul
    }
  }

  function updateWeatherUI(temp, code) {
    var elTemp = el("weatherTemp");
    var elIcon = el("weatherIcon");
    if (elTemp) elTemp.textContent = Math.round(temp) + "°";
    if (elIcon) {
      // WMO Weather interpretation codes
      var icon = "☁️";
      if (code === 0) icon = "☀️";
      else if (code >= 1 && code <= 3) icon = "⛅";
      else if (code >= 45 && code <= 48) icon = "🌫️";
      else if (code >= 51 && code <= 67) icon = "🌧️";
      else if (code >= 71 && code <= 77) icon = "❄️";
      else if (code >= 80 && code <= 82) icon = "🌦️";
      else if (code >= 95 && code <= 99) icon = "⛈️";
      elIcon.textContent = icon;
    }
  }

  function initPortalWidgets() {
    function tick() {
      var now = new Date();
      var elTime = el("portalTime");
      var elDate = el("portalDate");
      if (elTime) elTime.textContent = ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
      if (elDate) {
        var days = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
        var months = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
        elDate.textContent = now.getDate() + " " + months[now.getMonth()] + " " + now.getFullYear() + ", " + days[now.getDay()];
      }
    }
    tick();
    setInterval(tick, 60000); // update every minute
    fetchWeather();
  }

  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  // Auto modda sistem teması değişince anında uygula
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var onSys = function () { if (themePref === "auto") applyTheme("auto"); };
    if (mq.addEventListener) mq.addEventListener("change", onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }
  el("appVersion").textContent = "v" + APP_VERSION + " · derleme " + APP_BUILD;
  loadSettings();
  loadCache();
  document.body.setAttribute("data-cat", activeCat);
  bind();
  initOnboarding();
  purgeTrash();
  showLockIfNeeded();
  render();
  initPortalWidgets();
  handleQuickAction();
  refreshStatus();
  initCloud();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("service-worker.js").catch(function (e) {
        console.warn("SW kaydı başarısız", e);
      });
    });
  }

  // Expose internals for testing
  if (typeof window !== "undefined") {
    window.DUMANALTI_TEST_EXPORTS = {
      isShared: isShared,
      entryKind: entryKind,
      countKinds: countKinds,
      logicalDate: logicalDate,
      startOfDay: startOfDay,
      dayKey: dayKey,
      isSameDay: isSameDay,
      startOfMonth: startOfMonth,
      startOfWeek: startOfWeek,
      formatTime: formatTime,
      relativeTime: relativeTime,
      countWho: countWho,
      scopedEntries: scopedEntries,
      entriesSince: entriesSince,
      todayEntries: todayEntries,
      breakdownText: breakdownText,
      longestCleanStreak: longestCleanStreak,
      computeBadges: computeBadges,
      entries: function () { return entries; },
      setEntries: function (val) { entries = val; },
      outbox: function () { return outbox; },
      setOutbox: function (val) { outbox = val; },
      selectedAddKind: function () { return selectedAddKind; },
      setSelectedAddKind: function (k) { selectedAddKind = k; },
      statsKind: function () { return statsKind; },
      setStatsKind: function (k) { statsKind = k; },
      setHistoryKind: function (k) { historyKind = k; },
      settings: settings,
      saveCache: saveCache,
      loadCache: loadCache,
      render: render,
      addEntry: addEntry,
      deleteEntry: deleteEntry,
      updateEntry: updateEntry,
      normalizeEntry: normalizeEntry
    };
  }
})();
