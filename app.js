/* Dumanaltı — Utku & Gözde sigara takip PWA
   Veriler Supabase'de bulutta tutulur ve cihazlar arasında gerçek zamanlı
   senkronlanır. Çevrimdışıyken yerel önbellekten okunur, internet gelince
   bekleyen kayıtlar otomatik gönderilir. */

(function () {
  "use strict";

  // Semver: majör = büyük yeniden tasarım, minör = yeni özellik, patch = ince ayar.
  // Derleme numarası service worker önbellek sürümüyle (her dağıtımda artar) aynı.
  var APP_VERSION = "2.10.0";
  var APP_BUILD = 43;

  var CACHE_KEY = "dumanalti.entries.v1";   // çevrimdışı okuma önbelleği
  var OUTBOX_KEY = "dumanalti.outbox.v1";    // gönderilemeyen işlemler
  var THEME_KEY = "dumanalti.theme";
  var SETTINGS_KEY = "dumanalti.settings.v1";

  var CFG = window.DUMANALTI_CONFIG || {};
  var TABLE = CFG.table || "dumanalti_entries";

  var WHO = {
    utku:  { label: "Utku", emoji: "🧔", avatar: "icons/avatar-utku.png", cls: "utku-bg" },
    gozde: { label: "Gözde", emoji: "👩", avatar: "icons/avatar-gozde.png", cls: "gozde-bg" },
    both:  { label: "Ortak", emoji: "👩‍❤️‍👨", avatar: "icons/avatar-both.png", cls: "both-bg" }
  };

  function makeAvatar(who, cls) {
    var img = document.createElement("img");
    img.className = "avatar" + (cls ? " " + cls : "");
    img.src = WHO[who].avatar;
    img.alt = WHO[who].label;
    return img;
  }

  var settings = { dailyLimit: 0 };

  var DAY_NAMES = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];

  /** @type {{id:string, who:string, ts:number}[]} */
  var entries = [];
  /** @type {{type:string, row?:object, id?:string}[]} */
  var outbox = [];
  var lastUndo = null;
  var undoTimer = null;
  var comboCount = 0;
  var comboTimer = null;
  var historyFilter = "all";
  var statsScope = "all"; // İstatistik kişi filtresi: all | both | gozde | utku
  var scopeIncludeBoth = true; // Gözde/Utku seçiliyken ortak içilenler dahil mi

  function scopedEntries() {
    if (statsScope === "both") return entries.filter(function (e) { return e.who === "both"; });
    if (statsScope === "gozde") return entries.filter(function (e) { return e.who === "gozde" || (scopeIncludeBoth && e.who === "both"); });
    if (statsScope === "utku") return entries.filter(function (e) { return e.who === "utku" || (scopeIncludeBoth && e.who === "both"); });
    return entries;
  }

  var sb = null;        // Supabase client
  var cloudReady = false;
  var lastCloudError = null;

  function cloudError(err) {
    var msg = (err && (err.message || err.error_description || err.details)) || String(err);
    lastCloudError = msg;
    try { console.error("Dumanaltı bulut hatası:", err); } catch (e) {}
    refreshStatus();
  }

  // ---------- Local cache ----------
  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      entries = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(entries)) entries = [];
      sortEntries();
    } catch (e) { entries = []; }
    try {
      var ob = localStorage.getItem(OUTBOX_KEY);
      outbox = ob ? JSON.parse(ob) : [];
      if (!Array.isArray(outbox)) outbox = [];
    } catch (e) { outbox = []; }
  }

  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(entries)); } catch (e) {}
  }
  function saveOutbox() {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); } catch (e) {}
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (s && typeof s === "object") {
        settings.dailyLimit = +s.dailyLimit || 0;
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
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function dayKey(d) {
    var x = startOfDay(d);
    return x.getFullYear() + "-" + (x.getMonth() + 1) + "-" + x.getDate();
  }
  function isSameDay(a, b) { return dayKey(a) === dayKey(b); }
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
    var c = { utku: 0, gozde: 0, both: 0, total: 0 };
    for (var i = 0; i < list.length; i++) {
      var w = list[i].who;
      if (c[w] === undefined) c[w] = 0;
      c[w]++;
      c.total++;
    }
    return c;
  }
  function entriesSince(ts) { return entries.filter(function (e) { return e.ts >= ts; }); }
  function todayEntries() { return entries.filter(function (e) { return isSameDay(e.ts, Date.now()); }); }

  // ---------- Rendering ----------
  function el(id) { return document.getElementById(id); }

  function render() {
    renderToday();
    renderLimit();
    renderStatCards();
    renderChart();
    renderSince();
    renderHourly();
    renderShare();
    renderDow();
    renderCalendar();
    renderRecords();
    renderInsights();
    renderHistory();
    if (el("setCount")) el("setCount").textContent = entries.length;
  }

  function renderToday() {
    var t = countWho(todayEntries());
    el("todayUtku").textContent = t.utku + t.both;
    el("todayGozde").textContent = t.gozde + t.both;
    el("todayTotal").textContent = t.total;

    el("btnTodayUtku").textContent = "bugün " + (t.utku + t.both);
    el("btnTodayGozde").textContent = "bugün " + (t.gozde + t.both);
    el("btnTodayBoth").textContent = "bugün " + t.both;

    var now = new Date();
    el("todayDate").textContent =
      ("0" + now.getDate()).slice(-2) + "." + ("0" + (now.getMonth() + 1)).slice(-2) + "." + now.getFullYear();

    var lastSmoke = el("lastSmoke");
    lastSmoke.innerHTML = "";
    if (entries.length) {
      var last = entries[entries.length - 1];
      lastSmoke.appendChild(makeAvatar(last.who, "avatar-sm"));
      lastSmoke.appendChild(document.createTextNode(" " + WHO[last.who].label + " · " + relativeTime(last.ts)));
    } else {
      lastSmoke.textContent = "—";
    }
  }

  function breakdownText(c) {
    return "🧔 " + (c.utku + c.both) + " · 👩 " + (c.gozde + c.both) + " · 👩‍❤️‍👨 " + c.both;
  }

  function renderStatCards() {
    var list = scopedEntries();
    var showBreakdown = statsScope === "all";

    var week = countWho(list.filter(function (e) { return e.ts >= startOfWeek(Date.now()).getTime(); }));
    el("weekTotal").textContent = week.total;
    el("weekBreakdown").textContent = showBreakdown ? (week.total ? breakdownText(week) : "—") : "";

    var monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    var month = countWho(list.filter(function (e) { return e.ts >= monthStart.getTime(); }));
    el("monthTotal").textContent = month.total;
    el("monthBreakdown").textContent = showBreakdown ? (month.total ? breakdownText(month) : "—") : "";

    var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
    var last7 = list.filter(function (e) { return e.ts >= sevenAgo; });
    el("dailyAvg").textContent = (last7.length / 7).toFixed(1);

    var all = countWho(list);
    el("allTotal").textContent = all.total;
    el("allBreakdown").textContent = showBreakdown ? (all.total ? breakdownText(all) : "—") : "";
  }

  function renderChart() {
    var chart = el("chart");
    chart.innerHTML = "";
    var days = [];
    var maxTotal = 1;
    var scoped = scopedEntries();

    for (var i = 6; i >= 0; i--) {
      var d = startOfDay(Date.now());
      d.setDate(d.getDate() - i);
      var key = dayKey(d);
      var dayList = scoped.filter(function (e) { return dayKey(e.ts) === key; });
      var c = countWho(dayList);
      if (c.total > maxTotal) maxTotal = c.total;
      days.push({ date: d, counts: c, isToday: i === 0 });
    }

    days.forEach(function (day) {
      var col = document.createElement("div");
      col.className = "chart-col" + (day.isToday ? " is-today" : "");

      var total = day.counts.total;
      if (total === 0) {
        var empty = document.createElement("div");
        empty.className = "bar-empty";
        col.appendChild(empty);
      } else {
        var totalLabel = document.createElement("span");
        totalLabel.className = "bar-total";
        totalLabel.textContent = total;
        col.appendChild(totalLabel);

        var stack = document.createElement("div");
        stack.className = "bar-stack";
        var maxPx = 110;
        var h = Math.max(6, Math.round((total / maxTotal) * maxPx));
        stack.style.height = h + "px";

        ["utku", "gozde", "both"].forEach(function (w) {
          if (day.counts[w] > 0) {
            var seg = document.createElement("div");
            seg.className = "bar-seg " + WHO[w].cls;
            seg.style.height = (day.counts[w] / total * 100) + "%";
            stack.appendChild(seg);
          }
        });
        col.appendChild(stack);
      }

      var label = document.createElement("span");
      label.className = "bar-label";
      label.textContent = day.isToday ? "Bugün" : DAY_NAMES[day.date.getDay()];
      col.appendChild(label);

      chart.appendChild(col);
    });
  }

  function renderInsights() {
    var list = el("insightList");
    list.innerHTML = "";
    var items = [];
    var all = countWho(entries);

    if (all.total === 0) {
      items.push({ e: "✨", t: "Henüz veri yok. İlk sigarayı eklediğinde burada istatistikler çıkacak." });
    } else {
      var duel = weeklyDuelText();
      if (duel) items.push({ e: "🥇", t: duel });

      var utkuTotal = all.utku + all.both;
      var gozdeTotal = all.gozde + all.both;
      if (utkuTotal > gozdeTotal) {
        items.push({ e: "🏆", t: "Utku toplamda " + (utkuTotal - gozdeTotal) + " sigara önde (" + utkuTotal + " - " + gozdeTotal + ")." });
      } else if (gozdeTotal > utkuTotal) {
        items.push({ e: "🏆", t: "Gözde toplamda " + (gozdeTotal - utkuTotal) + " sigara önde (" + gozdeTotal + " - " + utkuTotal + ")." });
      } else {
        items.push({ e: "🤝", t: "Tam berabere! İkiniz de " + utkuTotal + " sigara." });
      }

      var pct = Math.round(all.both / all.total * 100);
      items.push({ av: "both", t: "Sigaraların %" + pct + "'ini birlikte içtiniz." });

      var byDay = {};
      entries.forEach(function (e) { var k = dayKey(e.ts); byDay[k] = (byDay[k] || 0) + 1; });
      var maxDay = null, maxCount = 0;
      Object.keys(byDay).forEach(function (k) { if (byDay[k] > maxCount) { maxCount = byDay[k]; maxDay = k; } });
      if (maxDay) {
        var parts = maxDay.split("-");
        var dd = ("0" + parts[2]).slice(-2) + "." + ("0" + parts[1]).slice(-2);
        items.push({ e: "📈", t: "En yoğun gün: " + dd + " (" + maxCount + " sigara)." });
      }

      var todayCount = todayEntries().length;
      var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
      var avg = entriesSince(sevenAgo).length / 7;
      if (todayCount > 0 && avg > 0) {
        if (todayCount < avg) {
          items.push({ e: "🌿", t: "Bugün ortalamanın altındasınız (" + todayCount + " < " + avg.toFixed(1) + "). Aferin!" });
        } else if (todayCount > avg) {
          items.push({ e: "⚠️", t: "Bugün ortalamanın üstündesiniz (" + todayCount + " > " + avg.toFixed(1) + ")." });
        }
      }

      var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      items.push({ e: "📅", t: "Bu ay toplam " + entriesSince(monthStart.getTime()).length + " sigara." });

      items.push({ e: "📊", t: "Son 7 günde günde ortalama " + avg.toFixed(1) + " sigara." });

      var byDow = [0, 0, 0, 0, 0, 0, 0];
      entries.forEach(function (e) { byDow[new Date(e.ts).getDay()]++; });
      var maxDow = 0;
      for (var w = 1; w < 7; w++) if (byDow[w] > byDow[maxDow]) maxDow = w;
      var DOW_FULL = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
      items.push({ e: "🗓️", t: "En çok " + DOW_FULL[maxDow] + " içiyorsunuz." });

      if (entries.length) {
        var last = entries[entries.length - 1];
        items.push({ e: "⏱️", t: "Son sigaradan bu yana " + relativeTime(last.ts).replace(" önce", "") + " geçti." });
      }
    }

    items.slice(0, 7).forEach(function (it) {
      var li = document.createElement("li");
      var span = it.av ? makeAvatar(it.av, "avatar-tiny") : document.createElement("span");
      if (!it.av) { span.className = "emoji"; span.textContent = it.e; }
      var txt = document.createElement("span");
      txt.textContent = it.t;
      li.appendChild(span);
      li.appendChild(txt);
      list.appendChild(li);
    });
  }

  function isPending(id) {
    for (var i = 0; i < outbox.length; i++) {
      if (outbox[i].type === "insert" && outbox[i].row && outbox[i].row.id === id) return true;
    }
    return false;
  }

  function dayLabel(ts) {
    var diff = Math.round((startOfDay(Date.now()).getTime() - startOfDay(ts).getTime()) / 86400000);
    if (diff === 0) return "Bugün";
    if (diff === 1) return "Dün";
    var d = new Date(ts);
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
    who.textContent = WHO[e.who].label + " içti";
    var time = document.createElement("span");
    time.className = "h-time";
    time.textContent = formatTime(e.ts) + " · " + relativeTime(e.ts) + (pending ? " · ⏳ bekliyor" : "");
    main.appendChild(who);
    main.appendChild(time);

    var del = document.createElement("button");
    del.className = "h-del";
    del.textContent = "✕";
    del.title = "Sil";
    del.addEventListener("click", function () { deleteEntry(e.id); });

    row.appendChild(em);
    row.appendChild(main);
    row.appendChild(del);
    return row;
  }

  function renderHistory() {
    var list = el("historyList");
    var empty = el("historyEmpty");
    list.innerHTML = "";
    el("historyCount").textContent = entries.length ? entries.length + " kayıt" : "";

    var filtered = entries.filter(function (e) { return historyFilter === "all" || e.who === historyFilter; });
    if (filtered.length === 0) {
      empty.classList.remove("hidden");
      empty.textContent = entries.length ? "Bu filtrede kayıt yok." : "Henüz kayıt yok. Anasayfadaki butonlardan birine bas 👆";
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
      var cnt = document.createElement("span");
      cnt.className = "hist-day-count";
      cnt.textContent = g.items.length + " 🚬";
      head.appendChild(lbl);
      head.appendChild(cnt);
      list.appendChild(head);
      g.items.forEach(function (e) { list.appendChild(historyItem(e)); });
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
    // Ortak içilen sigara, Utku ve Gözde'nin de sayacını sıfırlar.
    var sub = entries.filter(function (e) {
      return e.who === who || (who !== "both" && e.who === "both");
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

  function renderHourly() {
    var chart = el("hourChart");
    if (!chart) return;
    chart.innerHTML = "";
    var list = scopedEntries();
    var counts = [];
    for (var h = 0; h < 24; h++) counts[h] = 0;
    list.forEach(function (e) { counts[new Date(e.ts).getHours()]++; });
    var max = 1, peakH = 0;
    for (h = 0; h < 24; h++) {
      if (counts[h] > max) max = counts[h];
      if (counts[h] > counts[peakH]) peakH = h;
    }
    for (h = 0; h < 24; h++) {
      var col = document.createElement("div");
      col.className = "hour-col";
      col.setAttribute("data-h", h);
      col.setAttribute("data-count", counts[h]);
      var bar = document.createElement("div");
      bar.className = "hour-bar" + (h === peakH && counts[peakH] > 0 ? " peak" : "");
      bar.style.height = (counts[h] === 0 ? 2 : Math.max(4, Math.round(counts[h] / max * 100))) + "%";
      bar.title = pad2(h) + ":00 · " + counts[h];
      col.appendChild(bar);
      if (h % 6 === 0) {
        var lab = document.createElement("span");
        lab.className = "hour-lab";
        lab.textContent = h;
        col.appendChild(lab);
      }
      chart.appendChild(col);
    }
    el("hourPeak").textContent = list.length ? "en yoğun " + pad2(peakH) + ":00" : "";

    // Bara dokununca o saatte kaç sigara içildiğini balonda göster
    if (!chart.hourTipBound) {
      chart.hourTipBound = true;
      chart.addEventListener("click", function (ev) {
        var c = ev.target.closest ? ev.target.closest(".hour-col") : null;
        showHourTip(chart, c);
      });
    }
  }

  function showHourTip(chart, col) {
    var old = chart.querySelector(".hour-tip");
    var prevSel = chart.querySelector(".hour-bar.sel");
    if (prevSel) prevSel.classList.remove("sel");
    var oldH = old ? old.getAttribute("data-h") : null;
    if (old) old.remove();
    if (!col || oldH === col.getAttribute("data-h")) return; // aynı bara ikinci dokunuş kapatır

    var h = parseInt(col.getAttribute("data-h"), 10);
    var count = col.getAttribute("data-count");
    col.querySelector(".hour-bar").classList.add("sel");

    var tip = document.createElement("div");
    tip.className = "hour-tip";
    tip.setAttribute("data-h", String(h));
    tip.textContent = pad2(h) + ":00–" + pad2(h) + ":59 · " + count + " sigara";
    chart.appendChild(tip);
    // kolonun ortasına hizala, kenarlardan taşmasın
    var x = col.offsetLeft + col.offsetWidth / 2 - tip.offsetWidth / 2;
    x = Math.max(0, Math.min(chart.clientWidth - tip.offsetWidth, x));
    tip.style.left = x + "px";
  }

  function renderShare() {
    var bar = el("shareBar");
    if (!bar) return;
    var card = el("shareCard");
    if (card) card.classList.toggle("hidden", statsScope !== "all");
    if (statsScope !== "all") return;
    var c = countWho(entries);
    var total = c.total || 1;
    bar.innerHTML = "";
    ["utku", "gozde", "both"].forEach(function (w) {
      if (c[w] > 0) {
        var seg = document.createElement("div");
        seg.className = "share-seg " + WHO[w].cls;
        seg.style.width = (c[w] / total * 100) + "%";
        seg.title = WHO[w].label + " " + c[w];
        bar.appendChild(seg);
      }
    });
    var leg = el("shareLegend");
    leg.innerHTML = "";
    ["utku", "gozde", "both"].forEach(function (w) {
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
    list.forEach(function (e) { counts[(new Date(e.ts).getDay() + 6) % 7]++; });
    var max = 1, peak = 0;
    for (var i = 0; i < 7; i++) { if (counts[i] > max) max = counts[i]; if (counts[i] > counts[peak]) peak = i; }
    var labels = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
    for (i = 0; i < 7; i++) {
      var col = document.createElement("div");
      col.className = "dow-col";
      var v = document.createElement("span");
      v.className = "dow-val";
      v.textContent = counts[i] || "";
      var bar = document.createElement("div");
      bar.className = "dow-bar" + (i === peak && counts[peak] > 0 ? " peak" : "");
      bar.style.height = (counts[i] === 0 ? 3 : Math.max(6, Math.round(counts[i] / max * 100))) + "%";
      var l = document.createElement("span");
      l.className = "dow-lab";
      l.textContent = labels[i];
      col.appendChild(v); col.appendChild(bar); col.appendChild(l);
      chart.appendChild(col);
    }
    var DOW_FULL = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
    el("dowPeak").textContent = list.length ? "en çok " + DOW_FULL[peak] : "";
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
    var parts = maxDay.split("-");
    var dd = ("0" + parts[2]).slice(-2) + "." + ("0" + parts[1]).slice(-2) + "." + parts[0];

    var maxGap = 0;
    for (var i = 1; i < list.length; i++) { var g = list[i].ts - list[i - 1].ts; if (g > maxGap) maxGap = g; }
    maxGap = Math.max(maxGap, Date.now() - list[list.length - 1].ts);

    var firstDay = startOfDay(list[0].ts).getTime();
    var lastDay = startOfDay(list[list.length - 1].ts).getTime();
    var free = 0;
    for (var t = firstDay; t <= lastDay; t += 86400000) { if (!byDay[dayKey(t)]) free++; }
    var span = Math.round((lastDay - firstDay) / 86400000) + 1;

    var items = [
      { e: "🔥", t: "Tek günde rekor: " + maxC + " sigara (" + dd + ")" },
      { e: "⏱️", t: "En uzun ara: " + fmtCoarse(maxGap) },
      { e: "🧹", t: "Sigarasız gün: " + free },
      { e: "📆", t: "Takip süresi: " + span + " gün" }
    ];
    items.forEach(function (it) {
      var row = document.createElement("div");
      row.className = "record-row";
      var em = document.createElement("span");
      em.className = "record-emoji";
      em.textContent = it.e;
      var tx = document.createElement("span");
      tx.textContent = it.t;
      row.appendChild(em); row.appendChild(tx);
      node.appendChild(row);
    });
  }

  function renderCalendar() {
    var grid = el("calGrid");
    if (!grid) return;
    grid.innerHTML = "";
    var now = new Date();
    var year = now.getFullYear(), month = now.getMonth();
    el("calTitle").textContent = MONTHS[month] + " " + year;

    var perDay = {};
    scopedEntries().forEach(function (e) {
      var d = new Date(e.ts);
      if (d.getFullYear() === year && d.getMonth() === month) perDay[d.getDate()] = (perDay[d.getDate()] || 0) + 1;
    });

    var offset = (new Date(year, month, 1).getDay() + 6) % 7; // Pzt=0
    var daysIn = new Date(year, month + 1, 0).getDate();
    for (var i = 0; i < offset; i++) {
      var blank = document.createElement("span");
      blank.className = "cal-cell blank";
      grid.appendChild(blank);
    }
    for (var day = 1; day <= daysIn; day++) {
      var c = perDay[day] || 0;
      var lvl = c === 0 ? 0 : c <= 2 ? 1 : c <= 4 ? 2 : c <= 6 ? 3 : 4;
      var cell = document.createElement("span");
      cell.className = "cal-cell l" + lvl + (day === now.getDate() ? " today" : "");
      cell.title = day + " " + MONTHS[month] + " · " + c + " sigara";
      cell.textContent = day;
      grid.appendChild(cell);
    }
  }

  function weeklyDuelText() {
    var sow = startOfWeek(Date.now()).getTime();
    var c = countWho(entries.filter(function (e) { return e.ts >= sow; }));
    var u = c.utku + c.both, g = c.gozde + c.both;
    if (u === 0 && g === 0) return null;
    if (u < g) return "Bu hafta düello: Utku daha az içti (" + u + " - " + g + ").";
    if (g < u) return "Bu hafta düello: Gözde daha az içti (" + g + " - " + u + ").";
    return "Bu hafta düello: berabere (" + u + " - " + g + ").";
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
    ring.style.strokeDasharray = RING_C;
    ring.style.strokeDashoffset = RING_C * (1 - pct);

    var color = "#36d399";
    if (today > lim) color = "var(--danger)";
    else if (pct >= 0.8) color = "var(--accent)";
    ring.style.stroke = color;

    el("limitText").textContent = today + " / " + lim;
    el("limitSub").textContent = today > lim ? "limit aşıldı!" : (lim - today) + " kaldı";
    el("limitSub").style.color = today > lim ? "var(--danger)" : "var(--muted)";
  }

  // ---------- Status ----------
  function setStatus(text, state) {
    var node = el("cloudStatus");
    if (!node) return;
    var textNode = el("cloudStatusText");
    if (textNode) textNode.textContent = text; else node.textContent = text;
    node.className = "cloud-status status-" + (state || "offline");
  }
  function refreshStatus() {
    if (!sb) { setStatus("📴 Yerel mod · bulut kapalı", "offline"); return; }
    if (!navigator.onLine) { setStatus("📴 Çevrimdışı · gelince senkronlanır", "offline"); return; }
    if (lastCloudError) { setStatus("⚠️ Bulut hatası: " + lastCloudError + " · " + outbox.length + " bekliyor", "error"); return; }
    if (outbox.length) { setStatus("⏳ " + outbox.length + " kayıt bekliyor…", "syncing"); return; }
    setStatus(cloudReady ? "☁️ Bulutta senkron · ortak görünüm" : "☁️ Bağlanıyor…", cloudReady ? "online" : "syncing");
  }

  // ---------- Actions ----------
  function addEntry(who, x, y) {
    var entry = { id: uuid(), who: who, ts: Date.now() };
    entries.push(entry);
    sortEntries();
    // Optimistic UI: önce kuyruğa al, sonra anında çiz (bekliyor işareti doğru görünsün)
    outbox.push({ type: "insert", row: entry });
    saveCache();
    saveOutbox();
    render();
    showUndo(who);
    var combo = bumpCombo();
    emojiConfetti(who, x, y, combo);
    if (combo >= 3) showCombo(combo);
    if (navigator.vibrate) navigator.vibrate(combo >= 3 ? [15, 30, 15] : 15);

    flushOutbox();
    refreshStatus();
  }

  function deleteEntry(id) {
    var idx = findIndexById(id);
    if (idx === -1) return;
    entries.splice(idx, 1);
    saveCache();
    render();

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

  function showUndo(who) {
    lastUndo = entries[entries.length - 1];
    var bar = el("undoBar");
    var ut = el("undoText");
    ut.innerHTML = "";
    ut.appendChild(makeAvatar(who, "avatar-sm"));
    ut.appendChild(document.createTextNode(" " + WHO[who].label + " eklendi"));
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
    both:  ["#b07bff", "#7d4fd6", "#4f9dff", "#ff5fa2", "#ffffff", "#ffd166"]
  };

  var confettiCanvas = null, confettiCtx = null, confettiParticles = [], confettiRunning = false;
  var confettiAvatarImgs = {};

  function confettiAvatarImg(who) {
    if (!confettiAvatarImgs[who]) {
      var img = new Image();
      img.src = WHO[who].avatar;
      confettiAvatarImgs[who] = img;
    }
    return confettiAvatarImgs[who];
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
        gravity: 1.8,
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

  function confettiFrame() {
    ensureConfettiCanvas();
    var ctx = confettiCtx;
    var W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);

    var alive = [];
    for (var i = 0; i < confettiParticles.length; i++) {
      var p = confettiParticles[i];
      p.x += Math.cos(p.angle2D) * p.velocity + p.drift;
      p.y += Math.sin(p.angle2D) * p.velocity + p.gravity;
      p.velocity *= p.decay;          // hız sönümlenir, sonra sabit süzülme kalır
      p.wobble += p.wobbleSpeed;      // yana doğru salınım
      p.tiltAngle += p.tiltSpeed;     // 3B takla dönüşü
      p.tick++;

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
        var img = confettiAvatarImg(p.who);
        if (img.complete && img.naturalWidth) {
          var s = p.size * p.scalar;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(0.35 * wobX);
          // takla: dikey eksende daralıp genişleme (madeni para dönüşü)
          ctx.scale(1, 0.45 + 0.55 * Math.abs(tiltCos));
          ctx.drawImage(img, -s / 2, -s / 2, s, s);
          ctx.restore();
        }
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(0.5 * wobX);
        ctx.font = (p.size * p.scalar) + "px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(p.emoji, 0, 0);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    confettiParticles = alive;

    if (confettiParticles.length) {
      requestAnimationFrame(confettiFrame);
    } else {
      confettiRunning = false;
      ctx.clearRect(0, 0, W, H);
    }
  }

  function emojiConfetti(who, x, y, combo) {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var W = window.innerWidth, H = window.innerHeight;
    var ox = x != null ? x : W / 2;
    var oy = y != null ? y : H / 2;
    combo = combo || 1;

    if (!reduce) {
      screenShake(combo);
      flashAt(ox, oy);
    }

    ensureConfettiCanvas();
    var total = reduce ? 14 : Math.min(240, 110 + (combo - 1) * 30);
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

    if (!confettiRunning) {
      confettiRunning = true;
      requestAnimationFrame(confettiFrame);
    }
  }

  function screenShake(combo) {
    var app = document.querySelector(".app") || document.body;
    app.classList.remove("shake");
    void app.offsetWidth;
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

    flushOutbox().then(syncFromRemote).then(subscribeRealtime);

    window.addEventListener("online", function () {
      flushOutbox().then(syncFromRemote);
      refreshStatus();
    });
    window.addEventListener("offline", refreshStatus);
  }

  function flushOutbox() {
    if (!sb || !navigator.onLine || outbox.length === 0) return Promise.resolve();
    var queue = outbox.slice();
    var firstErr = null;

    function step(i) {
      if (i >= queue.length) return Promise.resolve();
      var op = queue[i];
      var p;
      if (op.type === "insert") {
        p = sb.from(TABLE).upsert(op.row, { onConflict: "id", ignoreDuplicates: true });
      } else if (op.type === "update") {
        p = sb.from(TABLE).update({ tag: op.tag }).eq("id", op.id);
      } else {
        p = sb.from(TABLE).delete().eq("id", op.id);
      }
      return p.then(function (res) {
        if (res && res.error) throw res.error;
        // başarılı: gerçek kuyruktan bu işlemi çıkar
        var idx = outbox.indexOf(op);
        if (idx !== -1) { outbox.splice(idx, 1); saveOutbox(); }
      }).catch(function (err) {
        // bu işlemi kuyrukta bırak ama diğerlerini engelleme
        if (!firstErr) firstErr = err;
      }).then(function () { return step(i + 1); });
    }

    return step(0).then(function () {
      render(); // senkronlananların "bekliyor" işareti kalksın
      if (firstErr) { cloudError(firstErr); }
      else { lastCloudError = null; refreshStatus(); }
    });
  }

  function syncFromRemote() {
    if (!sb || !navigator.onLine) return Promise.resolve();
    return sb.from(TABLE).select("id,who,ts,tag").order("ts", { ascending: true }).then(function (res) {
      if (res.error) { cloudError(res.error); return; }
      if (!res.data) return;
      var map = {};
      res.data.forEach(function (r) {
        var o = { id: r.id, who: r.who, ts: Number(r.ts) };
        if (r.tag) o.tag = r.tag;
        map[r.id] = o;
      });
      // Henüz gönderilmemiş yerel işlemleri uzaktaki veriye uygula
      outbox.forEach(function (op) {
        if (op.type === "insert" && op.row) map[op.row.id] = op.row;
        else if (op.type === "delete") delete map[op.id];
        else if (op.type === "update" && map[op.id]) map[op.id].tag = op.tag || undefined;
      });
      entries = Object.keys(map).map(function (k) { return map[k]; });
      sortEntries();
      saveCache();
      cloudReady = true;
      render();
      refreshStatus();
    }).catch(function (err) { cloudError(err); });
  }

  function subscribeRealtime() {
    if (!sb) return;
    sb.channel("dumanalti-" + TABLE)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: TABLE }, function (payload) {
        var r = payload.new;
        if (!r || findIndexById(r.id) !== -1) return;
        var o = { id: r.id, who: r.who, ts: Number(r.ts) };
        if (r.tag) o.tag = r.tag;
        entries.push(o);
        sortEntries();
        saveCache();
        render();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: TABLE }, function (payload) {
        var r = payload.new;
        var idx = r ? findIndexById(r.id) : -1;
        if (idx === -1) return;
        entries[idx].tag = r.tag || undefined;
        saveCache();
        render();
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: TABLE }, function (payload) {
        var id = payload.old && payload.old.id;
        var idx = id ? findIndexById(id) : -1;
        if (idx === -1) return;
        entries.splice(idx, 1);
        saveCache();
        render();
      })
      .subscribe(function (status) {
        if (status === "SUBSCRIBED") { cloudReady = true; refreshStatus(); }
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          // Canlı güncelleme bağlanamadı; veri okuma/yazma yine de çalışır.
          console.warn("Realtime durumu:", status);
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
        var data = JSON.parse(reader.result);
        var incoming = Array.isArray(data) ? data : data.entries;
        if (!Array.isArray(incoming)) throw new Error("Geçersiz dosya");
        var map = {};
        entries.forEach(function (e) { map[e.id] = e; });
        var added = [];
        incoming.forEach(function (e) {
          if (e && e.who && e.ts) {
            var id = e.id || uuid();
            if (!map[id]) { var row = { id: id, who: e.who, ts: Number(e.ts) }; if (e.tag) row.tag = e.tag; map[id] = row; added.push(row); }
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
    entries = [];
    outbox = [];
    saveCache();
    saveOutbox();
    render();
    if (sb && navigator.onLine) {
      sb.from(TABLE).delete().neq("id", "00000000-0000-0000-0000-000000000000").then(function () {});
    }
    refreshStatus();
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    var light = theme === "light";
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
        b.classList.toggle("active", b.getAttribute("data-theme") === (light ? "light" : "dark"));
      });
    }
  }

  function syncNow() {
    if (!sb) { alert("Bulut bağlı değil — yerel moddasın."); return; }
    if (!navigator.onLine) { alert("Çevrimdışısın. İnternet gelince otomatik senkronlanır."); return; }
    lastCloudError = null;
    refreshStatus();
    flushOutbox().then(syncFromRemote).then(function () { refreshStatus(); });
  }
  function toggleTheme() {
    var current = localStorage.getItem(THEME_KEY) === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, current);
    applyTheme(current);
  }

  var TAB_KEY = "dumanalti.tab";
  function showTab(name) {
    ["home", "stats", "history", "settings"].forEach(function (n) {
      var v = el("view-" + n);
      if (v) v.classList.toggle("hidden", n !== name);
    });
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    try { localStorage.setItem(TAB_KEY, name); } catch (e) {}
    window.scrollTo(0, 0);
  }

  // ---------- Init ----------
  function bind() {
    document.querySelectorAll(".action-btn").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        // Çift tıklama (ghost click) koruması: kısa süre tekrar tetiklenmesin
        if (btn.dataset.lock === "1") return;
        btn.dataset.lock = "1";
        setTimeout(function () { btn.dataset.lock = "0"; }, 800);

        var who = btn.getAttribute("data-who");
        btn.classList.remove("pop");
        void btn.offsetWidth;
        btn.classList.add("pop");
        addEntry(who, ev.clientX, ev.clientY);
      });
    });

    el("undoBtn").addEventListener("click", undoLast);
    el("themeToggle").addEventListener("click", toggleTheme);
    el("exportBtn").addEventListener("click", exportData);
    el("importBtn").addEventListener("click", function () { el("importFile").click(); });
    el("importFile").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
      e.target.value = "";
    });
    el("resetBtn").addEventListener("click", resetData);

    // Sekmeler
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () { showTab(btn.getAttribute("data-tab")); });
    });
    showTab(localStorage.getItem(TAB_KEY) || "home");

    // Geçmiş filtreleri
    document.querySelectorAll(".hist-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        historyFilter = chip.getAttribute("data-f");
        document.querySelectorAll(".hist-chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
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
        render();
      });
    });

    // Gözde/Utku seçiliyken: ortak sigarayı dahil et/etme
    document.querySelectorAll("#scopeToggle .seg-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        scopeIncludeBoth = b.getAttribute("data-include") === "yes";
        document.querySelectorAll("#scopeToggle .seg-btn").forEach(function (x) { x.classList.toggle("active", x === b); });
        render();
      });
    });

    // Tema seçici
    document.querySelectorAll("#themeSeg .seg-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-theme");
        localStorage.setItem(THEME_KEY, t);
        applyTheme(t);
      });
    });

    if (el("syncNowBtn")) el("syncNowBtn").addEventListener("click", syncNow);

    // Ayarlar
    if (el("setLimit")) {
      el("setLimit").value = settings.dailyLimit || "";
      el("setLimit").addEventListener("input", function () { settings.dailyLimit = +this.value || 0; saveSettings(); renderLimit(); });
    }

    setInterval(function () { renderToday(); }, 60000);
    setInterval(function () { renderSince(); }, 1000);
  }

  function handleQuickAction() {
    // Ana ekran kısayolu / Siri Kısayolları'ndan ?add=utku|gozde|both ile açılırsa
    // uygulamayı açar açmaz o kaydı ekler (manifest.json "shortcuts").
    var who = new URLSearchParams(window.location.search).get("add");
    if (who !== "utku" && who !== "gozde" && who !== "both") return;
    history.replaceState(null, "", window.location.pathname);
    addEntry(who);
  }

  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  el("appVersion").textContent = "v" + APP_VERSION + " · derleme " + APP_BUILD;
  loadSettings();
  loadCache();
  bind();
  render();
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
})();
