const { test, expect } = require('@playwright/test');

test.describe('Dumanaltı App Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Inject mock supabase client and mock setTimeout before scripts load to isolate test execution
    await page.addInitScript(() => {
      // Mock setTimeout to freeze undo toast timer during testing
      const originalSetTimeout = window.setTimeout;
      window.setTimeout = function (callback, delay, ...args) {
        if (delay === 5000 || delay === 3000) {
          delay = 60000; // Increase undo toast timeouts to 60 seconds
        }
        return originalSetTimeout.call(window, callback, delay, ...args);
      };

      // Stateful in-memory mock database array to persist inserted records across async sync cycles
      let mockDb = [];
      window.__getMockDb = () => mockDb.map(row => ({ ...row }));

      const mockSupabase = {
        createClient: () => {
          const tableInstance = {
            select: () => {
              return {
                order: () => Promise.resolve({ data: [...mockDb], error: null })
              };
            },
            upsert: (row) => {
              const idx = mockDb.findIndex(r => r.id === row.id);
              if (idx !== -1) mockDb[idx] = row;
              else mockDb.push(row);
              return Promise.resolve({ data: null, error: null });
            },
            update: (fields) => {
              return {
                eq: (col, val) => {
                  const idx = mockDb.findIndex(r => r.id === val);
                  if (idx !== -1) {
                    Object.assign(mockDb[idx], fields);
                  }
                  return Promise.resolve({ data: null, error: null });
                }
              };
            },
            delete: () => {
              return {
                eq: (col, val) => {
                  if (col === 'id') {
                    mockDb = mockDb.filter(r => r.id !== val);
                  }
                  return Promise.resolve({ data: null, error: null });
                },
                neq: () => {
                  mockDb = []; // reset all except id 0000...
                  return Promise.resolve({ data: null, error: null });
                }
              };
            }
          };
          
          return {
            from: () => tableInstance,
            channel: () => {
              return {
                on: function() { return this; },
                subscribe: function(cb) {
                  if (cb) setTimeout(() => cb('SUBSCRIBED'), 10);
                  return this;
                }
              };
            }
          };
        }
      };

      // Define read-only window.supabase getter to block CDN script override
      Object.defineProperty(window, 'supabase', {
        get: () => mockSupabase,
        set: () => {}, // ignore overrides
        configurable: true
      });
    });

    // Go to a dummy 404 page first to clear localStorage cleanly on the same origin without running any app.js promises
    await page.goto('/404-clear-state');
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('dumanalti.onboarded.v1', '1'); });

    // Go to the app homepage
    await page.goto('/');
    // Portal artık varsayılan ekran; çekirdek akışlar için Sigo kartından Bugün'e gir.
    await page.click('.portal-card[data-cat="sigo"]');
  });

  test.describe('Unit & Logic Tests (via page.evaluate)', () => {
    test('logicalDate and startOfDay correctly handle 04:00 AM logical day boundary', async ({ page }) => {
      const results = await page.evaluate(() => {
        const exports = window.DUMANALTI_TEST_EXPORTS;
        
        // 2026-07-15 02:00:00 (Before 04:00 AM -> Should count as previous day, i.e., July 14)
        const dateBeforeBoundary = new Date(2026, 6, 15, 2, 0, 0);
        const lDateBefore = exports.logicalDate(dateBeforeBoundary);
        const keyBefore = exports.dayKey(dateBeforeBoundary);
        
        // 2026-07-15 05:00:00 (After 04:00 AM -> Should count as current day, i.e., July 15)
        const dateAfterBoundary = new Date(2026, 6, 15, 5, 0, 0);
        const lDateAfter = exports.logicalDate(dateAfterBoundary);
        const keyAfter = exports.dayKey(dateAfterBoundary);

        return {
          before: {
            logicalMonth: lDateBefore.getMonth(),
            logicalDate: lDateBefore.getDate(),
            key: keyBefore
          },
          after: {
            logicalMonth: lDateAfter.getMonth(),
            logicalDate: lDateAfter.getDate(),
            key: keyAfter
          }
        };
      });

      // Verification
      expect(results.before.logicalDate).toBe(14); // July 14
      expect(results.before.key).toBe('2026-7-14');
      
      expect(results.after.logicalDate).toBe(15); // July 15
      expect(results.after.key).toBe('2026-7-15');
    });

    test('isShared determines correct shared status', async ({ page }) => {
      const results = await page.evaluate(() => {
        const exports = window.DUMANALTI_TEST_EXPORTS;
        return {
          utku: exports.isShared('utku'),
          gozde: exports.isShared('gozde'),
          both: exports.isShared('both'),
          hepberaber: exports.isShared('hepberaber')
        };
      });

      expect(results.utku).toBe(false);
      expect(results.gozde).toBe(false);
      expect(results.both).toBe(true);
      expect(results.hepberaber).toBe(true);
    });

    test('countWho correctly counts total and individual sigos', async ({ page }) => {
      const counts = await page.evaluate(() => {
        const exports = window.DUMANALTI_TEST_EXPORTS;
        const mockEntries = [
          { id: '1', who: 'utku', ts: Date.now() },
          { id: '2', who: 'gozde', ts: Date.now() },
          { id: '3', who: 'both', ts: Date.now() },
          { id: '4', who: 'hepberaber', ts: Date.now() }
        ];
        return exports.countWho(mockEntries);
      });

      expect(counts.utku).toBe(1);
      expect(counts.gozde).toBe(1);
      expect(counts.both).toBe(1);
      expect(counts.hepberaber).toBe(1);
      expect(counts.total).toBe(4);
    });

    test('countKinds and entryKind correctly calculate sigo and bong breakdown', async ({ page }) => {
      const result = await page.evaluate(() => {
        const exports = window.DUMANALTI_TEST_EXPORTS;
        const mockEntries = [
          { id: '1', who: 'utku', kind: 'sigo', ts: Date.now() },
          { id: '2', who: 'gozde', kind: 'bong', ts: Date.now() },
          { id: '3', who: 'both', ts: Date.now() }, // legacy/implicit sigo
          { id: '4', who: 'utku', kind: 'bong', ts: Date.now() }
        ];
        return {
          counts: exports.countKinds(mockEntries),
          kinds: mockEntries.map(exports.entryKind)
        };
      });

      expect(result.counts.sigo).toBe(2);
      expect(result.counts.bong).toBe(2);
      expect(result.kinds).toEqual(['sigo', 'bong', 'sigo', 'bong']);
    });

    test('normalizeEntry validates imported and remote records', async ({ page }) => {
      const result = await page.evaluate(() => {
        const ex = window.DUMANALTI_TEST_EXPORTS;
        return {
          invalidWho: ex.normalizeEntry({ id: 'x', who: '<script>', ts: Date.now() }, 'sigo', false),
          invalidTime: ex.normalizeEntry({ id: 'x', who: 'utku', ts: 'bad' }, 'sigo', false),
          safe: ex.normalizeEntry({ id: 'ok-1', who: 'gozde', ts: Date.now(), kind: 'bong', lat: 41, lng: 29 }, 'sigo', false)
        };
      });
      expect(result.invalidWho).toBeNull();
      expect(result.invalidTime).toBeNull();
      expect(result.safe).toMatchObject({ id: 'ok-1', who: 'gozde', kind: 'bong', lat: 41, lng: 29 });
    });

    test('badge calculations are correct', async ({ page }) => {
      const badges = await page.evaluate(() => {
        const exports = window.DUMANALTI_TEST_EXPORTS;
        
        // Test 1: Empty entries -> no badges
        exports.setEntries([]);
        const noBadges = exports.computeBadges().map(b => ({ t: b.t, on: b.on }));
        
        // Test 2: Add 100 entries -> unlocks "İlk adım" and "Yüzler"
        const entries = [];
        for (let i = 0; i < 100; i++) {
          entries.push({ id: String(i), who: 'utku', ts: Date.now() });
        }
        exports.setEntries(entries);
        const earnedBadges = exports.computeBadges().map(b => ({ t: b.t, on: b.on }));

        return { noBadges, earnedBadges };
      });

      // No badges earned on empty entries
      expect(badges.noBadges.find(b => b.t === 'İlk adım').on).toBe(false);
      expect(badges.noBadges.find(b => b.t === 'Yüzler').on).toBe(false);

      // Earned badges on 100 entries
      expect(badges.earnedBadges.find(b => b.t === 'İlk adım').on).toBe(true);
      expect(badges.earnedBadges.find(b => b.t === 'Yüzler').on).toBe(true);
      expect(badges.earnedBadges.find(b => b.t === 'Beşyüz').on).toBe(false); // 500 required
    });

    test('assistant route correctly parses topics', async ({ page }) => {
      const routes = await page.evaluate(() => {
        const exports = window.DUMANALTI_TEST_EXPORTS;
        return {
          selam: exports.asstRoute('Merhaba Zıvana'),
          rekor: exports.asstRoute('en uzun sigo serisi ne?'),
          bugun: exports.asstRoute('Bugün nasılız?'),
          random: exports.asstRoute('ne haber nasılsın')
        };
      });

      expect(routes.selam).toBe('hi');
      expect(routes.rekor).toBe('records');
      expect(routes.bugun).toBe('today');
      expect(routes.random).toBe('hi');
    });
  });

  test.describe('UI Navigation & Core Flow Tests', () => {
    test('tab navigation works correctly', async ({ page }) => {
      await expect(page.locator('nav.tabbar .tab')).toHaveCount(4);
      // Check homepage active by default
      await expect(page.locator('#view-home')).not.toHaveClass(/hidden/);
      await expect(page.locator('#view-stats')).toHaveClass(/hidden/);

      // Go to Stats Tab
      await page.click('nav.tabbar button[data-tab="stats"]');
      await expect(page.locator('#view-home')).toHaveClass(/hidden/);
      await expect(page.locator('#view-stats')).not.toHaveClass(/hidden/);

      // Go to History Tab
      await page.click('nav.tabbar button[data-tab="history"]');
      await expect(page.locator('#view-stats')).toHaveClass(/hidden/);
      await expect(page.locator('#view-history')).not.toHaveClass(/hidden/);

      // Go to Settings Tab
      await page.click('nav.tabbar button[data-tab="settings"]');
      await expect(page.locator('#view-history')).toHaveClass(/hidden/);
      await expect(page.locator('#view-settings')).not.toHaveClass(/hidden/);
    });

    test('adding a sigo record updates dashboard counters and supports undo', async ({ page }) => {
      // Open add sigo overlay
      await page.click('#addFab');
      await expect(page.locator('#addDial')).toHaveClass(/open/);

      // Add "Utku" sigo
      await page.click('#addOptions button[data-who="utku"]');
      
      // Dial overlay should be closed
      await expect(page.locator('#addDial')).not.toHaveClass(/open/);

      // Dashboard stats verification
      await expect(page.locator('#todayTotal')).toHaveText('1');
      await expect(page.locator('#todayUtku')).toHaveText('1');
      await expect(page.locator('#todayGozde')).toHaveText('0');

      // Undo Toast verification
      await expect(page.locator('#undoBar')).not.toHaveClass(/hidden/);
      await expect(page.locator('#undoText')).toContainText('Utku (🚬 Sigo) eklendi');

      // Dispatch pointerdown directly to trigger undo event immediately and bypass click emulation overlays
      await page.dispatchEvent('#undoBtn', 'pointerdown');
      await expect(page.locator('#undoBar')).toHaveClass(/hidden/);

      // Verification after undo
      await expect(page.locator('#todayTotal')).toHaveText('0');
      await expect(page.locator('#todayUtku')).toHaveText('0');
    });

    test('adding a bong record updates counters and allows filtering by kind in stats view', async ({ page }) => {
      // Open speed dial overlay
      await page.click('#addFab');
      await expect(page.locator('#addDial')).toHaveClass(/open/);

      // Select Bong option
      await page.click('#sigoKindSeg button[data-kind="bong"]');
      await expect(page.locator('#sigoKindSeg button[data-kind="bong"]')).toHaveClass(/active/);

      // Add "Gözde" Bong
      await page.click('#addOptions button[data-who="gozde"]');
      await expect(page.locator('#addDial')).not.toHaveClass(/open/);

      // Check undo toast indicates Bong
      await expect(page.locator('#undoBar')).not.toHaveClass(/hidden/);
      await expect(page.locator('#undoText')).toContainText('Gözde (🫧 Bong) eklendi');
      await expect.poll(() => page.evaluate(() => {
        const row = window.__getMockDb().find(item => item.who === 'gozde');
        return row && row.kind;
      })).toBe('bong');

      // Now add a Sigo record for Utku
      await page.click('#addFab');
      await page.click('#sigoKindSeg button[data-kind="sigo"]');
      await page.click('#addOptions button[data-who="utku"]');

      // Total today should be 2
      await expect(page.locator('#todayTotal')).toHaveText('2');
      await expect(page.locator('#todayHeroSub')).toContainText('1 sigo · 1 bong');

      // Go to Stats view
      await page.click('nav.tabbar button[data-tab="stats"]');

      // Default kind filter is "all" -> total allTime should be 2
      await expect(page.locator('#allTotal')).toHaveText('2');

      // Filter stats by Sigo -> total should be 1
      await page.click('#kindScopeBar button[data-kind-scope="sigo"]');
      await expect(page.locator('#allTotal')).toHaveText('1');

      // Filter stats by Bong -> total should be 1
      await page.click('#kindScopeBar button[data-kind-scope="bong"]');
      await expect(page.locator('#allTotal')).toHaveText('1');
    });

    test('theme switcher changes themes correctly', async ({ page }) => {
      // Go to Settings
      await page.click('nav.tabbar button[data-tab="settings"]');

      // Default should be dark (no light theme attribute)
      await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light');

      // Select light theme
      await page.click('#themeSeg button[data-theme="light"]');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

      // Select dark theme
      await page.click('#themeSeg button[data-theme="dark"]');
      await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light');
    });

    test('assistant chat panel opens and answers questions', async ({ page }) => {
      // Open assistant panel with force:true to bypass stability checks due to potential floating animations
      await page.click('#asstFab', { force: true });
      await expect(page.locator('#asstPanel')).not.toHaveClass(/hidden/);

      // Submit message
      await page.fill('#asstInput', 'selam');
      await page.press('#asstInput', 'Enter');

      // Check user message is displayed in chat
      await expect(page.locator('.asst-msg.me')).toHaveText('selam');

      // Check Zıvana replies
      await expect(page.locator('.asst-msg').nth(1)).toBeVisible();
    });

    test('settings owner updates assistant greeting', async ({ page }) => {
      // Go to Settings
      await page.click('nav.tabbar button[data-tab="settings"]');

      // Choose "Utku" as device owner
      await page.click('#ownerSeg button[data-owner="utku"]');

      // Yardımcı yalnız içerik ekranlarında görünür.
      await page.click('nav.tabbar button[data-tab="home"]');

      // Open assistant panel
      await page.click('#asstFab', { force: true });
      await expect(page.locator('#asstPanel')).not.toHaveClass(/hidden/);

      // Check Zıvana greeting has "Utku" name in the first message
      await expect(page.locator('.asst-msg').first()).toContainText('Utku');
    });

    test('device owner enables one-tap quick logging', async ({ page }) => {
      await page.click('nav.tabbar button[data-tab="settings"]');
      await page.dispatchEvent('#ownerSeg button[data-owner="utku"]', 'pointerdown');
      await page.click('nav.tabbar button[data-tab="home"]');
      await expect(page.locator('#quickOwnerHint')).toContainText('Utku');
      await page.dispatchEvent('#quickMeBtn', 'pointerdown');
      await expect(page.locator('#todayUtku')).toHaveText('1');
      await expect(page.locator('#todayTotal')).toHaveText('1');
    });
  });

  test.describe('Offline Outbox & Syncing Tests', () => {
    test('offline mode logs entries to outbox and syncs when back online', async ({ page, context }) => {
      // Verify initial state is online/synced
      await expect(page.locator('#syncInfo')).toContainText('Durum:');

      // Put the page context in offline mode
      await context.setOffline(true);
      
      // Wait for app status refresh (offline status)
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      
      // Go to Settings tab to verify the state shows offline
      await page.click('nav.tabbar button[data-tab="settings"]');
      await expect(page.locator('#syncInfo')).toContainText('Çevrimdışı');

      // Return to home to add a record
      await page.click('nav.tabbar button[data-tab="home"]');

      // Add a sigo record for "Gözde"
      await page.click('#addFab');
      await page.click('#addOptions button[data-who="gozde"]');

      // Dashboard updates optimistic UI
      await expect(page.locator('#todayTotal')).toHaveText('1');
      await expect(page.locator('#todayGozde')).toHaveText('1');

      // Check that syncInfo in Settings now shows pending items
      await page.click('nav.tabbar button[data-tab="settings"]');
      await expect(page.locator('#syncInfo')).toContainText('bekliyor');

      // Check that the entry is marked pending in History tab
      await page.click('nav.tabbar button[data-tab="history"]');
      await expect(page.locator('.history-item.who-gozde')).toHaveClass(/is-pending/);
      await expect(page.locator('.history-item.who-gozde')).toContainText('bekliyor');

      // Put context back online
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));

      // Click "Şimdi senkronla" button in settings or wait for sync trigger
      await page.click('nav.tabbar button[data-tab="settings"]');
      await page.click('#syncNowBtn');

      // Verification: Check status goes back to online / synced, and "bekliyor" drops to 0
      await expect(page.locator('#syncInfo')).toContainText('Bulut senkronize');

      // Check history again; pending status should be gone
      await page.click('nav.tabbar button[data-tab="history"]');
      await expect(page.locator('.history-item.who-gozde')).not.toHaveClass(/is-pending/);
      await expect(page.locator('.history-item.who-gozde')).not.toContainText('bekliyor');
    });

    test('offline reset keeps cloud deletes in the outbox', async ({ page, context }) => {
      await page.click('#addFab');
      await page.click('#addOptions button[data-who="utku"]');
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('dumanalti.outbox.v1') || '[]').length)).toBe(0);

      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.click('nav.tabbar button[data-tab="settings"]');
      page.on('dialog', dialog => dialog.type() === 'prompt' ? dialog.accept('SIFIRLA') : dialog.accept());
      await page.click('#resetBtn');

      const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('dumanalti.outbox.v1') || '[]'));
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ type: 'delete' });
    });
  });
});
