const { test, expect } = require('@playwright/test');

// Bu dosya, çekirdek suite'ine (dumanalti.spec.js) ek olarak son eklenen
// özellikleri kapsar: Bilgiler mini-panosu, Rekorlar ızgarası, rozet dokunma
// detayı, ses ayarı, grafik erişilebilirliği ve birkaç saf-mantık fonksiyonu.

// Supabase istemcisini bellek-içi mock ile değiştir (gerçek ağa çıkma).
async function installSupabaseMock(page) {
  await page.addInitScript(() => {
    let mockDb = [];
    const table = {
      select: () => ({ order: () => Promise.resolve({ data: [...mockDb], error: null }) }),
      upsert: (row) => {
        const i = mockDb.findIndex(r => r.id === row.id);
        if (i !== -1) mockDb[i] = row; else mockDb.push(row);
        return Promise.resolve({ data: null, error: null });
      },
      update: (fields) => ({ eq: (_c, v) => {
        const i = mockDb.findIndex(r => r.id === v); if (i !== -1) Object.assign(mockDb[i], fields);
        return Promise.resolve({ data: null, error: null });
      } }),
      delete: () => ({
        eq: (_c, v) => { mockDb = mockDb.filter(r => r.id !== v); return Promise.resolve({ data: null, error: null }); },
        neq: () => { mockDb = []; return Promise.resolve({ data: null, error: null }); }
      })
    };
    const mock = {
      createClient: () => ({
        from: () => table,
        channel: () => ({ on() { return this; }, subscribe(cb) { if (cb) setTimeout(() => cb('SUBSCRIBED'), 10); return this; } })
      })
    };
    Object.defineProperty(window, 'supabase', { get: () => mock, set: () => {}, configurable: true });
  });
}

// Bugünü ve son günleri kapsayan deterministik veri üret + çiz.
async function seed(page) {
  await page.evaluate(() => {
    const ex = window.DUMANALTI_TEST_EXPORTS;
    const now = Date.now();
    const whos = ['utku', 'gozde', 'both', 'hepberaber'];
    const list = [];
    let id = 1;
    for (let d = 6; d >= 0; d--) {
      const n = d === 3 ? 0 : 2; // bir gün sigosuz (seri/rekor için)
      for (let i = 0; i < n; i++) {
        const day = new Date(now - d * 86400000);
        day.setHours(12 + i, 0, 0, 0);
        list.push({ id: 'x' + (id++), who: whos[(d + i) % 4], ts: day.getTime(), tag: '' });
      }
    }
    ex.setEntries(list);
    ex.render();
  });
}

