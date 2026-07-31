# 🚬 Dumanaltı

Utku ve Gözde için hazırlanmış, iki kişilik ortak sigo, sigara ve içki takip uygulaması.

## Özellikler

- **Üç kategori:** sigo/bong, sigara ve içki
- **Dört sigo kayıt tipi:** Utku, Gözde, Ortak ve Hep beraber
- **04:00 mantıksal gün:** gece 00:00–04:00 arasındaki kayıtlar önceki güne yazılır
- **Sade Bugün ekranı:** kategori seçimi, cihaz sahibine göre tek dokunuşla kayıt, günlük özet, süre ve limit takibi
- **Bölümlü Analiz:** özet, grafikler ve eğlence sekmelerinde düello, takvim, rekorlar, rozetler ve aylık özet
- **Kademeli Geçmiş:** arama, filtreleme, 30'ar kayıt yükleme, ayrıntı panelinden düzenleme/silme ve geri alma
- **Analiz içi harita:** konum izni verildiğinde yeni kayıtların yaklaşık konumu
- **Tam yedek:** tüm kategorileri içeren JSON/CSV dışa aktarma ve doğrulamalı içe aktarma
- **Bulut senkronu:** Supabase realtime + çevrimdışı outbox
- **Zıvana:** veriye dayalı yerel yardımcı ve proaktif bildirimler
- **Safari odaklı mobil arayüz:** iPhone 13 ve iPhone 11 düzenleri

## Teknoloji

Derleme adımı yoktur: saf HTML, CSS ve ES5 tarzı vanilla JavaScript. Supabase, D3 ve Leaflet tarayıcıdan kullanılır.

## Yerelde çalıştırma

```bash
npm ci
npm run serve
```

Ardından `http://localhost:8000` adresini açın.

## Supabase şeması

v7.1.0 ile `kind`, `tag`, `lat` ve `lng` alanları üç kategori tablosunda ortaklaştırıldı. Üretim veritabanına bir kez şu migrasyonu uygulayın:

```text
supabase/migrations/20260731114000_extend_entry_metadata.sql
```

İstemci, migrasyon uygulanana kadar eski şemaya geri düşerek temel kayıt eklemeyi sürdürür; tür, etiket ve konumun cihazlar arasında eksiksiz korunması için migrasyon gereklidir.

## Güvenlik ve gizlilik

Bu repo publictir ve yalnız iki kişinin kişisel kullanımı için geliştirilmiştir. `config.js` içindeki Supabase anon anahtarı gizli değildir; gerçek erişim kontrolü Supabase RLS politikalarıyla yapılmalıdır. `icons/avatar-*.png` dosyaları işlenmiş kişisel fotoğraflardır ve public repo içeriğinin parçasıdır.

## Doğrulama

```bash
node --check app.js
npm run typecheck
npm test
```
