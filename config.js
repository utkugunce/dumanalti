/* Dumanaltı bulut yapılandırması.
   Bu anahtar herkese açık (publishable) anahtardır; tarayıcıda görünmesi normaldir.
   Erişim, Supabase'de tablo bazında RLS politikalarıyla sınırlanır. */
window.DUMANALTI_CONFIG = {
  supabaseUrl: "https://echhbmncwxrzgakufvyt.supabase.co",
  // Klasik anon (JWT) anahtarı — herkese açık, erişim RLS ile sınırlıdır.
  supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjaGhibW5jd3hyemdha3Vmdnl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMTc5NDAsImV4cCI6MjEwNjY5Mzk0MH0.ha4u2LwTKxBW1Tc242Mlj364UerX7erCC1Fvm5sUlyA",
  table: "dumanalti_entries"
};
