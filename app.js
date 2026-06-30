/* Dumanaltı — Utku & Gözde sigara takip PWA
   Veriler Supabase'de bulutta tutulur ve cihazlar arasında gerçek zamanlı
   senkronlanır. Çevrimdışıyken yerel önbellekten okunur, internet gelince
   bekleyen kayıtlar otomatik gönderilir. */

(function () {
  "use strict";

  var CACHE_KEY = "dumanalti.entries.v1";   // çevrimdışı okuma önbelleği
  var OUTBOX_KEY = "dumanalti.outbox.v1";    // gönderilemeyen işlemler
  var THEME_KEY = "dumanalti.theme";

  var CFG = window.DUMANALTI_CONFIG || {};
  var TABLE = CFG.table || "dumanalti_entries";

  var WHO = {
    utku:  { label: "Utku", emoji: "🧔", cls: "utku-bg" },
    gozde: { label: "Gözde", emoji: "👩", cls: "gozde-bg" },
    both:  { label: "Ortak", emoji: "👩‍❤️‍👨", cls: "both-bg" }
  };

  var DAY_NAMES = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];

  /** @type {{id:string, who:string, ts:number}[]} */
  var entries = [];
  /** @type {{type:string, row?:object, id?:string}[]} */
  var outbox = [];
  var lastUndo = null;
  var undoTimer = null;

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
    renderStatCards();
    renderChart();
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
      var li = document.createElement("li");
      li.className = "history-item";

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
      time.textContent = formatTime(e.ts) + " · " + ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + " · " + relativeTime(e.ts);
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

  // ---------- Status ----------
  function setStatus(text) {
    var node = el("cloudStatus");
    if (node) node.textContent = text;
  }
  function refreshStatus() {
    if (!sb) { setStatus("📴 Yerel mod · bulut kapalı"); return; }
    if (!navigator.onLine) { setStatus("📴 Çevrimdışı · internet gelince senkronlanır"); return; }
    if (lastCloudError) { setStatus("⚠️ Bulut hatası: " + lastCloudError + " (" + outbox.length + " bekliyor)"); return; }
    if (outbox.length) { setStatus("🔄 Senkronlanıyor… (" + outbox.length + " bekliyor)"); return; }
    setStatus(cloudReady ? "☁️ Bulutta senkron · Utku & Gözde ortak görür" : "☁️ Bağlanıyor…");
  }

  // ---------- Actions ----------
  function addEntry(who, x, y) {
    var entry = { id: uuid(), who: who, ts: Date.now() };
    entries.push(entry);
    sortEntries();
    saveCache();
    render();
    showUndo(who);
    floatEmoji(WHO[who].emoji, x, y);
    if (navigator.vibrate) navigator.vibrate(15);

    outbox.push({ type: "insert", row: entry });
    saveOutbox();
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

  function floatEmoji(emoji, x, y) {
    if (x == null) return;
    var node = document.createElement("span");
    node.className = "float-emoji";
    node.textContent = emoji;
    node.style.left = x + "px";
    node.style.top = y + "px";
    document.body.appendChild(node);
    setTimeout(function () { node.remove(); }, 900);
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

    function step(i) {
      if (i >= queue.length) return Promise.resolve();
      var op = queue[i];
      var p;
      if (op.type === "insert") {
        p = sb.from(TABLE).upsert(op.row, { onConflict: "id", ignoreDuplicates: true });
      } else {
        p = sb.from(TABLE).delete().eq("id", op.id);
      }
      return p.then(function (res) {
        if (res && res.error) throw res.error;
        // başarılı: gerçek kuyruktan bu işlemi çıkar
        var idx = outbox.indexOf(op);
        if (idx !== -1) outbox.splice(idx, 1);
        saveOutbox();
        lastCloudError = null;
        return step(i + 1);
      });
    }

    return step(0).then(function () { lastCloudError = null; refreshStatus(); }).catch(function (err) {
      // hata: kalanlar kuyrukta kalsın, sonra tekrar denenecek; sebebi göster
      cloudError(err);
    });
  }

  function syncFromRemote() {
    if (!sb || !navigator.onLine) return Promise.resolve();
    return sb.from(TABLE).select("id,who,ts").order("ts", { ascending: true }).then(function (res) {
      if (res.error) { cloudError(res.error); return; }
      if (!res.data) return;
      var map = {};
      res.data.forEach(function (r) { map[r.id] = { id: r.id, who: r.who, ts: Number(r.ts) }; });
      // Henüz gönderilmemiş yerel işlemleri uzaktaki veriye uygula
      outbox.forEach(function (op) {
        if (op.type === "insert" && op.row) map[op.row.id] = op.row;
        else if (op.type === "delete") delete map[op.id];
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
        entries.push({ id: r.id, who: r.who, ts: Number(r.ts) });
        sortEntries();
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
            if (!map[id]) { var row = { id: id, who: e.who, ts: Number(e.ts) }; map[id] = row; added.push(row); }
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
    if (!confirm("Tüm kayıtlar (bulut dahil) silinecek. Emin misin?")) return;
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

    setInterval(function () { renderToday(); }, 60000);
  }

  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
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
