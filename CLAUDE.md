# Dumanaltı

Utku & Gözde'nin iki kişilik sigara takip PWA'sı. Vanilla JS/HTML/CSS, build adımı yok. Vercel `main` dalını otomatik olarak dumanalti.vercel.app'e dağıtır; veriler Supabase'de (realtime + offline outbox).

## Her değişiklikte sürüm güncelle (ZORUNLU)

Kullanıcıya görünen her değişiklikte, commit'ten önce ÜÇ yeri birden güncelle:

1. `service-worker.js` → `CACHE = "dumanalti-vNN"` (bir artır; her dağıtımda zorunlu, yoksa kullanıcılar eski önbelleği görür)
2. `app.js` → `APP_BUILD` (SW numarasıyla AYNI sayı olacak)
3. `app.js` → `APP_VERSION` semver'e göre:
   - **patch** (2.9.0 → 2.9.1): ince ayar, bug fix, görsel düzeltme
   - **minor** (2.9.x → 2.10.0): yeni özellik
   - **major** (2.x → 3.0.0): büyük yeniden tasarım

Sürüm Ayarlar > Hakkında kartında "vX.Y.Z · derleme NN" olarak görünür.

## Çalışma düzeni

- Değişiklik sonrası `node --check app.js`, sonra Playwright ile görsel doğrulama (chromium: `/opt/pw-browsers/chromium`, app'i `npx serve` ile sun — `file://` çalışmaz).
- Commit + push `main`'e; Vercel MCP `get_deployment` ile `target: production`, `state: READY` doğrula.
- Kullanıcıya Türkçe raporla; network-first SW olduğundan "bir kez yenileyin" hatırlat.
- Repo private ve öyle kalmalı: `icons/avatar-*.png` gerçek kişi fotoğrafları içeriyor. Ham/orijinal fotoğrafları ASLA commit'leme (sadece işlenmiş dairesel kırpımlar).
- Kod stili: ES5 (`var`, function ifadeleri), Türkçe yorumlar/UI metinleri.
