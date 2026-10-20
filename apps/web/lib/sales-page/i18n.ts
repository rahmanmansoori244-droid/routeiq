/**
 * The salesman page's words in English, Arabic and Urdu (owner feedback of 20 Oct 2026: "add Arabic, English and
 * Urdu, so they can choose whatever language they want", like the driver page: lib/driver-page/i18n.ts is the
 * pattern). Pure and browser-safe. Every text of the page is here: the statuses, the times ("in about 1 h 20 min"),
 * the errors, the link states and the WhatsApp text for the customer. The API sends codes, numbers and "HH:MM"
 * times only (lib/sales-link/view-types.ts).
 *
 * Rules: the same keys and {placeholders} in every language (tests/lib/sales-page-i18n.spec.ts); no plural built
 * from parts - "label: value" or short units ("20 د", "1 س") where Arabic would need a plural form; Western digits
 * in every language; times 24 h "HH:MM". Customer names and codes are data: shown as stored. In Arabic and Urdu
 * every filled-in value is isolated (U+2068 ... U+2069) so a time, a code or an English name keeps its order inside
 * right-to-left text.
 *
 * The Arabic and the Urdu must be checked by native speakers at NMWC before the salesmen rely on them (handbook
 * 3.23, open question).
 */
export type SalesLang = 'en' | 'ar' | 'ur';

export const SALES_LANGS: readonly SalesLang[] = ['en', 'ar', 'ur'];

const EN = {
  appTitle: 'Deliveries',
  language: 'Language',
  routeLabel: 'Your route code',
  routeHelp: 'As on your Salesman ETA page, for example R1. Two routes: R1, R2X. A truck code works too.',
  show: 'Show',
  changeRoute: 'Change route',
  refresh: 'Refresh',
  updated: 'Updated {time}',
  routeTitle: 'Route {code}',
  truckTitle: 'Truck {code}',
  all: 'All',
  loading: 'Loading…',
  offline: 'No connection. Check your signal and try again.',
  serverError: 'The server could not answer just now. Trying again shortly.',
  serverErrorForm: 'The server could not answer just now. Try again in a minute.',
  tryAgain: 'Try again',
  stale: 'Could not refresh - showing the data of {time}. Trying again every minute.',
  busy: 'Too many requests. Trying again in {n} s.',
  busySoon: 'Too many requests. Trying again in a minute.',
  codeMissing: 'Type your route code.',
  codeTooLong: 'That code is too long.',
  tooManyCodes: 'At most 5 codes at once.',
  notFound: 'No deliveries for {codes} on {day}. Check the code on your Salesman ETA page.',
  ambiguous: '{codes}: more than one route or truck has this code - each is shown.',
  severalTrucks: '{code}: more than one truck has this code. Pick one:',
  alsoTruck: '{code} is also a truck code. Show the truck instead:',
  nothingYet: 'Nothing for this route yet.',
  notPlannedYetAll: 'Not planned yet - the plan is usually made the evening before. Check again later.',
  noneHere: 'None.',
  footerTimes: 'Times are approximate, company time. The page refreshes every minute.',
  footerUntil: 'Works until {day} {time}. For the sales team only - please do not forward.',
  'st.DELIVERED': 'Delivered',
  'st.PARTLY_DELIVERED': 'Partly delivered',
  'st.NOT_DELIVERED': 'Not delivered',
  'st.NOT_CONFIRMED': 'Not confirmed yet',
  'st.ON_THE_WAY': 'On the way',
  'st.DELAYED': 'Delayed',
  'st.CANCELLED': 'Cancelled',
  'st.NOT_IN_PLAN': 'Not in the plan',
  'st.PLANNED': 'Planned',
  deliveredAt: 'at {time}',
  expectedAbout: 'about {time}',
  plannedAt: '{day}, about {time}',
  plannedOn: 'On {day}',
  anyMinute: 'any minute',
  inAbout: 'in about {t}',
  mins: '{m} min',
  hour1: '1 h',
  hours: '{h} h',
  beingDelivered: 'Being delivered now',
  casesOf: '{n} of {m} cases',
  movedTo: 'Moved to {day}',
  notPlannedYet: 'Not planned yet',
  share: 'Send to customer',
  shareTitle: 'Send this to the customer on WhatsApp (no link is sent)',
  'msg.DELIVERED': '{customer}: your order was delivered at {time}.',
  'msg.DELIVERED_NO_TIME': '{customer}: your order was delivered.',
  'msg.PARTLY': '{customer}: part of your order was delivered ({n} of {m} cases). We will contact you about the rest.',
  'msg.PARTLY_NO_CASES': '{customer}: part of your order was delivered. We will contact you about the rest.',
  'msg.NOT_DELIVERED': '{customer}: your order could not be delivered. We will contact you.',
  'msg.NOT_CONFIRMED': '{customer}: we are checking your delivery and will contact you.',
  'msg.AT_CUSTOMER': '{customer}: your order is being delivered now.',
  'msg.COMING': '{customer}: your order is on the way, expected at about {time}.',
  'msg.COMING_NO_TIME': '{customer}: your order is on the way.',
  'msg.PLANNED': '{customer}: your order is planned for {day}, at about {time}.',
  'msg.PLANNED_NO_TIME': '{customer}: your order is planned for {day}.',
  'link.LINK_NOT_FOUND': 'This link does not work. Ask the office for the link of the day.',
  'link.LINK_REPLACED': 'This link was replaced by a newer one. Use the newest link in your group, or ask the office.',
  'link.LINK_REVOKED': 'This link was turned off by the office. Ask the office for a new one.',
  'link.LINK_EXPIRED': "This link has expired. Ask the office for today's link.",
  'link.SALES_LINKS_OFF': 'Salesman links are not available on this server. Ask the office.',
  'link.SIGNED_IN_OTHER_TENANT': 'You are signed in to RouteIQ for another company. Sign out to use this link.',
  linkDay: 'Link of {day}',
} as const;

