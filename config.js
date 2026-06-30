/* Dumanaltı bulut yapılandırması.
   Bu anahtar herkese açık (publishable) anahtardır; tarayıcıda görünmesi normaldir.
   Erişim, Supabase'de tablo bazında RLS politikalarıyla sınırlanır. */
window.DUMANALTI_CONFIG = {
  supabaseUrl: "https://wzuztdnvotrpddxipihi.supabase.co",
  // Klasik anon (JWT) anahtarı — herkese açık, erişim RLS ile sınırlıdır.
  supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6dXp0ZG52b3RycGRkeGlwaWhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NTA4MzYsImV4cCI6MjA5NzUyNjgzNn0.I9OshQQzCwT6Mn76IodK0lqQzv6vDpS6rRUumvgTm3I",
  table: "dumanalti_entries"
};
