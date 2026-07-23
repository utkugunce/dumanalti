// Dumanaltı — build'siz tip denetimi için ortak tipler ve global bildirimler.
// Bu dosya yalnızca `tsc --noEmit` (npm run typecheck) tarafından kullanılır;
// tarayıcıya hiçbir şey gönderilmez.

declare var d3: any;

/** Kayıt türü: kişiler + ortak/hep beraber. */
type Who = "utku" | "gozde" | "both" | "hepberaber";

/** Bir sigo kaydı (Supabase `dumanalti_entries` satırı). */
interface Entry {
  id: string;
  who: Who;
  ts: number;
  kind?: string;
  tag?: string;
}

/** Offline outbox işlemi: gönderilemeyen ekleme/güncelleme/silme. */
interface OutboxOp {
  type: "insert" | "update" | "delete";
  id?: string;
  row?: Entry;
  fields?: Record<string, any>;
}

/** Kullanıcı ayarları (localStorage). */
interface Settings {
  dailyLimit: number;
  confetti: "full" | "lite" | "off";
  owner: "" | "utku" | "gozde";
  mascot: "on" | "off";
  sound: "on" | "off";
  waPhone?: string;
  callApp?: "whatsapp" | "telegram";
  tgUser?: string;
  tgBotToken?: string;
  tgChatId?: string;
  ntfyTopic?: string;
}

/** Bulut yapılandırması (config.js). */
interface DumanaltiConfig {
  supabaseUrl?: string;
  supabaseKey?: string;
  table?: string;
}

interface Window {
  DUMANALTI_CONFIG?: DumanaltiConfig;
  /** Supabase UMD istemcisi (CDN'den yüklenir). */
  supabase?: any;
  /** Safari için Web Audio ön eki. */
  webkitAudioContext?: typeof AudioContext;
  /** Testler için içe aktarılan fonksiyonlar (tests/ tarafından okunur). */
  DUMANALTI_TEST_EXPORTS?: Record<string, any>;
}