export type SalesKey = keyof typeof EN;

const AR: Record<SalesKey, string> = {
  appTitle: 'التوصيلات',
  language: 'اللغة',
  routeLabel: 'رمز المسار',
  routeHelp: 'كما في ورقة Salesman ETA، مثل R1. لمسارين اكتب: R1, R2X. ويمكن أيضًا كتابة رمز الشاحنة.',
  show: 'عرض',
  changeRoute: 'تغيير المسار',
  refresh: 'تحديث',
  updated: 'آخر تحديث {time}',
  routeTitle: 'المسار {code}',
  truckTitle: 'الشاحنة {code}',
  all: 'الكل',
  loading: 'جارٍ التحميل…',
  offline: 'لا يوجد اتصال. تحقق من الإشارة وحاول مرة أخرى.',
  serverError: 'تعذّر على الخادم الرد الآن. ستتم إعادة المحاولة قريبًا.',
  serverErrorForm: 'تعذّر على الخادم الرد الآن. حاول مرة أخرى بعد دقيقة.',
  tryAgain: 'حاول مرة أخرى',
  stale: 'تعذّر التحديث - البيانات المعروضة من الساعة {time}. ستتم إعادة المحاولة كل دقيقة.',
  busy: 'طلبات كثيرة. إعادة المحاولة بعد {n} ث.',
  busySoon: 'طلبات كثيرة. إعادة المحاولة بعد دقيقة.',
  codeMissing: 'اكتب رمز المسار.',
  codeTooLong: 'هذا الرمز طويل جدًا.',
  tooManyCodes: 'خمسة رموز كحد أقصى في المرة الواحدة.',
  notFound: 'لا توجد توصيلات لـ {codes} يوم {day}. تحقق من الرمز في ورقة Salesman ETA.',
  ambiguous: '{codes}: هذا الرمز لأكثر من مسار أو شاحنة - تم عرض الكل.',
  severalTrucks: '{code}: هذا الرمز لأكثر من شاحنة. اختر واحدة:',
  alsoTruck: '{code} هو أيضًا رمز شاحنة. اعرض الشاحنة بدلًا منه:',
  nothingYet: 'لا شيء لهذا المسار حتى الآن.',
  notPlannedYetAll: 'لم يتم التخطيط بعد - تُعدّ الخطة عادةً مساء اليوم السابق. تحقق لاحقًا.',
  noneHere: 'لا يوجد.',
  footerTimes: 'الأوقات تقريبية وبتوقيت الشركة. يتم تحديث الصفحة كل دقيقة.',
  footerUntil: 'يعمل حتى {day} {time}. لفريق المبيعات فقط - يرجى عدم إعادة إرساله.',
  'st.DELIVERED': 'تم التسليم',
  'st.PARTLY_DELIVERED': 'تسليم جزئي',
  'st.NOT_DELIVERED': 'لم يتم التسليم',
  'st.NOT_CONFIRMED': 'لم يُؤكَّد بعد',
  'st.ON_THE_WAY': 'في الطريق',
  'st.DELAYED': 'متأخر',
  'st.CANCELLED': 'ملغى',
  'st.NOT_IN_PLAN': 'خارج الخطة',
  'st.PLANNED': 'مجدول',
  deliveredAt: 'الساعة {time}',
  expectedAbout: 'حوالي الساعة {time}',
  plannedAt: 'يوم {day} حوالي الساعة {time}',
  plannedOn: 'يوم {day}',
  anyMinute: 'خلال دقائق',
  inAbout: 'بعد حوالي {t}',
  mins: '{m} د',
  hour1: '1 س',
  hours: '{h} س',
  beingDelivered: 'جارٍ التسليم الآن',
  casesOf: 'الكراتين: {n} من {m}',
  movedTo: 'نُقل إلى {day}',
  notPlannedYet: 'لم يُخطط بعد',
  share: 'أرسل للعميل',
  shareTitle: 'أرسل هذا إلى العميل عبر واتساب (بدون رابط)',
  'msg.DELIVERED': '{customer}: تم تسليم طلبك الساعة {time}.',
  'msg.DELIVERED_NO_TIME': '{customer}: تم تسليم طلبك.',
  'msg.PARTLY': '{customer}: تم تسليم جزء من طلبك (الكراتين: {n} من {m}). سنتواصل معك بخصوص الباقي.',
  'msg.PARTLY_NO_CASES': '{customer}: تم تسليم جزء من طلبك. سنتواصل معك بخصوص الباقي.',
  'msg.NOT_DELIVERED': '{customer}: لم نتمكن من تسليم طلبك. سنتواصل معك.',
  'msg.NOT_CONFIRMED': '{customer}: نتحقق من حالة طلبك وسنتواصل معك.',
  'msg.AT_CUSTOMER': '{customer}: يتم تسليم طلبك الآن.',
  'msg.COMING': '{customer}: طلبك في الطريق، ومن المتوقع وصوله حوالي الساعة {time}.',
  'msg.COMING_NO_TIME': '{customer}: طلبك في الطريق.',
  'msg.PLANNED': '{customer}: تسليم طلبك مخطط يوم {day} حوالي الساعة {time}.',
  'msg.PLANNED_NO_TIME': '{customer}: تسليم طلبك مخطط يوم {day}.',
  'link.LINK_NOT_FOUND': 'هذا الرابط لا يعمل. اطلب رابط اليوم من المكتب.',
  'link.LINK_REPLACED': 'تم استبدال هذا الرابط برابط أحدث. استخدم أحدث رابط في مجموعتك أو اسأل المكتب.',
  'link.LINK_REVOKED': 'أوقف المكتب هذا الرابط. اطلب رابطًا جديدًا من المكتب.',
  'link.LINK_EXPIRED': 'انتهت صلاحية هذا الرابط. اطلب رابط اليوم من المكتب.',
  'link.SALES_LINKS_OFF': 'روابط المندوبين غير متاحة على هذا الخادم. اسأل المكتب.',
  'link.SIGNED_IN_OTHER_TENANT': 'أنت مسجّل الدخول في RouteIQ لشركة أخرى. سجّل الخروج لاستخدام هذا الرابط.',
  linkDay: 'رابط يوم {day}',
};

