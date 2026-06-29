/* Dumanaltı — Utku & Gözde sigara takip PWA
   Veriler localStorage'da saklanır, hiçbir sunucuya gönderilmez. */

(function () {
  "use strict";

  var STORAGE_KEY = "dumanalti.entries.v1";
  var THEME_KEY = "dumanalti.theme";

  var WHO = {
    utku:  { label: "Utku", emoji: "🧔", cls: "utku-bg" },
    gozde: { label: "Gözde", emoji: "👩", cls: "gozde-bg" },
    both:  { label: "Ortak", emoji: "👩‍❤️‍👨", cls: "both-bg" }
  };

  var DAY_NAMES = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];

  /** @type {{id:string, who:string, ts:number}[]} */
  var entries = [];
  var lastUndo = null;
  var undoTimer = null;

  // ---------- Persistence ----------
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      entries = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(entries)) entries = [];
    } catch (e) {
      entries = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (e) {
      console.warn("Kayıt başarısız", e);
    }
  }

  // ---------- Date helpers ----------
  function startOfDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function dayKey(d) {
    var x = startOfDay(d);
    return x.getFullYear() + "-" + (x.getMonth() + 1) + "-" + x.getDate();
  }
  function isSameDay(a, b) { return dayKey(a) === dayKey(b); }

  function startOfWeek(d) {
    // Hafta Pazartesi başlar
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

  function entriesSince(ts) {
    return entries.filter(function (e) { return e.ts >= ts; });
  }

  function todayEntries() {
    return entries.filter(function (e) { return isSameDay(e.ts, Date.now()); });
  }

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

    // son 7 gün ortalaması
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
      // En çok içen
      var utkuTotal = all.utku + all.both;
      var gozdeTotal = all.gozde + all.both;
      if (utkuTotal > gozdeTotal) {
        items.push({ e: "🏆", t: "Utku toplamda " + (utkuTotal - gozdeTotal) + " sigara önde (" + utkuTotal + " - " + gozdeTotal + ")." });
      } else if (gozdeTotal > utkuTotal) {
        items.push({ e: "🏆", t: "Gözde toplamda " + (gozdeTotal - utkuTotal) + " sigara önde (" + gozdeTotal + " - " + utkuTotal + ")." });
      } else {
        items.push({ e: "🤝", t: "Tam berabere! İkiniz de " + utkuTotal + " sigara." });
      }

      // Ortak oranı
      if (all.total > 0) {
        var pct = Math.round(all.both / all.total * 100);
        items.push({ e: "👩‍❤️‍👨", t: "Sigaraların %" + pct + "'ini birlikte içtiniz." });
      }

      // En yoğun gün (son 30 gün)
      var byDay = {};
      entries.forEach(function (e) {
        var k = dayKey(e.ts);
        byDay[k] = (byDay[k] || 0) + 1;
      });
      var maxDay = null, maxCount = 0;
      Object.keys(byDay).forEach(function (k) {
        if (byDay[k] > maxCount) { maxCount = byDay[k]; maxDay = k; }
      });
      if (maxDay) {
        var parts = maxDay.split("-");
        var dd = ("0" + parts[2]).slice(-2) + "." + ("0" + parts[1]).slice(-2);
        items.push({ e: "📈", t: "En yoğun gün: " + dd + " (" + maxCount + " sigara)." });
      }

      // Bugün vs ortalama
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

      // Sigarasız süre
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

    // Son 30 kayıt, en yeni üstte
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

  // ---------- Actions ----------
  function addEntry(who, x, y) {
    var entry = { id: String(Date.now()) + Math.random().toString(36).slice(2, 6), who: who, ts: Date.now() };
    entries.push(entry);
    save();
    render();
    showUndo(who);
    floatEmoji(WHO[who].emoji, x, y);
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function deleteEntry(id) {
    var idx = entries.findIndex(function (e) { return e.id === id; });
    if (idx === -1) return;
    entries.splice(idx, 1);
    save();
    render();
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
        // birleştir, id'ye göre tekilleştir
        var map = {};
        entries.concat(incoming).forEach(function (e) {
          if (e && e.who && e.ts) {
            var id = e.id || (String(e.ts) + e.who);
            map[id] = { id: id, who: e.who, ts: e.ts };
          }
        });
        entries = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.ts - b.ts; });
        save();
        render();
        alert("İçe aktarıldı. Toplam " + entries.length + " kayıt.");
      } catch (e) {
        alert("Dosya okunamadı: " + e.message);
      }
    };
    reader.readAsText(file);
  }

  function resetData() {
    if (!confirm("Tüm kayıtlar silinecek. Emin misin?")) return;
    entries = [];
    save();
    render();
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

    // her dakika "x dk önce" güncellensin
    setInterval(function () { renderToday(); }, 60000);
  }

  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  load();
  bind();
  render();

  // Service worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("service-worker.js").catch(function (e) {
        console.warn("SW kaydı başarısız", e);
      });
    });
  }
})();
