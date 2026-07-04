# Dumanaltı

Utku & Gözde'nin iki kişilik sigo takip web uygulaması, Safari'de kullanılıyor (yeşil liquid glass tema). Vanilla JS/HTML/CSS, build adımı yok. Vercel `main` dalını otomatik olarak dumanalti.vercel.app'e dağıtır; veriler Supabase'de (realtime + offline outbox).

## Her değişiklikte sürüm güncelle (ZORUNLU)

Kullanıcıya görünen her değişiklikte, commit'ten önce ÜÇ yeri birden güncelle:

1. `service-worker.js` → `CACHE = "dumanalti-vNN"` (bir artır; her dağıtımda zorunlu, yoksa kullanıcılar eski önbelleği görür)
2. `app.js` → `APP_BUILD` (SW numarasıyla AYNI sayı olacak)
3. `app.js` → `APP_VERSION` semver'e göre:
   - **patch** (2.9.0 → 2.9.1): ince ayar, bug fix, görsel düzeltme
   - **minor** (2.9.x → 2.10.0): yeni özellik
   - **major** (2.x → 3.0.0): büyük yeniden tasarım

Sürüm Ayarlar > Hakkında kartında "vX.Y.Z · derleme NN" olarak görünür.

Güncel sürüm sayacı: **v4.4.0 · derleme 64 · SW cache `dumanalti-v64`** — buradan devam et.

## Düzen ve platform

- Uygulama artık PWA olarak değil **Safari'de** kullanılıyor; `100dvh` önemli.
- Düzen ayarları her zaman **iPhone 13 (390×844)** ve **iPhone 11 (414×896)** için test edilir, Safari-efektif yükseklikler dahil.
- Anasayfa **tek tam ekran** olmalı; uzun ekranda kartlar flex ile boşluğu doldurur.
- Terminoloji: **"sigo"** (sigara/joint değil).
- Kayıt türleri (sıra sabit): 1. Utku, 2. Gözde, 3. Ortak (`both`), 4. **Hep beraber** (`hepberaber`, misafirlerle içilen; amber renk, ikisinin de kişisel sayacına işlenir). Hep beraber her zaman DÖRDÜNCÜ seçenektir.
- Maskot: **Zıvana** (kawaii dişli yaprak, `icons/mascot.svg`, SVG parametrik üretim), asistan paneliyle birlikte.

## Çalışma düzeni

- Değişiklik sonrası `node --check app.js`, sonra Playwright ile görsel doğrulama (chromium: `/opt/pw-browsers/chromium`, app'i `npx serve` ile sun — `file://` çalışmaz).
- Commit + push `main`'e; Vercel MCP `get_deployment` ile `target: production`, `state: READY` doğrula.
- Oturum ayrı bir çalışma dalına bağlıysa: kullanıcıdan merge İSTEME — işi bitirince main'e taşımayı kendin yap (doğrudan push veya PR aç + kendin merge et), sonra dağıtımı doğrula.
- Kullanıcıya Türkçe raporla; network-first SW olduğundan "bir kez yenileyin" hatırlat.
- Repo private ve öyle kalmalı: `icons/avatar-*.png` gerçek kişi fotoğrafları içeriyor. Ham/orijinal fotoğrafları ASLA commit'leme (sadece işlenmiş dairesel kırpımlar).
- Kod stili: ES5 (`var`, function ifadeleri), Türkçe yorumlar/UI metinleri.