const UR: Record<SalesKey, string> = {
  appTitle: 'ڈیلیوریاں',
  language: 'زبان',
  routeLabel: 'آپ کا روٹ کوڈ',
  routeHelp: 'جیسا کہ Salesman ETA صفحے پر ہے، مثلاً R1۔ دو روٹ: R1, R2X۔ ٹرک کوڈ بھی لکھ سکتے ہیں۔',
  show: 'دکھائیں',
  changeRoute: 'روٹ تبدیل کریں',
  refresh: 'ریفریش',
  updated: 'اپ ڈیٹ {time}',
  routeTitle: 'روٹ {code}',
  truckTitle: 'ٹرک {code}',
  all: 'سب',
  loading: 'لوڈ ہو رہا ہے…',
  offline: 'کنکشن نہیں ہے۔ سگنل چیک کریں اور دوبارہ کوشش کریں۔',
  serverError: 'سرور ابھی جواب نہیں دے سکا۔ تھوڑی دیر میں دوبارہ کوشش ہو گی۔',
  serverErrorForm: 'سرور ابھی جواب نہیں دے سکا۔ ایک منٹ بعد دوبارہ کوشش کریں۔',
  tryAgain: 'دوبارہ کوشش کریں',
  stale: 'ریفریش نہیں ہو سکا - {time} کا ڈیٹا دکھایا جا رہا ہے۔ ہر منٹ دوبارہ کوشش ہو گی۔',
  busy: 'بہت زیادہ درخواستیں۔ {n} سیکنڈ بعد دوبارہ کوشش ہو گی۔',
  busySoon: 'بہت زیادہ درخواستیں۔ ایک منٹ بعد دوبارہ کوشش ہو گی۔',
  codeMissing: 'اپنا روٹ کوڈ لکھیں۔',
  codeTooLong: 'یہ کوڈ بہت لمبا ہے۔',
  tooManyCodes: 'ایک وقت میں زیادہ سے زیادہ 5 کوڈ۔',
  notFound: '{day} کو {codes} کی کوئی ڈیلیوری نہیں۔ Salesman ETA صفحے پر کوڈ چیک کریں۔',
  ambiguous: '{codes}: یہ کوڈ ایک سے زیادہ روٹ یا ٹرک کا ہے - سب دکھائے گئے ہیں۔',
  severalTrucks: '{code}: یہ کوڈ ایک سے زیادہ ٹرکوں کا ہے۔ ایک منتخب کریں:',
  alsoTruck: '{code} ایک ٹرک کا کوڈ بھی ہے۔ اس کے بجائے ٹرک دکھائیں:',
  nothingYet: 'اس روٹ کے لیے ابھی کچھ نہیں۔',
  notPlannedYetAll: 'ابھی پلان نہیں بنا - پلان عام طور پر ایک دن پہلے شام کو بنتا ہے۔ بعد میں دوبارہ دیکھیں۔',
  noneHere: 'کوئی نہیں۔',
  footerTimes: 'اوقات تقریبی ہیں، کمپنی کے وقت کے مطابق۔ صفحہ ہر منٹ ریفریش ہوتا ہے۔',
  footerUntil: '{day} {time} تک چلے گا۔ صرف سیلز ٹیم کے لیے - براہ کرم آگے نہ بھیجیں۔',
  'st.DELIVERED': 'ڈیلیور ہو گیا',
  'st.PARTLY_DELIVERED': 'جزوی ڈیلیوری',
  'st.NOT_DELIVERED': 'ڈیلیور نہیں ہوا',
  'st.NOT_CONFIRMED': 'ابھی تصدیق نہیں ہوئی',
  'st.ON_THE_WAY': 'راستے میں',
  'st.DELAYED': 'تاخیر',
  'st.CANCELLED': 'منسوخ',
  'st.NOT_IN_PLAN': 'پلان میں نہیں',
  'st.PLANNED': 'پلان شدہ',
  deliveredAt: '{time} بجے',
  expectedAbout: 'تقریباً {time} بجے',
  plannedAt: '{day} کو تقریباً {time} بجے',
  plannedOn: '{day} کو',
  anyMinute: 'چند منٹ میں',
  inAbout: 'تقریباً {t} میں',
  mins: '{m} منٹ',
  hour1: '1 گھنٹہ',
  hours: '{h} گھنٹے',
  beingDelivered: 'ابھی ڈیلیوری ہو رہی ہے',
  casesOf: '{m} میں سے {n} کارٹن',
  movedTo: '{day} پر منتقل',
  notPlannedYet: 'ابھی پلان نہیں ہوا',
  share: 'گاہک کو بھیجیں',
  shareTitle: 'یہ واٹس ایپ پر گاہک کو بھیجیں (کوئی لنک نہیں بھیجا جاتا)',
  'msg.DELIVERED': '{customer}: آپ کا آرڈر {time} بجے ڈیلیور ہو گیا۔',
  'msg.DELIVERED_NO_TIME': '{customer}: آپ کا آرڈر ڈیلیور ہو گیا۔',
  'msg.PARTLY': '{customer}: آپ کے آرڈر کا کچھ حصہ ڈیلیور ہو گیا ({m} میں سے {n} کارٹن)۔ باقی کے بارے میں ہم آپ سے رابطہ کریں گے۔',
  'msg.PARTLY_NO_CASES': '{customer}: آپ کے آرڈر کا کچھ حصہ ڈیلیور ہو گیا۔ باقی کے بارے میں ہم آپ سے رابطہ کریں گے۔',
  'msg.NOT_DELIVERED': '{customer}: آپ کا آرڈر ڈیلیور نہیں ہو سکا۔ ہم آپ سے رابطہ کریں گے۔',
  'msg.NOT_CONFIRMED': '{customer}: ہم آپ کی ڈیلیوری چیک کر رہے ہیں اور آپ سے رابطہ کریں گے۔',
  'msg.AT_CUSTOMER': '{customer}: آپ کا آرڈر ابھی ڈیلیور ہو رہا ہے۔',
  'msg.COMING': '{customer}: آپ کا آرڈر راستے میں ہے، تقریباً {time} بجے پہنچنے کی توقع ہے۔',
  'msg.COMING_NO_TIME': '{customer}: آپ کا آرڈر راستے میں ہے۔',
  'msg.PLANNED': '{customer}: آپ کا آرڈر {day} کو تقریباً {time} بجے کے لیے پلان ہے۔',
  'msg.PLANNED_NO_TIME': '{customer}: آپ کا آرڈر {day} کے لیے پلان ہے۔',
  'link.LINK_NOT_FOUND': 'یہ لنک کام نہیں کر رہا۔ آج کا لنک دفتر سے لیں۔',
  'link.LINK_REPLACED': 'اس لنک کی جگہ نیا لنک آ گیا ہے۔ اپنے گروپ کا تازہ ترین لنک استعمال کریں یا دفتر سے پوچھیں۔',
  'link.LINK_REVOKED': 'دفتر نے یہ لنک بند کر دیا ہے۔ دفتر سے نیا لنک لیں۔',
  'link.LINK_EXPIRED': 'اس لنک کی مدت ختم ہو گئی ہے۔ آج کا لنک دفتر سے لیں۔',
  'link.SALES_LINKS_OFF': 'سیلزمین لنک اس سرور پر دستیاب نہیں۔ دفتر سے پوچھیں۔',
  'link.SIGNED_IN_OTHER_TENANT': 'آپ RouteIQ میں کسی دوسری کمپنی کے لیے سائن ان ہیں۔ یہ لنک استعمال کرنے کے لیے سائن آؤٹ کریں۔',
  linkDay: '{day} کا لنک',
};

