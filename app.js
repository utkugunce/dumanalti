// @ts-check
/* Dumanaltı — Utku & Gözde sigo takip PWA
   Veriler Supabase'de bulutta tutulur ve cihazlar arasında gerçek zamanlı
   senkronlanır. Çevrimdışıyken yerel önbellekten okunur, internet gelince
   bekleyen kayıtlar otomatik gönderilir. */

(function () {
  "use strict";

  // Semver: majör = büyük yeniden tasarım, minör = yeni özellik, patch = ince ayar.
  // Derleme numarası service worker önbellek sürümüyle (her dağıtımda artar) aynı.
  var APP_VERSION = "6.7.5";
  var APP_BUILD = 132;

  var THEME_KEY = "dumanalti.theme";
  var SETTINGS_KEY = "dumanalti.settings.v1";

  var CFG = window.DUMANALTI_CONFIG || {};

  // Türkiye'de çok tüketilen bira markaları
  var BEER_BRANDS = [
    { id: "efes_pilsen", label: "Efes Pilsen" },
    { id: "efes_malt", label: "Efes Malt" },
    { id: "tuborg_gold", label: "Tuborg Gold" },
    { id: "tuborg_filtresiz", label: "Tuborg Filtresiz" },
    { id: "bomonti", label: "Bomonti" },
    { id: "carlsberg", label: "Carlsberg" },
    { id: "miller", label: "Miller" },
    { id: "beck_s", label: "Beck's" },
    { id: "heineken", label: "Heineken" },
    { id: "corona", label: "Corona" },
    { id: "bremen", label: "Bremen" }
  ];

  var BEER_SIZES = [
    { id: "50cl", label: "50 cl (Şişe)", factor: 1.0 },
    { id: "33cl", label: "33 cl (Küçük)", factor: 0.66 }
  ];

  // ---------- Çoklu kategori tanımları ----------
  var CATS = {
    sigo:   { label: "Sigo",   emoji: "🚬", table: CFG.table || "dumanalti_entries", cacheKey: "dumanalti.entries.v1", outboxKey: "dumanalti.outbox.v1", unit: "sigo", unitPlural: "sigo" },
    sigara: { label: "Sigara", emoji: "🚬", table: "dumanalti_sigara",               cacheKey: "dumanalti.sigara.v1", outboxKey: "dumanalti.sigara_outbox.v1", unit: "sigara", unitPlural: "sigara" },
    bira:   { label: "Bira",   emoji: "🍺", table: "dumanalti_bira",                 cacheKey: "dumanalti.bira.v1",   outboxKey: "dumanalti.bira_outbox.v1",   unit: "şişe bira", unitPlural: "şişe bira" }
  };
  var CAT_ORDER = ["sigo", "sigara", "bira"];
  var activeCat = "sigo";

  // Her kategorinin kendi veri deposu
  var catStore = {};
  CAT_ORDER.forEach(function (c) {
    catStore[c] = { entries: [], outbox: [] };
  });

  var WHO = {
    utku:  { label: "Utku", emoji: "🧔", avatar: "icons/avatar-utku.png", cls: "utku-bg" },
    gozde: { label: "Gözde", emoji: "👩", avatar: "icons/avatar-gozde.png", cls: "gozde-bg" },
    both:  { label: "Ortak", emoji: "👩‍❤️‍👨", avatar: "icons/avatar-both.png", cls: "both-bg" },
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
  var settings = { dailyLimit: 0, confetti: "full", owner: "", mascot: "on", sound: "off", waPhone: "", callApp: "telegram", tgUser: "", tgBotToken: "", tgChatId: "" };

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
  var editingId = null; // Geçmişte düzenleme paneli açık olan kaydın id'si
  var statsScope = "all"; // İstatistik kişi filtresi: all | both | hepberaber | gozde | utku
  var statsKind = "all"; // İstatistik tür filtresi: all | sigo | bong
  var scopeIncludeBoth = true; // Gözde/Utku seçiliyken ortak/beraber içilenler dahil mi

  // Aktif kategoriyi değiştir: entries/outbox alias'larını güncelle, UI'ı yeniden çiz
  function switchCat(cat) {
    if (!CATS[cat]) return;
    // Mevcut veriyi depoya geri kaydet
    catStore[activeCat].entries = entries;
    catStore[activeCat].outbox = outbox;
    activeCat = cat;
    entries = catStore[cat].entries;
    outbox = catStore[cat].outbox;
    // Body data-cat özniteliğini güncelle (CSS tema vurgu renkleri için)
    document.body.setAttribute("data-cat", cat);
    // Sigo/bong tür seçicisini sadece sigo kategorisinde göster
    var kindSeg = el("addKindSeg");
    if (kindSeg) kindSeg.style.display = cat === "sigo" ? "" : "none";
    // Ortak ve Hep beraber seçeneklerini sadece Sigo kategorisinde göster (Sigara ve Bira için sadece Utku ve Gözde)
    document.querySelectorAll(".add-opt[data-who='both'], .add-opt[data-who='hepberaber']").forEach(function (b) {
      /** @type {HTMLElement} */ (b).style.display = cat === "sigo" ? "" : "none";
    });
    // Bugün kartında Ortak ve Hep beraber satırlarını gizle/göster
    var duoBoth = document.querySelector(".duo-row:has(#todayBoth)");
    if (!duoBoth) {
      // Browser compatibility fallback for :has
      var elBoth = el("todayBoth");
      if (elBoth && elBoth.parentElement) duoBoth = elBoth.parentElement;
    }
    if (duoBoth) /** @type {HTMLElement} */ (duoBoth).style.display = cat === "sigo" ? "" : "none";

    var duoHep = document.querySelector(".duo-row:has(#todayHepberaber)");
    if (!duoHep) {
      var elHep = el("todayHepberaber");
      if (elHep && elHep.parentElement) duoHep = elHep.parentElement;
    }
    if (duoHep) /** @type {HTMLElement} */ (duoHep).style.display = cat === "sigo" ? "" : "none";

    var beerWrap = el("beerOptWrap");
    if (beerWrap) beerWrap.classList.toggle("hidden", cat !== "bira");

    applyMascot();
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
  var realtimeChannel = null;
  var onlineUsers = {};

  function playChime() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {}
  }

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

  function showCallToast(whoLabel) {
    playChime();
    var t = el("callToast");
    var title = el("callToastTitle");
    var sub = el("callToastSub");
    if (!t || !title || !sub) return;
    title.textContent = "🛋️ Oturma Odası Molası!";
    sub.textContent = (whoLabel || "Biri") + " seni oturma odasına çağırıyor 🚬";
    t.classList.remove("hidden");
    var dis = el("callToastDismiss");
    if (dis) {
      dis.onclick = function () { t.classList.add("hidden"); };
    }
    setTimeout(function () {
      if (t) t.classList.add("hidden");
    }, 10000);
  }

  function showNoticeToast(msg) {
    var t = el("callToast");
    var title = el("callToastTitle");
    var sub = el("callToastSub");
    if (!t || !title || !sub) { alert(msg); return; }
    title.textContent = "✈️ Telegram Bildirimi";
    sub.textContent = msg;
    t.classList.remove("hidden");
    setTimeout(function () { if (t) t.classList.add("hidden"); }, 5000);
  }

  function sendBalkonCall() {
    var myLabel = settings.owner === "utku" ? "Utku" : (settings.owner === "gozde" ? "Gözde" : "Partnerin");
    showCallToast(myLabel);
    if (realtimeChannel) {
      realtimeChannel.send({
        type: "broadcast",
        event: "balkon_call",
        payload: { who: myLabel, ts: Date.now() }
      });
    }

    var text = "Hadi sigo içelim!";
    var token = (settings.tgBotToken || "").trim();
    var chatId = (settings.tgChatId || "").trim();

    if (token && chatId) {
      var url = "https://api.telegram.org/bot" + encodeURIComponent(token) +
                "/sendMessage?chat_id=" + encodeURIComponent(chatId) +
                "&text=" + encodeURIComponent(text);
      fetch(url)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.ok) {
            showNoticeToast("✈️ Telegram bildirimi gönderildi!");
          } else {
            var errStr = (data && data.description) || "Bilinmeyen hata";
            showNoticeToast("⚠️ Telegram: " + errStr);
          }
        })
        .catch(function () {
          showNoticeToast("⚠️ Telegram sunucusuna ulaşılamadı");
        });
      return;
    }

    showNoticeToast("📢 Bildirim için Ayarlar'dan Telegram Bot Token girin!");
    var fallbackUrl = "https://t.me/share/url?text=" + encodeURIComponent(text);
    setTimeout(function () { window.location.href = fallbackUrl; }, 1200);
  }

  function testTgBot() {
    var token = (settings.tgBotToken || "").trim();
    var chatId = (settings.tgChatId || "").trim();
    if (!token || !chatId) {
      alert("Lütfen önce Telegram Bot Token ve Chat ID alanlarını doldurun.");
      return;
    }
    var url = "https://api.telegram.org/bot" + encodeURIComponent(token) +
              "/sendMessage?chat_id=" + encodeURIComponent(chatId) +
              "&text=" + encodeURIComponent("🧪 Dumanaltı test bildirimi başarılı!");

    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok) {
          alert("✅ BAŞARILI! Telegram botu mesajı iletti.");
        } else {
          alert("❌ HATA: Telegram şu yanıtı döndü:\n" + ((data && data.description) || JSON.stringify(data)));
        }
      })
      .catch(function (err) {
        alert("❌ BAĞLANTI HATASI: " + (err.message || String(err)));
      });
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
    if (!navigator.onLine) {
      info.textContent = "Durum: Çevrimdışı (İnternet yok) 📴";
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
    var totalOutbox = 0;
    CAT_ORDER.forEach(function (c) { totalOutbox += catStore[c].outbox.length; });
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
        catStore[c].entries = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(catStore[c].entries)) catStore[c].entries = [];
        catStore[c].entries.sort(function (a, b) { return a.ts - b.ts; });
      } catch (e) { catStore[c].entries = []; }
      try {
        var ob = localStorage.getItem(cfg.outboxKey);
        catStore[c].outbox = ob ? JSON.parse(ob) : [];
        if (!Array.isArray(catStore[c].outbox)) catStore[c].outbox = [];
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
        settings.mascot = s.mascot === "off" ? "off" : "on";
        settings.sound = s.sound === "on" ? "on" : "off";
        settings.waPhone = typeof s.waPhone === "string" ? s.waPhone : "";
        settings.callApp = s.callApp === "whatsapp" ? "whatsapp" : "telegram";
        settings.tgUser = typeof s.tgUser === "string" ? s.tgUser : "";
        settings.tgBotToken = typeof s.tgBotToken === "string" ? s.tgBotToken : "";
        settings.tgChatId = typeof s.tgChatId === "string" ? s.tgChatId : "";

      }
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
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
    if (hr < 24) return hr + " sa önce";
    var day = Math.floor(hr / 24);
    if (day === 1) return "dün";
    return day + " gün önce";
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
    refreshAsst();
    if (el("setCount")) el("setCount").textContent = String(entries.length);
    if (el("profileSub")) {
      var days = entries.length ? Math.round((startOfDay(Date.now()).getTime() - startOfDay(entries[0].ts).getTime()) / 86400000) + 1 : 0;
      el("profileSub").textContent = entries.length + " kayıt · " + days + " gün takip";
    }
  }



  function renderToday() {
    var tEnts = todayEntries();
    var t = countWho(tEnts);
    var tk = countKinds(tEnts);
    el("todayUtku").textContent = String(t.utku + t.both + t.hepberaber);
    el("todayGozde").textContent = String(t.gozde + t.both + t.hepberaber);
    el("todayBoth").textContent = String(t.both);
    el("todayHepberaber").textContent = String(t.hepberaber);
    el("todayTotal").textContent = String(t.total);

    // Tarih çipi mantıksal günü gösterir; 04:00 öncesi 🌙 ile "gece devam ediyor"
    var now = new Date();
    var dayRef = logicalDate(now);
    el("todayDate").textContent =
      ("0" + dayRef.getDate()).slice(-2) + "." + ("0" + (dayRef.getMonth() + 1)).slice(-2) + "." + dayRef.getFullYear() +
      (now.getHours() < DAY_START_HOUR ? " 🌙" : "");

    // Dün bu saate kadar içilenle kıyasla: azsa yeşil, fazlaysa kırmızı rozet
    var yStart = startOfDay(now).getTime() - 86400000;
    var yCut = now.getTime() - 86400000;
    var ySame = entries.filter(function (e) { return e.ts >= yStart && e.ts <= yCut; }).length;
    var trend = el("todayTrend");
    var diff = t.total - ySame;
    trend.classList.remove("up", "down");
    if (diff > 0) { trend.classList.add("up"); trend.textContent = "▲ " + diff; }
    else if (diff < 0) { trend.classList.add("down"); trend.textContent = "▼ " + (-diff); }
    else { trend.textContent = "＝"; }

    var catInfo = CATS[activeCat] || CATS.sigo;
    var kindText = activeCat === "sigo"
      ? "(" + tk.sigo + " sigo · " + tk.bong + " bong) · "
      : "";
    el("todayHeroSub").textContent = "toplam " + catInfo.unit + " " + kindText + "· dün bu saatte " + ySame;

    renderTodayFlow();

    var lastLbl = el("lastRowLabel");
    if (lastLbl) lastLbl.textContent = "Son " + catInfo.unit + ":";

    var lastSmoke = el("lastSmoke");
    lastSmoke.innerHTML = "";
    if (entries.length) {
      var last = entries[entries.length - 1];
      lastSmoke.appendChild(makeAvatar(last.who, "avatar-sm"));
      var extraText = "";
      if (activeCat === "sigo") {
        extraText = " (" + (KINDS[entryKind(last)] || KINDS.sigo).emoji + " " + (KINDS[entryKind(last)] || KINDS.sigo).label + ")";
      } else if (activeCat === "bira" && last.tag) {
        var parts = last.tag.split(":");
        var brandObj = BEER_BRANDS.filter(function (b) { return b.id === parts[0]; })[0];
        var brandLabel = brandObj ? brandObj.label : parts[0];
        var sizeLabel = parts[1] || "";
        extraText = " (" + brandLabel + (sizeLabel ? " · " + sizeLabel : "") + ")";
      }
      lastSmoke.appendChild(document.createTextNode(" " + WHO[last.who].label + extraText + " · " + formatTime(last.ts) + " · " + relativeTime(last.ts)));
    } else {
      lastSmoke.textContent = "Henüz kayıt yok";
    }
  }

  function renderPortalSummaries() {
    var now = Date.now();
    var allEntries = [];
    ["sigo", "sigara", "bira"].forEach(function (cat) {
      if (!catStore[cat]) return;
      allEntries = allEntries.concat(catStore[cat].entries.map(function(e) { e._cat = cat; return e; }));
      var elCount = el("portal" + cat.charAt(0).toUpperCase() + cat.slice(1) + "Count");
      if (elCount) {
        var todayCount = catStore[cat].entries.filter(function (e) { return isSameDay(e.ts, now); }).length;
        elCount.textContent = "Bugün: " + todayCount;
      }
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
      var catName = last._cat === "sigo" ? "Sigo" : last._cat === "sigara" ? "Sigara" : "Bira";
      plaTime.textContent = formatTime(last.ts);
      plaDesc.innerHTML = "<b>" + WHO[last.who].label + "</b> az önce bir " + catName + " yaktı (" + relativeTime(last.ts) + ")";
      if (last._cat === "bira") plaDesc.innerHTML = "<b>" + WHO[last.who].label + "</b> az önce bir " + catName + " açtı (" + relativeTime(last.ts) + ")";
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
    todayEntries().forEach(function (e) {
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

  function historyItem(e) {
    var pending = isPending(e.id);
    var row = document.createElement("div");
    row.className = "history-item who-" + e.who + (pending ? " is-pending" : "");

    var em = makeAvatar(e.who, "h-emoji");

    var main = document.createElement("div");
    main.className = "h-main";
    var who = document.createElement("span");
    who.className = "h-who";
    var actionWord = activeCat === "bira" ? " içti" : " içti";
    who.textContent = WHO[e.who].label + actionWord;

    if (activeCat === "bira") {
      var parts = (e.tag || "efes_pilsen:50cl").split(":");
      var brandObj = BEER_BRANDS.filter(function (b) { return b.id === parts[0]; })[0];
      var brandLabel = brandObj ? brandObj.label : parts[0];
      var sizeLabel = parts[1] || "50cl";
      var beerBadge = document.createElement("span");
      beerBadge.className = "h-kind kind-sigo";
      beerBadge.textContent = "🍺 " + brandLabel + " (" + sizeLabel + ")";
      who.appendChild(beerBadge);
    } else if (activeCat === "sigo") {
      var kInfo = KINDS[entryKind(e)] || KINDS.sigo;
      var kindBadge = document.createElement("span");
      kindBadge.className = "h-kind " + kInfo.cls;
      kindBadge.textContent = kInfo.emoji + " " + kInfo.label;
      who.appendChild(kindBadge);
    }

    var time = document.createElement("span");
    time.className = "h-time";
    var tagStr = "";
    time.textContent = formatTime(e.ts) + " · " + relativeTime(e.ts) + (pending ? " · ⏳ bekliyor" : "");
    main.appendChild(who);
    main.appendChild(time);

    var edit = document.createElement("button");
    edit.className = "h-del";
    edit.textContent = "✏️";
    edit.title = "Düzenle";
    edit.addEventListener("click", function () {
      editingId = editingId === e.id ? null : e.id;
      renderHistory();
    });

    var del = document.createElement("button");
    del.className = "h-del";
    del.textContent = "✕";
    del.title = "Sil";
    del.addEventListener("click", function () { deleteEntry(e.id); });

    row.appendChild(em);
    row.appendChild(main);
    row.appendChild(edit);
    row.appendChild(del);
    return row;
  }

  // Düzenleme paneli: tür (sigo/bong) + kişi seçimi (4 çip) + etiket + tarih/saat + kaydet/vazgeç
  function historyEditPanel(e) {
    var panel = document.createElement("div");
    panel.className = "hist-edit";
    var selectedWho = e.who;
    var selectedKind = entryKind(e);
    var selectedTag = e.tag || "efes_pilsen:50cl";
    var parts = selectedTag.split(":");
    var selectedBrand = parts[0] || "efes_pilsen";
    var selectedSize = parts[1] || "50cl";

    var topControlSection = document.createElement("div");
    topControlSection.className = "hist-edit-who";

    if (activeCat === "bira") {
      var beerWrap = document.createElement("div");
      beerWrap.className = "beer-opt-wrap";
      beerWrap.style.opacity = "1";
      beerWrap.style.transform = "none";
      beerWrap.style.width = "100%";

      var row1 = document.createElement("div");
      row1.className = "beer-opt-row";
      var lbl1 = document.createElement("label");
      lbl1.textContent = "Marka:";
      var sel = document.createElement("select");
      sel.className = "beer-select";
      BEER_BRANDS.forEach(function (bObj) {
        var opt = document.createElement("option");
        opt.value = bObj.id;
        opt.textContent = "🍺 " + bObj.label;
        if (bObj.id === selectedBrand) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", function () { selectedBrand = sel.value; });
      row1.appendChild(lbl1);
      row1.appendChild(sel);

      var row2 = document.createElement("div");
      row2.className = "beer-opt-row";
      var lbl2 = document.createElement("label");
      lbl2.textContent = "Boyut:";
      var szSeg = document.createElement("div");
      szSeg.className = "seg";
      BEER_SIZES.forEach(function (sObj) {
        var szBtn = document.createElement("button");
        szBtn.className = "seg-btn" + (sObj.id === selectedSize ? " active" : "");
        szBtn.type = "button";
        szBtn.textContent = sObj.id;
        szBtn.addEventListener("click", function () {
          selectedSize = sObj.id;
          szSeg.querySelectorAll(".seg-btn").forEach(function (x) { x.classList.toggle("active", x === szBtn); });
        });
        szSeg.appendChild(szBtn);
      });
      row2.appendChild(lbl2);
      row2.appendChild(szSeg);

      beerWrap.appendChild(row1);
      beerWrap.appendChild(row2);
      topControlSection.appendChild(beerWrap);
    } else if (activeCat === "sigo") {
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
    }

    var chips = document.createElement("div");
    chips.className = "hist-edit-who";
    var whoList = activeCat === "sigo" ? Object.keys(WHO) : ["utku", "gozde"];
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
      var finalTag = activeCat === "bira" ? (selectedBrand + ":" + selectedSize) : e.tag;
      updateEntry(e.id, selectedWho, ts, selectedKind, finalTag);
    });
    var cancel = document.createElement("button");
    cancel.className = "ghost-btn small";
    cancel.textContent = "Vazgeç";
    cancel.addEventListener("click", function () { editingId = null; renderHistory(); });
    btns.appendChild(save);
    btns.appendChild(cancel);

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
      return whoMatch && kindMatch;
    });
    if (filtered.length === 0) {
      empty.classList.remove("hidden");
      empty.textContent = entries.length ? "Bu filtrede kayıt yok." : "Henüz kayıt yok. Sol alttaki + ile ekle 👆";
      return;
    }
    empty.classList.add("hidden");

    var recent = filtered.slice(-150).reverse();
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
      cnt.textContent = g.items.length;
      head.appendChild(lbl);
      head.appendChild(dots);
      head.appendChild(cnt);
      list.appendChild(head);
      g.items.forEach(function (e) {
        list.appendChild(historyItem(e));
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
      return e.who === who || ((who === "utku" || who === "gozde") && isShared(e.who));
    });
    if (!sub.length) return null;
    var since = Date.now() - sub[sub.length - 1].ts;
    var maxGap = 0;
    for (var i = 1; i < sub.length; i++) {
      var g = sub[i].ts - sub[i - 1].ts;
      if (g > maxGap) maxGap = g;
    }
    return { since: since, record: Math.max(maxGap, since) };
  }

  function renderSince() {
    if (!el("sinceUtku")) return;
    var head = el("sinceCardHead");
    if (head) {
      var catUnit = (CATS[activeCat] || CATS.sigo).unit;
      head.textContent = "Son " + catUnit + "dan beri";
    }
    var ids = { utku: "Utku", gozde: "Gozde" };
    Object.keys(ids).forEach(function (who) {
      var t = el("since" + ids[who]);
      var r = el("rec" + ids[who]);
      var d = sinceData(who);
      if (!d) { t.textContent = "—"; if (r) r.textContent = ""; return; }
      t.textContent = fmtDuration(d.since);
      if (r) r.textContent = "🏆 " + fmtDuration(d.record);
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

    var maxCount = 1, peakBlock = null;
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
        fills[i].style.width = fills[i].getAttribute('data-w') + "%";
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

  // 🏅 Rozetler: veriden kazanılmış/kilitli başarımlar
  function computeBadges() {
    var c = countWho(entries);
    var total = entries.length;
    var lg = Math.max(asstLongestGap(), asstRunningGap());
    var clean = longestCleanStreak(entries);
    var together = c.both + c.hepberaber;
    var night = false, morning = false;
    entries.forEach(function (e) {
      var h = new Date(e.ts).getHours();
      if (h >= 0 && h < 4) night = true;
      if (h >= 4 && h < 8) morning = true;
    });
    return [
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
  function setStatus(text, state) {
    var node = el("cloudStatus");
    if (node) {
      // Metin gizli; açıklama dokununca/hover'da title olarak görünür
      node.title = text;
      node.setAttribute("aria-label", text);
      node.className = "cloud-status status-" + (state || "offline");
    }
    // Ayarlar'daki ayrıntılı satır
    var info = el("syncInfo");
    if (info) {
      var extra = "";
      if (state === "online" && lastSyncAt) extra = " · son: " + formatTime(lastSyncAt);
      else if (outbox.length) extra = " · " + outbox.length + " işlem bekliyor";
      info.textContent = "Durum: " + text + extra;
    }
  }
  function refreshStatus() {
    if (!sb) { setStatus("📴 Yerel mod", "offline"); return; }
    if (!navigator.onLine) { setStatus("📴 Çevrimdışı", "offline"); return; }
    if (lastCloudError) { setStatus("⚠️ Bulut hatası · " + outbox.length + " bekliyor", "error"); return; }
    if (outbox.length) { setStatus("⏳ " + outbox.length + " bekliyor…", "syncing"); return; }
    setStatus(cloudReady ? "☁️ Senkron" : "☁️ Bağlanıyor…", cloudReady ? "online" : "syncing");
  }

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

    var maxGap = 0;
    for (var i = 1; i < monthList.length; i++) {
      var g = monthList[i].ts - monthList[i - 1].ts;
      if (g > maxGap) maxGap = g;
    }
    var maxGapStr = maxGap > 0 ? fmtCoarse(maxGap) : "—";

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
        '<span class="wrapped-item-title">Oturma Odası Saatiniz</span>' +
        '<span class="wrapped-item-val">' + peakHStr + '</span>' +
        '<span class="wrapped-item-sub">Zirve zamanı</span>' +
      '</div>' +
      '<div class="wrapped-item">' +
        '<span class="wrapped-item-ico">🌱</span>' +
        '<span class="wrapped-item-title">En Uzun Mola</span>' +
        '<span class="wrapped-item-val">' + maxGapStr + '</span>' +
        '<span class="wrapped-item-sub">En uzun ara</span>' +
      '</div>';

    if (activeCat === "sigo") {
      letter.innerHTML = '<strong>Zıvana\'dan Not 💌:</strong> ' + monthName + ' ayında Utku ve Gözde olarak ' + total + ' kez dumanaltı oldunuz! Sigolarınızın %' + sharedPct + '\'ini birlikte yaktınız. Favori oturma odası zamanınız saat ' + peakHStr + ' arası görünüyor. Uyumunuz harika! 🌿✨';
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
    refreshAsst();
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
    var entry = { id: uuid(), who: who, kind: k, ts: Date.now() };
    if (tag) entry.tag = tag;
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
    entries.splice(idx, 1);
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
    if (!pendingInsert) outbox.push({ type: "delete", id: id });
    saveOutbox();
    flushOutbox();
    refreshStatus();
  }

  // Bir kaydın alanlarını günceller (kişi/saat/etiket/tür); buluta update olarak gider
  function patchEntry(id, fields) {
    var idx = findIndexById(id);
    if (idx === -1) return;
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
      outbox.push({ type: "update", id: id, fields: fields });
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
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { bar.classList.add("hidden"); lastUndo = null; }, 4000);
  }

  function undoLast() {
    if (!lastUndo) return;
    deleteEntry(lastUndo.id);
    lastUndo = null;
    el("undoBar").classList.add("hidden");
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
        var dbRow = { id: op.row.id, who: op.row.who, ts: op.row.ts };
        if (op.row.tag) dbRow.tag = op.row.tag;
        p = sb.from(tableName).upsert(dbRow, { onConflict: "id", ignoreDuplicates: true });
      } else if (op.type === "update") {
        var fields = Object.assign({}, op.fields);
        delete fields.kind;
        p = sb.from(tableName).update(fields).eq("id", op.id);
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
    return sb.from(tableName).select("id,who,ts").order("ts", { ascending: true }).then(function (res) {
      if (res.error) { cloudError(res.error); return; }
      lastCloudError = null;
      if (!res.data) return;
      var map = {};
      res.data.forEach(function (r) {
        var o = { id: r.id, who: r.who, ts: Number(r.ts), kind: "sigo" };
        if (r.tag) o.tag = r.tag;
        map[r.id] = o;
      });
      // Henüz gönderilmemiş yerel işlemleri uzaktaki veriye uygula
      catOutbox.forEach(function (op) {
        if (op.type === "insert" && op.row) map[op.row.id] = op.row;
        else if (op.type === "delete") delete map[op.id];
        else if (op.type === "update" && map[op.id] && op.fields) {
          Object.keys(op.fields).forEach(function (k) { map[op.id][k] = op.fields[k]; });
        }
      });
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
        var o = { id: r.id, who: r.who, ts: Number(r.ts), kind: r.kind || "sigo" };
        if (r.tag) o.tag = r.tag;
        catStore[cat].entries.push(o);
        catStore[cat].entries.sort(function (a, b) { return a.ts - b.ts; });
        saveCatCache(cat);
        if (cat === activeCat) render();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: tableName }, function (payload) {
        var r = payload.new;
        var idx = r ? catFindIndex(r.id) : -1;
        if (idx === -1) return;
        catStore[cat].entries[idx].who = r.who || catStore[cat].entries[idx].who;
        catStore[cat].entries[idx].ts = Number(r.ts) || catStore[cat].entries[idx].ts;
        catStore[cat].entries[idx].tag = r.tag || undefined;
        catStore[cat].entries[idx].kind = r.kind || catStore[cat].entries[idx].kind || "sigo";
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
      .on("broadcast", { event: "balkon_call" }, function (payload) {
        var p = payload ? payload.payload : null;
        if (p && p.who) {
          showCallToast(p.who);
        }
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
    var blob = new Blob([JSON.stringify({ app: "dumanalti", version: 1, exportedAt: new Date().toISOString(), entries: entries }, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "dumanalti-" + dayKey(Date.now()) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(/** @type {string} */ (reader.result));
        var incoming = Array.isArray(data) ? data : data.entries;
        if (!Array.isArray(incoming)) throw new Error("Geçersiz dosya");
        var map = {};
        entries.forEach(function (e) { map[e.id] = e; });
        var added = [];
        incoming.forEach(function (e) {
          if (e && e.who && e.ts) {
            var id = e.id || uuid();
            if (!map[id]) { var row = { id: id, who: e.who, ts: Number(e.ts), kind: e.kind || "sigo" }; map[id] = row; added.push(row); }
          }
        });
        entries = Object.keys(map).map(function (k) { return map[k]; });
        sortEntries();
        saveCache();
        render();
        // yeni kayıtları buluta gönder
        added.forEach(function (row) { outbox.push({ type: "insert", row: row }); });
        saveOutbox();
        flushOutbox();
        alert("İçe aktarıldı. Toplam " + entries.length + " kayıt.");
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
    CAT_ORDER.forEach(function (c) {
      catStore[c].entries = [];
      catStore[c].outbox = [];
      saveCatCache(c);
      saveCatOutbox(c);
      if (sb && navigator.onLine) {
        sb.from(CATS[c].table).delete().neq("id", "00000000-0000-0000-0000-000000000000").then(function () {});
      }
    });
    entries = catStore[activeCat].entries;
    outbox = catStore[activeCat].outbox;
    render();
    refreshStatus();
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
    flushOutbox()
      .then(syncFromRemote)
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
  function showTab(name) {
    closeAddDial();
    ["portal", "home", "stats", "history", "settings"].forEach(function (n) {
      var v = el("view-" + n);
      if (v) v.classList.toggle("hidden", n !== name);
    });
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    document.body.setAttribute("data-active-tab", name);
    try { localStorage.setItem(TAB_KEY, name); } catch (e) {}
    window.scrollTo(0, 0);
  }

  // Genişleyen global sigo-ekle butonu (tüm sayfalarda)
  function bindAddDial() {
    var dial = el("addDial"), fab = el("addFab");
    if (!dial || !fab) return;
    var scrim = null;
    function open() {
      dial.classList.add("open");
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
      if (scrim) { var s = scrim; scrim = null; s.classList.remove("show"); setTimeout(function () { s.remove(); }, 200); }
    }
    closeAddDial = close;
    fab.addEventListener(TAP_EVT, function (ev) {
      ev.stopPropagation();
      dial.classList.contains("open") ? close() : open();
    });
    var kindBtns = dial.querySelectorAll(".add-kind-btn");
    kindBtns.forEach(function (b) {
      b.addEventListener(TAP_EVT, function (ev) {
        ev.stopPropagation();
        var k = b.getAttribute("data-kind");
        if (k && KINDS[k]) {
          selectedAddKind = k;
          kindBtns.forEach(function (btn) { btn.classList.toggle("active", btn === b); });
        }
      });
    });

    var selectedBeerBrand = "efes_pilsen";
    var selectedBeerSize = "50cl";

    var beerSizeSeg = el("beerSizeSeg");
    if (beerSizeSeg) {
      beerSizeSeg.querySelectorAll(".seg-btn").forEach(function (b) {
        b.addEventListener(TAP_EVT, function (ev) {
          ev.stopPropagation();
          var sz = b.getAttribute("data-size");
          if (sz) {
            selectedBeerSize = sz;
            beerSizeSeg.querySelectorAll(".seg-btn").forEach(function (x) { x.classList.toggle("active", x === b); });
          }
        });
      });
    }

    var beerBrandSel = el("beerBrandSel");
    if (beerBrandSel) {
      beerBrandSel.addEventListener("change", function () {
        selectedBeerBrand = /** @type {HTMLSelectElement} */ (beerBrandSel).value || "efes_pilsen";
      });
    }

    dial.querySelectorAll(".add-opt").forEach(function (bEl) {
      var b = /** @type {HTMLElement} */ (bEl);
      b.addEventListener(TAP_EVT, function () {
        if (b.dataset.lock === "1") return;
        var who = b.getAttribute("data-who");
        if (!who) return; // callBalkonBtn handles its own click
        b.dataset.lock = "1"; setTimeout(function () { b.dataset.lock = "0"; }, 350);
        var r = b.getBoundingClientRect();
        close();
        var extraTag = activeCat === "bira" ? (selectedBeerBrand + ":" + selectedBeerSize) : undefined;
        addEntry(who, r.left + r.width / 2, r.top + r.height / 2, selectedAddKind, extraTag);
      });
    });

    var callBtn = el("callBalkonBtn");
    if (callBtn) {
      callBtn.addEventListener(TAP_EVT, function (ev) {
        ev.stopPropagation();
        close();
        sendBalkonCall();
      });
    }
  }

  // ---------- Init ----------
  function bind() {
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
    showTab(localStorage.getItem(TAB_KEY) || "portal");

    // Portal kartlarına tıklanınca o kategoriye git ve Anasayfa (Bugün) sekmesini aç
    document.querySelectorAll(".portal-card").forEach(function (btn) {
      btn.addEventListener(TAP_EVT, function () {
        var cat = btn.getAttribute("data-cat");
        if (cat) {
          switchCat(cat);
          showTab("home");
        }
      });
    });

    // Geçmiş kişi filtreleri
    document.querySelectorAll("#histFilters .hist-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        historyFilter = chip.getAttribute("data-f");
        document.querySelectorAll("#histFilters .hist-chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
        renderHistory();
      });
    });

    // Geçmiş tür filtreleri (Sigo vs Bong)
    document.querySelectorAll("#histKindFilters .hist-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        historyKind = chip.getAttribute("data-kf");
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
      settings.owner = v; saveSettings();
    });

    var tgTokenInp = el("tgBotTokenInput");
    if (tgTokenInp) {
      /** @type {HTMLInputElement} */ (tgTokenInp).value = settings.tgBotToken || "";
      tgTokenInp.addEventListener("change", function () {
        settings.tgBotToken = (/** @type {HTMLInputElement} */ (tgTokenInp).value || "").trim();
        saveSettings();
      });
    }

    var tgChatInp = el("tgChatIdInput");
    if (tgChatInp) {
      /** @type {HTMLInputElement} */ (tgChatInp).value = settings.tgChatId || "";
      tgChatInp.addEventListener("change", function () {
        settings.tgChatId = (/** @type {HTMLInputElement} */ (tgChatInp).value || "").trim();
        saveSettings();
      });
    }

    if (el("testTgBotBtn")) el("testTgBotBtn").addEventListener("click", testTgBot);


    // Zıvana görünürlüğü
    bindSeg("mascotSeg", "data-mascot", settings.mascot, function (v) {
      settings.mascot = v; saveSettings(); applyMascot();
    });

    if (el("syncNowBtn")) el("syncNowBtn").addEventListener(TAP_EVT, syncNow);
    if (el("exportCsvBtn")) el("exportCsvBtn").addEventListener("click", exportCsv);


    bindAssistant();
    bindAddDial();
    applyMascot();

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
      var asst = el("assistant");
      var threshold = 12; // px – küçük titreşimleri görmezden gel
      window.addEventListener("scroll", function () {
        var y = window.pageYOffset || 0;
        var delta = y - lastY;
        if (delta > threshold && !hidden && y > 60) {
          hidden = true;
          if (dial) dial.classList.add("fab-hidden");
          if (asst) asst.classList.add("fab-hidden");
        } else if (delta < -threshold || y < 30) {
          if (hidden) {
            hidden = false;
            if (dial) dial.classList.remove("fab-hidden");
            if (asst) asst.classList.remove("fab-hidden");
          }
        }
        lastY = y;
      }, { passive: true });
    })();

    setInterval(function () { renderToday(); }, 60000);
    setInterval(function () { renderSince(); }, 1000);
  }

  // Zıvana'yı ayara ve aktif kategoriye (sadece Sigo) göre göster/gizle
  function applyMascot() {
    var a = el("assistant");
    var hide = settings.mascot === "off" || activeCat !== "sigo";
    if (a) a.classList.toggle("hidden", hide);
    if (hide) { var p = el("asstPanel"); if (p) p.classList.add("hidden"); }
    else if (typeof refreshAsst === "function") refreshAsst();
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
    var rows = ["tarih,saat,kisi,mantiksal_gun"];
    entries.forEach(function (e) {
      var d = new Date(e.ts);
      var tarih = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
      rows.push(tarih + "," + formatTime(e.ts) + "," + WHO[e.who].label + "," + dayKey(e.ts));
    });
    var blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "dumanalti-" + dayKey(Date.now()) + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Zıvana: yardımcı asistan ----------
  var asstOpened = false;
  var ASST_SEEN_KEY = "dumanalti.asst.seen";
  var FACES = { neutral: "icons/mascot.svg", happy: "icons/mascot.svg",
                surprised: "icons/mascot-surprised.svg", love: "icons/mascot-love.svg" };
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  function asstStats() {
    var all = countWho(entries);
    var today = todayEntries().length;
    var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
    var avg7Info = calcAverages(entriesSince(sevenAgo), 7);
    var wStart = startOfWeek(Date.now()).getTime();
    var thisWeek = entriesSince(wStart).length;
    var lastWeek = entries.filter(function (e) { return e.ts >= wStart - 7 * 86400000 && e.ts < wStart; }).length;
    var byHour = [];
    for (var h = 0; h < 24; h++) byHour[h] = 0;
    entries.forEach(function (e) { byHour[logicalDate(e.ts).getHours()]++; });
    var peakH = 0;
    for (h = 1; h < 24; h++) if (byHour[h] > byHour[peakH]) peakH = h;
    var last = entries.length ? entries[entries.length - 1] : null;
    return {
      all: all, today: today, avg7: avg7Info.total, utkuAvg7: avg7Info.utku, gozdeAvg7: avg7Info.gozde,
      thisWeek: thisWeek, lastWeek: lastWeek,
      peakH: peakH, peakCount: byHour[peakH], last: last,
      utku: all.utku + all.both + all.hepberaber, gozde: all.gozde + all.both + all.hepberaber
    };
  }

  // Kayıtlar arası en uzun tamamlanmış ara (ms)
  function asstLongestGap() {
    var m = 0;
    for (var i = 1; i < entries.length; i++) { var g = entries[i].ts - entries[i - 1].ts; if (g > m) m = g; }
    return m;
  }
  // Son sigodan bu yana geçen süre (ms)
  function asstRunningGap() { return entries.length ? Date.now() - entries[entries.length - 1].ts : 0; }
  // Bugün dahil, ortalamanın altında kaç ardışık mantıksal gün geçti
  function asstBelowAvgStreak(avg, who) {
    if (avg <= 0) return 0;
    var byDay = {};
    entries.forEach(function (e) {
      if (!who || e.who === who || isShared(e.who)) {
        var k = dayKey(e.ts);
        byDay[k] = (byDay[k] || 0) + 1;
      }
    });
    var d = logicalDate(Date.now()), streak = 0;
    for (var i = 0; i < 90; i++) {
      var p = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
      var k = p.getFullYear() + "-" + (p.getMonth() + 1) + "-" + p.getDate();
      if ((byDay[k] || 0) < avg) streak++; else break;
    }
    return streak;
  }
  // Tek günde en çok (adet + "gg.aa")
  function asstRecordDay() {
    var byDay = {};
    entries.forEach(function (e) { var k = dayKey(e.ts); byDay[k] = (byDay[k] || 0) + 1; });
    var mk = null, mc = 0;
    Object.keys(byDay).forEach(function (k) { if (byDay[k] > mc) { mc = byDay[k]; mk = k; } });
    if (!mk) return null;
    var p = String(mk).split("-");
    return { count: mc, label: ("0" + p[2]).slice(-2) + "." + ("0" + p[1]).slice(-2) };
  }

  // Proaktif nudge: o an söylenmeye değer TEK şey (veya null)
  function asstNudge() {
    var s = asstStats();
    if (s.all.total === 0) return null;
    var now = new Date();
    // 1) Günlük limit aşıldı
    if (settings.dailyLimit > 0 && s.today > settings.dailyLimit) {
      return { key: "limit:" + dayKey(now) + ":" + s.today, mood: "surprised", emoji: "⚠️",
        text: "Bugün günlük limiti aştın (" + s.today + " / " + settings.dailyLimit + "). Kalanı yavaşlatmayı dene 💪" };
    }
    // 2) Şu an en uzun aranı kırıyorsun
    var lg = asstLongestGap(), rg = asstRunningGap();
    if (rg > lg && rg >= 3 * 3600000) {
      return { key: "gap:" + Math.floor(rg / 3600000), mood: "love", emoji: "🏆",
        text: "Rekor kırıyorsun! " + fmtCoarse(rg) + " sigo içmedin — bu en uzun aran 🏆" };
    }
    // 3) Toplam kilometre taşı
    var mil = [50, 100, 250, 500, 1000, 2000];
    for (var i = 0; i < mil.length; i++) {
      if (s.all.total === mil[i]) return { key: "mil:" + mil[i], mood: "love", emoji: "🎉",
        text: mil[i] + ". sigo kaydı! Koca bir geçmiş biriktirdiniz 📈" };
    }
    // 4) Düşük gün serisi
    var targetAvg = settings.owner === "utku" ? s.utkuAvg7 : (settings.owner === "gozde" ? s.gozdeAvg7 : s.avg7);
    var st = asstBelowAvgStreak(targetAvg, settings.owner);
    if (targetAvg > 0 && st >= 2) {
      return { key: "streak:" + st, mood: "love", emoji: "🔥",
        text: st + " gündür ortalamanın altındasın 🔥 Harika gidiyorsun!" };
    }
    // 5) Bugün gidişat
    var tCounts = countWho(todayEntries());
    var myTodayCount = settings.owner === "utku" ? (tCounts.utku + tCounts.both + tCounts.hepberaber) :
                      (settings.owner === "gozde" ? (tCounts.gozde + tCounts.both + tCounts.hepberaber) : s.today);
    if (myTodayCount > 0 && targetAvg > 0 && myTodayCount < targetAvg) {
      return { key: "under:" + dayKey(now), mood: "happy", emoji: "🌿",
        text: "Bugün ortalamanın altındasın (" + myTodayCount + " < " + targetAvg.toFixed(1) + "). Aferin! 🌿" };
    }
    if (myTodayCount > 0 && targetAvg > 0 && myTodayCount > targetAvg) {
      return { key: "over:" + dayKey(now) + ":" + myTodayCount, mood: "surprised", emoji: "👀",
        text: "Bugün ortalamanın üstündesin (" + myTodayCount + " > " + targetAvg.toFixed(1) + "). Yavaşlayalım mı? 🙂" };
    }
    return null;
  }

  // FAB + panel yüzünü ruh haline göre değiştir (aynıysa dokunma, titremesin)
  function setAsstFace(mood) {
    var src = FACES[mood] || FACES.neutral;
    document.querySelectorAll(".asst-fab-face, .asst-face").forEach(function (img) {
      if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    });
  }

  function asstSeenKey() { try { return localStorage.getItem(ASST_SEEN_KEY) || ""; } catch (e) { return ""; } }
  function asstMarkSeen(k) { try { localStorage.setItem(ASST_SEEN_KEY, k); } catch (e) {} }

  // Yüz + rozeti canlı duruma göre güncelle (render'dan ve ekleme sonrası çağrılır)
  function refreshAsst() {
    if (settings.mascot === "off") return;
    var n = asstNudge();
    setAsstFace(n ? n.mood : "neutral");
    var badge = el("asstBadge");
    if (!badge) return;
    if (!asstOpened && !asstSeenKey()) {          // ilk tanışma
      badge.textContent = "?"; badge.classList.remove("hidden");
    } else if (n && n.key !== asstSeenKey()) {     // görülmemiş yeni olay
      badge.textContent = n.emoji; badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  // Bir konuya veriden üretilmiş cevap (metin dizisi)
  function asstReply(topic) {
    var s = asstStats();
    var catInfo = CATS[activeCat] || CATS.sigo;
    var u = catInfo.unit;
    if (s.all.total === 0 && topic !== "hi") {
      return ["Henüz hiç kayıt yok 💨 İlk kaydı eklediğinde sana verilerinizi yorumlarım!"];
    }
    var out = [];
    if (topic === "hi") {
      var hr = new Date().getHours();
      var greet = hr < 6 ? "İyi geceler" : hr < 12 ? "Günaydın" : hr < 18 ? "İyi günler" : "İyi akşamlar";
      var hitap = settings.owner ? " " + WHO[settings.owner].label : "";
      out.push(greet + hitap + "! " + pick([
        "Ben Zıvana 💨 Merak ettiğini sor.",
        "Ben Zıvana 🌿 Verilerinize göz kulağım.",
        "Zıvana burada 💨 Sana rakamları yorumlarım."
      ]));
      var n = asstNudge();
      if (n) out.push(n.text);
      else if (s.today === 0) out.push("Bugün henüz hiç tüketmemişsiniz — böyle devam! 🌿");
      else out.push("Bugün şu ana kadar " + s.today + " " + u + " içildi.");
    } else if (topic === "today") {
      out.push("Bugün toplam " + s.today + " " + u + " içildi.");
      if (s.utkuAvg7 > 0 || s.gozdeAvg7 > 0) {
        out.push("7 günlük ortalamalar: 🧔 Utku " + s.utkuAvg7.toFixed(1) + " · 👩 Gözde " + s.gozdeAvg7.toFixed(1));
      }
    } else if (topic === "who") {
      if (s.utku > s.gozde) out.push("Utku önde: " + s.utku + " " + u + ", Gözde " + s.gozde + ". Fark " + (s.utku - s.gozde) + " 🏆");
      else if (s.gozde > s.utku) out.push("Gözde önde: " + s.gozde + " " + u + ", Utku " + s.utku + ". Fark " + (s.gozde - s.utku) + " 🏆");
      else out.push("Tam berabere! İkiniz de " + s.utku + " " + u + " 🤝");
      var pct = s.all.total ? Math.round((s.all.both + s.all.hepberaber) / s.all.total * 100) : 0;
      if (activeCat === "sigo") out.push("Sigoların %" + pct + "'ini birlikte içtiniz 💜");
    } else if (topic === "me") {
      if (!settings.owner) {
        out.push("Önce Ayarlar > Kişiselleştirme'den bu cihazın kimin olduğunu seç, sana özel konuşayım 🙂");
      } else {
        var meName = WHO[settings.owner].label;
        var t = countWho(todayEntries());
        var meToday = settings.owner === "utku" ? (t.utku + t.both + t.hepberaber) : (t.gozde + t.both + t.hepberaber);
        var meTotal = settings.owner === "utku" ? s.utku : s.gozde;
        var other = settings.owner === "utku" ? s.gozde : s.utku;
        out.push(meName + ", bugün senin hanene " + meToday + " " + u + " yazıldı.");
        if (meTotal > other) out.push("Toplamda " + (meTotal - other) + " " + u + " öndesin 🏆");
        else if (other > meTotal) out.push("Toplamda " + (other - meTotal) + " " + u + " geridesin — yavaşlamak yarışı da kazandırır 😉");
        else out.push("Rakibinle tam berabersin 🤝");
      }
    } else if (topic === "peak") {
      if (s.peakCount === 0) out.push("Henüz saat örüntüsü çıkaracak kadar veri yok.");
      else {
        out.push("En yoğun saatin " + pad2(s.peakH) + ":00 civarı (" + s.peakCount + " " + u + ") ⏰");
        out.push(pick([
          "O saate yaklaşırken bir bardak su iç, kriz geçer 💧",
          "O saatte kısa bir yürüyüş çok işe yarar 🚶",
          "O saati bir sakızla atlatmayı dene 🍬"
        ]));
      }
    } else if (topic === "week") {
      out.push("Bu hafta " + s.thisWeek + " " + u + " içtiniz.");
      if (s.lastWeek > 0) {
        if (s.thisWeek < s.lastWeek) out.push("Geçen haftaya göre " + (s.lastWeek - s.thisWeek) + " tane az — düşüşteyiz, süper! 📉");
        else if (s.thisWeek > s.lastWeek) out.push("Geçen haftaya göre " + (s.thisWeek - s.lastWeek) + " tane fazla. Bu hafta kısalım mı? 💪");
        else out.push("Geçen haftayla aynı seviyedesiniz.");
      }
    } else if (topic === "month") {
      var mCount = entriesSince(startOfMonth()).length;
      out.push("Bu ay toplam " + mCount + " " + u + " içildi.");
      var dayNo = logicalDate(Date.now()).getDate();
      if (dayNo >= 2 && mCount > 0) out.push("Bu hızla ay sonunda ~" + Math.round(mCount / dayNo * 30) + " olur.");
    } else if (topic === "records") {
      var lg = asstLongestGap(), rg = asstRunningGap();
      if (rg > lg && rg >= 3600000) out.push("Şu an rekordasın: " + fmtCoarse(rg) + " ara verdin, öncekini geçtin 🏆");
      else if (Math.max(lg, rg) > 0) out.push("En uzun aran: " + fmtCoarse(Math.max(lg, rg)) + " ⏱️");
      var rd = asstRecordDay();
      if (rd) out.push("Tek günde rekor: " + rd.count + " " + u + " (" + rd.label + ") 🔥");
    } else if (topic === "streak") {
      var st = asstBelowAvgStreak(s.avg7);
      if (s.avg7 <= 0) out.push("Seri için biraz daha veri lazım, birkaç gün geçince takip ederim 🌱");
      else if (st >= 2) out.push(st + " gündür ortalamanın altındasın 🔥 Böyle devam!");
      else if (st === 1) out.push("Bugün ortalamanın altındasın — seriyi büyütmeye var mısın? 💪");
      else out.push("Şu an düşük-gün serisi yok ama her yeni gün bir fırsat 🌿");
    } else if (topic === "tip") {
      if (s.last) {
        var gapMin = Math.floor((Date.now() - s.last.ts) / 60000);
        if (gapMin >= 120) out.push("Son " + u + "dan " + Math.floor(gapMin / 60) + " saat geçmiş — arayı uzatmak en etkili yöntem 🌿");
      }
      if (s.peakCount > 0) out.push("En çok " + pad2(s.peakH) + ":00 sularında içiyorsun; o saatte kısa bir mola krizi atlatır 🚶");
      if (s.avg7 > 0) out.push("Küçük hedef: bugünü " + Math.max(0, Math.floor(s.avg7) - 1) + " " + u + " ile bitir, ortalamanı düşür 💪");
      if (out.length === 0) out.push(pick([
        "Harika gidiyorsun, böyle devam! Her içmediğin " + u + " bir kazanç 💨",
        "Su iç, derin nefes al, kriz 3-5 dakikada geçer 🌬️",
        "Canın çektiğinde 10 dakika ertele — çoğu zaman istek geçer ⏳"
      ]));
    }
    return out;
  }

  // Serbest metni bir konuya yönlendir (anahtar kelime eşleme)
  function asstRoute(text) {
    var q = text.toLocaleLowerCase("tr");
    /** @type {(...terms: string[]) => boolean} */
    var has = function () { for (var i = 0; i < arguments.length; i++) if (q.indexOf(arguments[i]) >= 0) return true; return false; };
    if (has("selam", "merhaba", "naber", "nasılsın", "nasilsin")) return "hi";
    if (has("rekor", "en uzun", "en çok", "en cok", "record")) return "records";
    if (has("seri", "gündür", "gundur", "sigosuz", "kaç gün", "kac gun")) return "streak";
    if (has("ben ", "benim", "nasılım", "nasilim", "kendim")) return "me";
    if (has("kim", "önde", "onde", "yarış", "yaris", "kazan", "düello", "duello")) return "who";
    if (has("hafta")) return "week";
    if (has("ay", "aylık", "aylik")) return "month";
    if (has("saat", "yoğun", "yogun", "ne zaman")) return "peak";
    if (has("tavsiye", "ipucu", "öneri", "oneri", "yardım", "yardim", "bırak", "birak")) return "tip";
    if (has("bugün", "bugun", "gün", "gun")) return "today";
    return null;
  }

  function asstPush(text, isMe) {
    var body = el("asstBody");
    var msg = document.createElement("div");
    msg.className = "asst-msg" + (isMe ? " me" : "");
    msg.textContent = text;
    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
  }

  // Çipler: kişisel soru yalnız cihaz sahibi seçiliyse eklenir
  function asstChips() {
    var c = [
      { k: "today", t: "Bugün nasıl?" },
      { k: "who", t: "Kim önde?" },
      { k: "week", t: "Bu hafta?" },
      { k: "month", t: "Bu ay?" },
      { k: "records", t: "Rekorlarım 🏆" },
      { k: "streak", t: "Serim 🔥" },
      { k: "peak", t: "Yoğun saatim?" },
      { k: "tip", t: "Tavsiye 💡" }
    ];
    if (settings.owner) c.splice(1, 0, { k: "me", t: "Ben nasılım?" });
    return c;
  }

  // "yazıyor…" göstergesi: cevap gelmeden önce üç nokta yanıp söner (native his)
  function asstTyping() {
    var body = el("asstBody");
    var t = document.createElement("div");
    t.className = "asst-msg asst-typing";
    t.setAttribute("aria-label", "Zıvana yazıyor");
    t.innerHTML = '<span class="asst-dot"></span><span class="asst-dot"></span><span class="asst-dot"></span>';
    body.appendChild(t);
    body.scrollTop = body.scrollHeight;
    return t;
  }

  function asstAsk(topic, label) {
    if (label) asstPush(label, true);
    var replies = asstReply(topic);
    var i = 0;
    (function next() {
      if (i >= replies.length) return;
      var typing = asstTyping();
      setTimeout(function () {
        typing.remove();
        asstPush(replies[i], false); i++; next();
      }, i === 0 ? 350 : 550);
    })();
  }

  // Serbest metin gönderimi
  function asstSubmit() {
    var inp = /** @type {HTMLInputElement} */ (el("asstInput"));
    if (!inp) return;
    var text = (inp.value || "").trim();
    if (!text) return;
    inp.value = "";
    asstPush(text, true);
    var topic = asstRoute(text);
    if (topic) { asstAsk(topic); return; }
    var typing = asstTyping();
    setTimeout(function () {
      typing.remove();
      asstPush("Tam anlamadım 🤔 Şunları sorabilirsin: bugün, kim önde, bu hafta/ay, rekorlarım, serim, yoğun saatim, tavsiye.", false);
    }, 400);
  }

  function asstOpen() {
    var panel = el("asstPanel");
    panel.classList.remove("hidden");
    var n = asstNudge();
    if (n) asstMarkSeen(n.key); else asstMarkSeen("intro");
    el("asstBadge").classList.add("hidden");
    if (!asstOpened) {
      asstOpened = true;
      el("asstBody").innerHTML = "";
      asstAsk("hi");
    } else if (n) {
      setTimeout(function () { asstPush(n.text, false); }, 200); // açıkken yeni olayı hatırlat
    }
  }

  function bindAssistant() {
    var chips = el("asstChips");
    asstChips().forEach(function (c) {
      var b = document.createElement("button");
      b.className = "asst-chip";
      b.textContent = c.t;
      b.addEventListener(TAP_EVT, function () { asstAsk(c.k, c.t); });
      chips.appendChild(b);
    });
    el("asstFab").addEventListener(TAP_EVT, function () {
      var panel = el("asstPanel");
      if (panel.classList.contains("hidden")) asstOpen();
      else panel.classList.add("hidden");
    });
    el("asstClose").addEventListener(TAP_EVT, function () { el("asstPanel").classList.add("hidden"); });
    var form = el("asstForm");
    if (form) form.addEventListener("submit", function (ev) { ev.preventDefault(); asstSubmit(); });
    refreshAsst();
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
          updateWeatherUI(data.temp, data.code);
          return;
        }
      } catch (e) {}
    }

    function getWeather(lat, lon) {
      var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current_weather=true";
      fetch(url).then(function (res) { return res.json(); }).then(function (data) {
        if (data && data.current_weather) {
          var w = data.current_weather;
          updateWeatherUI(w.temperature, w.weathercode);
          localStorage.setItem(CACHE_KEY, JSON.stringify({ temp: w.temperature, code: w.weathercode, ts: Date.now() }));
        }
      }).catch(function () {});
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function (pos) { getWeather(pos.coords.latitude, pos.coords.longitude); },
        function () { getWeather(41.01, 28.97); }, // Fallback Istanbul
        { timeout: 5000 }
      );
    } else {
      getWeather(41.01, 28.97); // Fallback Istanbul
    }
  }

  var currentTemp = null;
  var currentCode = null;

  function updatePortalZivana() {
    var tipEl = el("portalZivanaTip");
    if (!tipEl) return;
    var hour = new Date().getHours();
    var msg = "Bugün nasıl hissediyoruz?";
    if (currentTemp !== null) {
      if (currentTemp > 28) msg = "Hava " + Math.round(currentTemp) + "°C! Buz gibi bir Bira harika gider 🍺";
      else if (currentTemp < 10) msg = "Dışarısı " + Math.round(currentTemp) + "°C, çok soğuk! Sigo'yu içeride mi sarsak? 🥶";
      else if (currentCode >= 51 && currentCode <= 67) msg = "Yağmur yağıyor 🌧️ Tam cam kenarı Sigo havası!";
      else if (hour < 12) msg = "Günaydın! Sabahın ilk sigarası yandı mı? 🌅";
      else if (hour > 22) msg = "Gece uzun... Dumanaltı mesaisi devam ediyor 🌙";
      else msg = "Günün keyfini çıkar! Hava mis gibi " + Math.round(currentTemp) + "°C.";
    } else {
      if (hour < 12) msg = "Günaydın! Sabahın ilk sigarası yandı mı? 🌅";
      else if (hour > 22) msg = "Gece uzun... Dumanaltı mesaisi devam ediyor 🌙";
      else msg = "Zıvana düşünüyor... Bugün ne içsek?";
    }
    tipEl.textContent = msg;
  }

  function fetchWeather() {
    var CACHE_KEY = "dumanalti.weather";
    var CACHE_TTL = 30 * 60 * 1000; // 30 minutes
    var cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        var data = JSON.parse(cached);
        if (Date.now() - data.ts < CACHE_TTL) {
          updateWeatherUI(data.temp, data.code);
          return;
        }
      } catch (e) {}
    }

    function getWeather(lat, lon) {
      var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current_weather=true";
      fetch(url).then(function (res) { return res.json(); }).then(function (data) {
        if (data && data.current_weather) {
          var w = data.current_weather;
          updateWeatherUI(w.temperature, w.weathercode);
          localStorage.setItem(CACHE_KEY, JSON.stringify({ temp: w.temperature, code: w.weathercode, ts: Date.now() }));
        }
      }).catch(function () {});
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function (pos) { getWeather(pos.coords.latitude, pos.coords.longitude); },
        function () { getWeather(41.01, 28.97); }, // Fallback Istanbul
        { timeout: 5000 }
      );
    } else {
      getWeather(41.01, 28.97); // Fallback Istanbul
    }
  }

  function updateWeatherUI(temp, code) {
    currentTemp = temp;
    currentCode = code;
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
    updatePortalZivana();
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
      asstStats: asstStats,
      asstLongestGap: asstLongestGap,
      asstRunningGap: asstRunningGap,
      asstBelowAvgStreak: asstBelowAvgStreak,
      asstRecordDay: asstRecordDay,
      asstNudge: asstNudge,
      asstReply: asstReply,
      asstRoute: asstRoute,
      asstChips: asstChips,
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
      updateEntry: updateEntry
    };
  }
})();