test.describe('Dumanaltı — yeni özellikler', () => {
  test.beforeEach(async ({ page }) => {
    await installSupabaseMock(page);
    await page.goto('/404-clear-state');
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('dumanalti.onboarded.v1', '1'); });
    await page.goto('/');
    await page.click('.portal-card[data-cat="sigo"]');
  });

  test('Ana ekranda yalnızca Sigo kategorisi ve Sigo/Bong türleri bulunur', async ({ page }) => {
    await expect(page.locator('.portal-card')).toHaveCount(1);
    await expect(page.locator('.portal-card[data-cat="sigo"]')).toBeVisible();
    await expect(page.locator('.add-kind-btn')).toHaveCount(2);
    await expect(page.locator('#ickiKindSeg, #beerOptWrap, #glassOptWrap')).toHaveCount(0);
  });

  test('Maskot ve yardımcı paneli arayüzde bulunmaz', async ({ page }) => {
    await expect(page.locator('#assistant, .portal-zivana, #mascotSeg, #customMascotInput')).toHaveCount(0);
  });

  test('Bilgiler mini-panosu: düello barı, öne çıkan ve 6 kutucuk render eder', async ({ page }) => {
    await seed(page);
    // Anasayfa varsayılan açık; Bilgiler kartı açık olmalı
    await expect(page.locator('#insights')).not.toHaveClass(/collapsed/);
    await expect(page.locator('#insightBody .ins-duel')).toBeVisible();
    await expect(page.locator('#insightBody .ins-duel .ins-bar-fill')).toHaveCount(2);
    await expect(page.locator('#insightBody .ins-spot')).toBeVisible();
    await expect(page.locator('#insightBody .ins-grid .ins-tile')).toHaveCount(6);
  });

  test('Bilgiler kartı katlanıp açılır ve durum kalıcı', async ({ page }) => {
    await seed(page);
    await page.dispatchEvent('#insightsHead', 'pointerdown');
    await expect(page.locator('#insights')).toHaveClass(/collapsed/);
    await expect(page.locator('#insightBody')).not.toBeVisible();
    // localStorage'a yazıldı mı?
    const persisted = await page.evaluate(() => localStorage.getItem('dumanalti.insightsOpen'));
    expect(persisted).toBe('0');
    // Tekrar aç
    await page.dispatchEvent('#insightsHead', 'pointerdown');
    await expect(page.locator('#insights')).not.toHaveClass(/collapsed/);
  });

  test('Rekorlar 8 kutucuk render eder ve değerleri boş değil', async ({ page }) => {
    await seed(page);
    await page.click('nav.tabbar button[data-tab="stats"]');
    await page.dispatchEvent('.analysis-switch[data-analysis="fun"]', 'pointerdown');
    const tiles = page.locator('#recordList .record-tile');
    await expect(tiles).toHaveCount(8);
    // Her kutucuğun bir değeri olmalı
    const vals = await page.locator('#recordList .record-tile .rt-val').allTextContents();
    expect(vals.length).toBe(8);
    vals.forEach(v => expect(v.trim().length).toBeGreaterThan(0));
  });

  test('Rozete dokununca açıklama gösterilir ve sayaç dolar', async ({ page }) => {
    // 100 kayıt: en az birkaç rozet açılır
    await page.evaluate(() => {
      const ex = window.DUMANALTI_TEST_EXPORTS;
      const list = [];
      for (let i = 0; i < 100; i++) list.push({ id: 'b' + i, who: 'utku', ts: Date.now() - i * 3600000 });
      ex.setEntries(list); ex.render();
    });
    await page.click('nav.tabbar button[data-tab="stats"]');
    await page.dispatchEvent('.analysis-switch[data-analysis="fun"]', 'pointerdown');
    await expect(page.locator('#badgeCount')).toContainText('/');
    const first = page.locator('#badgeGrid .badge').first();
    await first.dispatchEvent('pointerdown');
    await expect(first).toHaveClass(/sel/);
    // Detay artık yer tutucu metin olmamalı
    await expect(page.locator('#badgeDetail')).not.toContainText('Bir rozete dokun');
    await expect(page.locator('#badgeDetail .bd-status')).toBeVisible();
  });

  test('Ses efekti ayarı seçilir ve kalıcı olur', async ({ page }) => {
    await page.click('nav.tabbar button[data-tab="settings"]');
    await page.dispatchEvent('#soundSeg button[data-sound="on"]', 'pointerdown');
    await expect(page.locator('#soundSeg button[data-sound="on"]')).toHaveClass(/active/);
    // Ayar bellekte ve localStorage'da güncellendi mi?
    const state = await page.evaluate(() => ({
      mem: window.DUMANALTI_TEST_EXPORTS.settings.sound,
      stored: JSON.parse(localStorage.getItem('dumanalti.settings.v1') || '{}').sound
    }));
    expect(state.mem).toBe('on');
    expect(state.stored).toBe('on');
  });

  test('Geçmiş kayıtları 30arlı yükler ve aramayı uygular', async ({ page }) => {
    await page.evaluate(() => {
      const ex = window.DUMANALTI_TEST_EXPORTS;
      const list = [];
      for (let i = 0; i < 65; i++) {
        list.push({ id: 'hist' + i, who: i % 2 ? 'utku' : 'gozde', kind: 'sigo', ts: Date.now() - i * 3600000 });
      }
      ex.setEntries(list); ex.render();
    });
    await page.click('nav.tabbar button[data-tab="history"]');
    await expect(page.locator('.history-item')).toHaveCount(30);
    await page.click('#historyMoreBtn');
    await expect(page.locator('.history-item')).toHaveCount(60);
    await page.fill('#historySearch', 'Utku');
    await expect(page.locator('.history-item')).toHaveCount(30);
    await expect(page.locator('#historyCount')).toContainText('32 kayıt');
  });

  test('İlk kurulum cihaz sahibi seçimini tamamlar', async ({ page }) => {
    await page.evaluate(() => localStorage.removeItem('dumanalti.onboarded.v1'));
    await page.reload();
    await expect(page.locator('#onboarding')).toBeVisible();
    await page.click('[data-onboard-owner="utku"]');
    await page.click('#onboardingFinish');
    await expect(page.locator('#onboarding')).not.toBeVisible();
    const state = await page.evaluate(() => ({ owner: JSON.parse(localStorage.getItem('dumanalti.settings.v1') || '{}').owner, done: localStorage.getItem('dumanalti.onboarded.v1') }));
    expect(state).toEqual({ owner: 'utku', done: '1' });
  });

  test('Ortak oturum yeni kaydı gruplar ve hızlı düzeltmeyi açar', async ({ page }) => {
    await page.click('nav.tabbar button[data-tab="settings"]');
    await page.dispatchEvent('#ownerSeg button[data-owner="utku"]', 'pointerdown');
    await page.click('nav.tabbar button[data-tab="home"]');
    await page.click('#sessionToggleBtn');
    await page.click('#quickMeBtn');
    await expect(page.locator('#sessionMeta')).toContainText('1 kayıt');
    await expect(page.locator('#quickEditBar')).toBeVisible();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('dumanalti.entries.v1') || '[]').slice(-1)[0]);
    expect(stored.sessionId).toBeTruthy();
  });

  test('Dönem karşılaştırması 30 gün ve özel aralık modlarını açar', async ({ page }) => {
    await seed(page);
    await page.click('nav.tabbar button[data-tab="stats"]');
    await page.click('#periodSwitcher [data-period="30"]');
    await expect(page.locator('#periodSwitcher [data-period="30"]')).toHaveClass(/active/);
    await expect(page.locator('#periodCompareCard')).toContainText('Seçili dönem');
    await page.click('#periodSwitcher [data-period="custom"]');
    await expect(page.locator('#periodCustom')).toBeVisible();
  });

  test('Silinen kayıt yedi günlük çöp kutusundan geri alınır', async ({ page }) => {
    await page.evaluate(() => { const ex = window.DUMANALTI_TEST_EXPORTS; ex.setEntries([{ id: 'trash-one', who: 'utku', kind: 'sigo', ts: Date.now() }]); ex.render(); });
    await page.click('nav.tabbar button[data-tab="history"]');
    await page.click('.history-item[aria-label="Utku kaydını düzenle"]');
    await page.click('.hist-edit-btns .danger');
    await expect(page.locator('#trashCount')).toHaveText('1');
    await page.click('#trashToggleBtn');
    await page.click('#trashList button');
    await expect(page.locator('#trashCount')).toHaveText('0');
    await expect(page.locator('.history-item')).toHaveCount(1);
  });

  test('Grafik sütunları ekran okuyucu için etiketli (a11y)', async ({ page }) => {
    await seed(page);
    await page.click('nav.tabbar button[data-tab="stats"]');
    await page.dispatchEvent('.analysis-switch[data-analysis="charts"]', 'pointerdown');
    await expect(page.locator('#chart')).toHaveAttribute('aria-label', 'Son 7 günün grafiği');
    await expect(page.locator('#dowChart .dow-col').first()).toHaveAttribute('aria-label', /sigo/);
    await expect(page.locator('#todChart')).toHaveAttribute('aria-label', 'Günlük zaman dilimleri');
  });

  test.describe('Saf mantık (DUMANALTI_TEST_EXPORTS)', () => {
    test('startOfWeek Pazartesi 04:00 döndürür', async ({ page }) => {
      const r = await page.evaluate(() => {
        // 2026-07-15 Çarşamba 10:00 → hafta başı Pzt 2026-07-13
        const d = window.DUMANALTI_TEST_EXPORTS.startOfWeek(new Date(2026, 6, 15, 10, 0, 0));
        return { date: d.getDate(), day: d.getDay(), hour: d.getHours() };
      });
      expect(r.date).toBe(13);
      expect(r.day).toBe(1);   // Pazartesi
      expect(r.hour).toBe(4);  // mantıksal gün 04:00'te başlar
    });

    test('entriesSince yalnızca eşik sonrası kayıtları döndürür', async ({ page }) => {
      const count = await page.evaluate(() => {
        const ex = window.DUMANALTI_TEST_EXPORTS;
        const now = Date.now();
        ex.setEntries([
          { id: 'a', who: 'utku', ts: now - 10 * 86400000 },
          { id: 'b', who: 'gozde', ts: now - 2 * 86400000 },
          { id: 'c', who: 'both', ts: now - 1 * 3600000 }
        ]);
        return ex.entriesSince(now - 3 * 86400000).length; // son 3 gün → 2 kayıt
      });
      expect(count).toBe(2);
    });

    test('relativeTime insan-okunur metin döndürür', async ({ page }) => {
      const r = await page.evaluate(() => {
        const ex = window.DUMANALTI_TEST_EXPORTS;
        const now = Date.now();
        return {
          justNow: ex.relativeTime(now - 30 * 1000),
          hours: ex.relativeTime(now - 90 * 60 * 1000),
          days: ex.relativeTime(now - 3 * 86400000)
        };
      });
      expect(r.justNow).toBe('az önce');
      expect(r.hours).toBe('1 sa önce');
      expect(r.days).toBe('3 gün önce');
    });
  });
});
