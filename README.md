# 🚬 Dumanaltı

Utku & Gözde için basit bir sigara takip uygulaması (PWA).

## Özellikler

- **Üç hızlı buton:** _Utku içti_, _Gözde içti_, _Ortak içtik_
- **Bugün kartı:** kişi başı ve toplam sayım, son sigara zamanı
- **İstatistik kartları:** bu hafta, bu ay, son 7 günün günlük ortalaması, tüm zamanlar
- **Son 7 gün grafiği:** kişiye göre renkli yığın grafik
- **Bilgiler:** kim önde, ortak içme oranı, en yoğun gün, günlük durum
- **Geçmiş:** son kayıtlar, tek tek silme ve "geri al"
- **Veri:** JSON olarak dışa/içe aktarma ve sıfırlama
- **Açık/koyu tema**
- **PWA:** telefona kurulabilir, çevrimdışı çalışır
- **Bulut senkron:** veriler Supabase'de tutulur; Utku ve Gözde aynı URL'de **ortak** veriyi görür, eklemeler **gerçek zamanlı** yansır
- **Çevrimdışı dayanıklılık:** internet yokken kayıtlar yerel kuyruğa alınır, bağlantı gelince otomatik gönderilir

## Teknoloji

Derleme adımı yok — saf HTML, CSS ve vanilla JavaScript. Manifest + service worker ile PWA.

## Yerelde çalıştırma

```bash
npx serve .
# veya
python3 -m http.server 8000
```

Ardından tarayıcıda `http://localhost:8000` adresini aç.

## Dağıtım

Statik bir site olduğu için Vercel, Netlify veya GitHub Pages üzerinde olduğu gibi yayınlanabilir.