export const SALES_DICT: Record<SalesLang, Record<SalesKey, string>> = { en: EN, ar: AR, ur: UR };

/** The language switch's buttons: each language in its own script. */
export const LANG_NAME: Record<SalesLang, string> = { en: 'English', ar: 'العربية', ur: 'اردو' };

/** Arabic and Urdu read right to left. */
export const isRtl = (lang: SalesLang): boolean => lang !== 'en';
export const dirOf = (lang: SalesLang): 'rtl' | 'ltr' => (isRtl(lang) ? 'rtl' : 'ltr');

/** A value kept in its own direction inside right-to-left text (first strong isolate). */
export const isolate = (lang: SalesLang, s: string): string => (isRtl(lang) ? `⁨${s}⁩` : s);

/** The text of `key` with its {placeholders} filled (isolated in Arabic and Urdu). A missing value stays visible as {name}. */
export function st(lang: SalesLang, key: SalesKey, vars: Record<string, string | number> = {}): string {
  const s = SALES_DICT[lang][key] ?? EN[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? isolate(lang, String(vars[k])) : m));
}

/** The {placeholders} of a text, sorted (every language must name the same ones). */
export function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

/** The language chosen: the stored choice, else the phone's language (Arabic, Urdu, else English). */
export function pickSalesLang(stored: string | null | undefined, phoneLanguage: string | null | undefined): SalesLang {
  if (stored === 'en' || stored === 'ar' || stored === 'ur') return stored;
  const p = (phoneLanguage ?? '').toLowerCase();
  return p.startsWith('ar') ? 'ar' : p.startsWith('ur') ? 'ur' : 'en';
}

