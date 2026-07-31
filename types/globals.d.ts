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
  lat?: number;
  lng?: number;
  sessionId?: string;
  deletedAt?: string;
  updatedAt?: string;
}

/** Offline outbox işlemi: gönderilemeyen ekleme/güncelleme/silme. */
interface OutboxOp {
  type: "insert" | "update" | "delete";
  id?: string;
  row?: Entry;
  fields?: Record<string, any>;
  baseUpdatedAt?: string | null;
}

/** Kullanıcı ayarları (localStorage). */
interface Settings {
  dailyLimit: number;
  confetti: "full" | "lite" | "off";
  owner: "" | "utku" | "gozde";
  mascot: "on" | "off";
  sound: "on" | "off";
  customMascot: string;
  locationEnabled: boolean;
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
declare var L: any;
