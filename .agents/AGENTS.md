# Workspace Guidelines

- **CLAUDE.md Zorunluluğu**: Her görev ve değişiklik öncesinde `CLAUDE.md` dosyası mutlaka okunup yönergelerine eksiksiz uyulacaktır.
- **Sürüm Güncelleme**: Her kullanıcıya yansıyan değişiklikte `service-worker.js` (CACHE), `app.js` (APP_BUILD ve APP_VERSION) ve `CLAUDE.md` içerisindeki sürüm sayacı ÜÇ yerde birden güncellenecektir.
- **Git Push**: Yapılan her değişiklik sonrasında `node --check app.js` ile doğrulama yapılıp değişiklikler `git add`, `git commit` ve `git push origin main` ile otomatik olarak gönderilecektir.
- **Kod ve Tasarım**: Vanilla JS (ES5 stili, build adımı yok), Safari 100dvh ve iPhone 13/11 uyumluluğu, SF Pro Rounded tipografisi korunacaktır.
- **UI/UX Sadeleştirme**: Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout.
- **Denge ve Karar İlkesi (UX/DX/AX)**: Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent experience (AX) always, without breaking anything.