const LOCALE: Record<SalesLang, string> = { en: 'en-GB', ar: 'ar-OM-u-nu-latn', ur: 'ur-PK-u-nu-latn' };

/** "Mon 19 Oct", "الاثنين، 19 أكتوبر", "پیر، 19 اکتوبر" for a YYYY-MM-DD date (Western digits). */
export function dayText(lang: SalesLang, iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso) || Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

/** An instant's date (YYYY-MM-DD) and time (HH:MM, Western digits) in the company's time zone. */
export function zonedParts(isoInstant: string, tz: string): { date: string; time: string } | null {
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz })
        .formatToParts(d)
        .map((x) => [x.type, x.value]),
    );
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  } catch {
    return null;
  }
}

/**
 * How far an expected time is, rounded: "any minute" under 10 minutes, else to 5 minutes under an hour ("in about
 * 25 min"), else to 10 minutes ("in about 1 h 20 min", "in about 2 h").
 */
export function aboutText(lang: SalesLang, min: number): string {
  if (!Number.isFinite(min) || min < 10) return st(lang, 'anyMinute');
  const r = min < 60 ? Math.round(min / 5) * 5 : Math.round(min / 10) * 10;
  const h = Math.floor(r / 60);
  const m = r % 60;
  const hourPart = h === 0 ? null : h === 1 ? st(lang, 'hour1') : st(lang, 'hours', { h });
  const minPart = m === 0 ? null : st(lang, 'mins', { m });
  return st(lang, 'inAbout', { t: [hourPart, minPart].filter(Boolean).join(' ') });
}
