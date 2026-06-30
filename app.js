/* Dumanaltı — Utku & Gözde sigara takip PWA
   Veriler Supabase'de bulutta tutulur ve cihazlar arasında gerçek zamanlı
   senkronlanır. Çevrimdışıyken yerel önbellekten okunur, internet gelince
   bekleyen kayıtlar otomatik gönderilir. */

(function () {
  "use strict";

  var CACHE_KEY = "dumanalti.entries.v1";   // çevrimdışı okuma önbelleği
  var OUTBOX_KEY = "dumanalti.outbox.v1";    // gönderilemeyen işlemler
  var THEME_KEY = "dumanalti.theme";
  var SETTINGS_KEY = "dumanalti.settings.v1";

  var CFG = window.DUMANALTI_CONFIG || {};
  var TABLE = CFG.table || "dumanalti_entries";

  var WHO = {
    utku:  { label: "Utku", emoji: "🧔", cls: "utku-bg" },
    gozde: { label: "Gözde", emoji: "👩", cls: "gozde-bg" },
    both:  { label: "Ortak", emoji: "👩‍❤️‍👨", cls: "both-bg" }
  };

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
    renderWeekCompare();
    renderHourly();
    renderCalendar();
    renderDuel();
    renderInsights();
    renderHistory();
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

    if (entries.length) {
      var last = entries[entries.length - 1];
      el("lastSmoke").textContent = WHO[last.who].emoji + " " + WHO[last.who].label + " · " + relativeTime(last.ts);
    } else {
      el("lastSmoke").textContent = "—";
    }
  }

  function breakdownText(c) {
    return "🧔 " + (c.utku + c.both) + " · 👩 " + (c.gozde + c.both) + " · 👩‍❤️‍👨 " + c.both;
  }

  function renderStatCards() {
    var week = countWho(entriesSince(startOfWeek(Date.now()).getTime()));
    el("weekTotal").textContent = week.total;
    el("weekBreakdown").textContent = week.total ? breakdownText(week) : "—";

    var monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    var month = countWho(entriesSince(monthStart.getTime()));
    el("monthTotal").textContent = month.total;
    el("monthBreakdown").textContent = month.total ? breakdownText(month) : "—";

    var sevenAgo = startOfDay(Date.now()).getTime() - 6 * 86400000;
    var last7 = entriesSince(sevenAgo);
    el("dailyAvg").textContent = (last7.length / 7).toFixed(1);

    var all = countWho(entries);
    el("allTotal").textContent = all.total;
    el("allBreakdown").textContent = all.total ? breakdownText(all) : "—";
  }

  function renderChart() {
    var chart = el("chart");
    chart.innerHTML = "";
    var days = [];
    var maxTotal = 1;

    for (var i = 6; i >= 0; i--) {
      var d = startOfDay(Date.now());
      d.setDate(d.getDate() - i);
      var key = dayKey(d);
      var dayList = entries.filter(function (e) { return dayKey(e.ts) === key; });
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
      items.push({ e: "👩‍❤️‍👨", t: "Sigaraların %" + pct + "'ini birlikte içtiniz." });

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

      if (entries.length) {
        var last = entries[entries.length - 1];
        items.push({ e: "⏱️", t: "Son sigaradan bu yana " + relativeTime(last.ts).replace(" önce", "") + " geçti." });
      }
    }

    items.forEach(function (it) {
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.className = "emoji";
      span.textContent = it.e;
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

  function renderHistory() {
    var list = el("historyList");
    var empty = el("historyEmpty");
    list.innerHTML = "";

    if (entries.length === 0) {
      empty.classList.remove("hidden");
      el("historyCount").textContent = "";
      return;
    }
    empty.classList.add("hidden");
    el("historyCount").textContent = entries.length + " kayıt";

    var recent = entries.slice(-30).reverse();
    recent.forEach(function (e) {
      var pending = isPending(e.id);
      var li = document.createElement("li");
      li.className = "history-item who-" + e.who + (pending ? " is-pending" : "");

      var em = document.createElement("span");
      em.className = "h-emoji";
      em.textContent = WHO[e.who].emoji;

      var main = document.createElement("div");
      main.className = "h-main";
      var who = document.createElement("span");
      who.className = "h-who";
      who.textContent = WHO[e.who].label + " içti";
      var time = document.createElement("span");
      time.className = "h-time";
      var d = new Date(e.ts);
      time.textContent = formatTime(e.ts) + " · " + ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + " · " + relativeTime(e.ts) + (pending ? " · ⏳ bekliyor" : "");
      main.appendChild(who);
      main.appendChild(time);

      var del = document.createElement("button");
      del.className = "h-del";
      del.textContent = "✕";
      del.title = "Sil";
      del.addEventListener("click", function () { deleteEntry(e.id); });

      li.appendChild(em);
      li.appendChild(main);
      li.appendChild(del);
      list.appendChild(li);
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
    var ids = { utku: "Utku", gozde: "Gozde", both: "Both" };
    Object.keys(ids).forEach(function (who) {
      var t = el("since" + ids[who]);
      var r = el("rec" + ids[who]);
      var d = sinceData(who);
      if (!d) { t.textContent = "—"; if (r) r.textContent = ""; return; }
      t.textContent = fmtDuration(d.since);
      if (r) r.textContent = "🏆 " + fmtDuration(d.record);
    });
  }

  function renderWeekCompare() {
    if (!el("wcThis")) return;
    var sow = startOfWeek(Date.now()).getTime();
    var sowLast = sow - 7 * 86400000;
    var thisW = entries.filter(function (e) { return e.ts >= sow; }).length;
    var lastW = entries.filter(function (e) { return e.ts >= sowLast && e.ts < sow; }).length;
    el("wcThis").textContent = thisW;
    el("wcLast").textContent = lastW;
    var trend = el("wcTrend");
    if (lastW === 0) {
      trend.textContent = thisW === 0 ? "—" : "yeni";
      trend.className = "wc-trend";
    } else {
      var pct = Math.round((thisW - lastW) / lastW * 100);
      if (pct < 0) { trend.textContent = "↓ %" + Math.abs(pct); trend.className = "wc-trend down"; }
      else if (pct > 0) { trend.textContent = "↑ %" + pct; trend.className = "wc-trend up"; }
      else { trend.textContent = "→ aynı"; trend.className = "wc-trend"; }
    }
  }

  function renderHourly() {
    var chart = el("hourChart");
    if (!chart) return;
    chart.innerHTML = "";
    var counts = [];
    for (var h = 0; h < 24; h++) counts[h] = 0;
    entries.forEach(function (e) { counts[new Date(e.ts).getHours()]++; });
    var max = 1, peakH = 0;
    for (h = 0; h < 24; h++) {
      if (counts[h] > max) max = counts[h];
      if (counts[h] > counts[peakH]) peakH = h;
    }
    for (h = 0; h < 24; h++) {
      var col = document.createElement("div");
      col.className = "hour-col";
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
    el("hourPeak").textContent = entries.length ? "en yoğun " + pad2(peakH) + ":00" : "";
  }

  function renderCalendar() {
    var grid = el("calGrid");
    if (!grid) return;
    grid.innerHTML = "";
    var now = new Date();
    var year = now.getFullYear(), month = now.getMonth();
    el("calTitle").textContent = MONTHS[month] + " " + year;

    var perDay = {};
    entries.forEach(function (e) {
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

  function renderDuel() {
    var node = el("duel");
    if (!node) return;
    node.innerHTML = "";
    var sow = startOfWeek(Date.now()).getTime();
    var c = countWho(entries.filter(function (e) { return e.ts >= sow; }));
    var u = c.utku + c.both, g = c.gozde + c.both;
    var maxv = Math.max(u, g, 1);

    function row(who, label, val) {
      var r = document.createElement("div");
      r.className = "duel-row";
      var name = document.createElement("span");
      name.className = "duel-name";
      name.textContent = label;
      var track = document.createElement("div");
      track.className = "duel-track";
      var fill = document.createElement("div");
      fill.className = "duel-fill " + WHO[who].cls;
      fill.style.width = Math.round(val / maxv * 100) + "%";
      track.appendChild(fill);
      var v = document.createElement("span");
      v.className = "duel-val";
      v.textContent = val;
      r.appendChild(name); r.appendChild(track); r.appendChild(v);
      return r;
    }
    node.appendChild(row("utku", "🧔 Utku", u));
    node.appendChild(row("gozde", "👩 Gözde", g));

    var verdict = document.createElement("div");
    verdict.className = "duel-verdict";
    if (u === 0 && g === 0) verdict.textContent = "Bu hafta henüz kayıt yok.";
    else if (u < g) verdict.textContent = "🥇 Utku bu hafta daha az içti (" + u + " - " + g + ")";
    else if (g < u) verdict.textContent = "🥇 Gözde bu hafta daha az içti (" + g + " - " + u + ")";
    else verdict.textContent = "🤝 Berabere (" + u + " - " + g + ")";
    node.appendChild(verdict);
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
    emojiConfetti(WHO[who].emoji, x, y, combo);
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
    el("undoText").textContent = WHO[who].emoji + " " + WHO[who].label + " eklendi";
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

  var CONFETTI_EXTRAS = ["✨", "🎉", "🎊", "💨", "🚬", "🥳", "⭐️", "💥"];

  function emojiConfetti(emoji, x, y, combo) {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var W = window.innerWidth, H = window.innerHeight;
    var ox = x != null ? x : W / 2;
    var oy = y != null ? y : H / 2;
    combo = combo || 1;

    if (!reduce) {
      screenShake(combo);
      flashAt(ox, oy);
    }

    var count = reduce ? 8 : Math.min(120, 55 + (combo - 1) * 18);

    for (var i = 0; i < count; i++) {
      var node = document.createElement("span");
      node.className = "confetti-piece";
      // İlk ~yarısı kutlama emojisi (kesin görünür), kalanı ilgili emoji
      var useExtra = i % 2 === 0; // bir bir kutlama emojisi serpiştir
      node.textContent = useExtra ? CONFETTI_EXTRAS[(Math.random() * CONFETTI_EXTRAS.length) | 0] : emoji;
      node.style.left = ox + "px";
      node.style.top = oy + "px";
      node.style.fontSize = (18 + Math.random() * 36) + "px";
      document.body.appendChild(node);

      var angle = Math.random() * Math.PI * 2;
      var speed = 6 + Math.random() * (13 + combo * 2);
      flyParticle(
        node,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed - (7 + Math.random() * 6) // yukarı doğru başlangıç ivmesi
      );
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

  function flyParticle(node, vx, vy) {
    var px = 0, py = 0, rot = 0;
    var vr = (Math.random() - 0.5) * 26;
    var gravity = 0.2;
    var start = null, max = 2600 + Math.random() * 1400;

    function frame(t) {
      if (start == null) start = t;
      var life = t - start;
      vy += gravity;
      vx *= 0.992;
      px += vx; py += vy; rot += vr;
      // çıkışta hızlı bir "pop" büyümesi
      var pop = life < 140 ? 0.3 + 0.7 * (life / 140) : 1;
      node.style.transform = "translate(" + px + "px," + py + "px) rotate(" + rot + "deg) scale(" + pop + ")";
      node.style.opacity = String(Math.max(0, 1 - life / max));
      if (life < max) { requestAnimationFrame(frame); }
      else { node.remove(); }
    }
    requestAnimationFrame(frame);
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
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
      el("themeToggle").textContent = "☀️";
    } else {
      document.documentElement.removeAttribute("data-theme");
      el("themeToggle").textContent = "🌙";
    }
  }
  function toggleTheme() {
    var current = localStorage.getItem(THEME_KEY) === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, current);
    applyTheme(current);
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

    // Ayarlar
    if (el("setLimit")) {
      el("setLimit").value = settings.dailyLimit || "";
      el("setLimit").addEventListener("input", function () { settings.dailyLimit = +this.value || 0; saveSettings(); renderLimit(); });
    }

    setInterval(function () { renderToday(); }, 60000);
    setInterval(function () { renderSince(); }, 1000);
  }

  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  loadSettings();
  loadCache();
  bind();
  render();
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
