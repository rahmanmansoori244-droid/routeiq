/**
 * The driver page's words in English and Arabic (owner request 4 Oct 2026, spec section 6.4 and
 * Appendix A). Pure and browser-safe. Placeholders are written {n}; to avoid Arabic plural forms the
 * texts use "label: value" ("المحطات: 9"), never "9 stops" built from parts. Times are 24 h HH:MM and
 * digits are Western in both languages. Customer names, addresses and notes are data: shown as they are.
 *
 * The Arabic must be checked by an NMWC Arabic speaker before launch (open question Q2).
 */
import type { LoadStatusName, NotDeliveredReasonName, PhotoPositionStatusName } from '../driver-link/manifest-types';

export type Lang = 'en' | 'ar';

const EN = {
  appTitle: 'Driver page',
  title: "Today's trips",
  truck: 'Truck',
  driver: 'Driver',
  hiredTruck: 'Hired truck',
  tripOf: 'Trip {n} of {m}',
  stopsLabel: 'Stops: {n}',
  casesLabel: 'Cases: {n}',
  depart: 'Depart {time}',
  backBy: 'Back by {time}',
  stopNo: 'Stop {n}',
  'st.PLANNED': 'Planned - may still change',
  'st.LOCKED': 'Not loaded yet',
  'st.LOADING': 'Loading',
  'st.DISPATCHED': 'On the road',
  'st.COMPLETED': 'Done',
  startDeliveries: 'Start deliveries',
  navigate: 'Navigate',
  noLocation: 'No location - call your dispatcher',
  plannedArrival: 'Planned arrival {time}',
  unloadUntil: 'Unload until {time}',
  receivingHours: 'Receiving hours',
  hoursRange: 'Receives {range}',
  bestHours: 'Best {range}',
  anyTime: 'Any time',
  promised: 'Promised {range}',
  notes: 'Notes',
  access: 'Access',
  salesOrder: 'Sales order',
  partOf: 'Part {n} of {m}',
  carriedFrom: 'Carried over from {date}',
  changedAfterPlanning: 'Changed after planning - ask your dispatcher',
  waitingArrive: 'Waiting to arrive (within {m} m)',
  iArrived: 'I have arrived',
  arrivedTimer: 'Arrived {time} · Unloading {mm} min',
  doneTimer: 'Done {time} · {mm} min',
  delivered: 'Delivered',
  partly: 'Partly delivered',
  notDelivered: 'Not delivered',
  noResult: 'No result',
  next: 'Next',
  reason: 'Reason',
  'r.SHOP_CLOSED': 'Shop closed',
  'r.CUSTOMER_REFUSED': 'Customer refused',
  'r.NO_ONE_TO_RECEIVE': 'No one to receive',
  'r.WRONG_LOCATION': 'Wrong location or could not find',
  'r.NO_TIME_LEFT': 'No time left',
  'r.PAYMENT_ISSUE': 'Payment issue',
  'r.DAMAGED_GOODS': 'Damaged goods',
  'r.NOT_ON_TRUCK': 'Missing from the truck',
  'r.OTHER': 'Other',
  noteRequired: 'Write the reason',
  casesDelivered: 'Cases delivered',
  takePhoto: 'Take photo',
  retake: 'Retake',
  usePhoto: 'Use photo',
  photoRequired: 'Photo required',
  save: 'Save',
  cancel: 'Cancel',
  changeResult: 'Change result',
  undo: 'Undo result',
  backAtDepot: 'Back at depot',
  stopsWithoutResult: 'Stops without a result: {n}. The dispatcher will record them.',
  waitingToSend: 'Waiting to send ({n})',
  allSent: 'All sent',
  noSignal: 'No signal',
  notSentYet: 'Not sent yet - it will be sent automatically.',
  keepOpen: 'Keep this page open. If the screen locks, the timer may pause.',
  gpsLost: 'GPS signal lost',
  locationOff: 'Location is off: the timer cannot start by itself. Tap "I have arrived" at each customer.',
  notDispatched: 'Your dispatcher has not marked this trip as left yet. Arrival times are kept on the phone and sent once it is. Results can be recorded then.',
  noTrips: 'No trips for truck {truck} on {date} (yet).',
  linkInvalid: 'This link does not work any more. Ask your dispatcher for a new one.',
  linkExpired: 'This link was for {date} and has expired.',
  carriedRefused: 'Already moved to {date} by the office. Call your dispatcher.',
  linkDead: 'This link no longer works. {n} results not sent: tell your dispatcher.',
  linkReplaced: 'This link was replaced by a new one. Ask your dispatcher for it.',
  linksOff: 'Driver links are not available right now. Ask your dispatcher.',
  notSentList: 'Not sent from this phone: {n} - show this list to your dispatcher.',
  sendingSaved: 'Sending the results saved on this phone…',
  openInChrome: 'Open in Chrome',
  openInSafari: 'Tap ⋯ or the share icon, then Open in Safari',
  inAppTitle: 'Open this page in your browser',
  inAppBody: 'This app can block the location and the camera.',
  copyLink: 'Copy link',
  linkCopied: 'Link copied',
  cameraNotWorking: 'Camera not working',
  locationNotCaptured: 'Location not captured: take it again at the shop if you can',
  arrivedWhen: 'Arrived at {customer} - when?',
  now: 'Now',
  minAgo: '{n} min ago',
  skip: 'Skip',
  whichCustomer: 'Which customer are you at?',
  openAgainHint: 'When you arrive, open this page again',
  savedOnPhone: 'Saved on phone - waiting to send',
  changedByOffice: 'Changed by office / another phone',
  broughtForward: 'Brought forward to {date}',
  callDispatcher: 'Call dispatcher',
  draftRestored: 'Your last entry was kept.',
  lastPhotoLost: 'The last photo did not arrive - take it again.',
  backAtDepotQ: 'Back at depot?',
  lastUpdated: 'Last updated {time}',
  officeBanner: 'You are signed in to RouteIQ as {name}: results are recorded as the office.',
  'pos.OK': 'Location captured',
  'pos.POOR': 'Location not precise',
  'pos.DENIED': 'Location is off',
  'pos.TIMEOUT': 'No location signal',
  'pos.UNSUPPORTED': 'Location not available on this phone',
  locationTitle: 'Location',
  locationNotice:
    'Location: {company} uses your phone\'s location on this page only while it is open: to start the stop timer when you reach a customer, and to record where delivery photos are taken. It keeps the time and place of each arrival, departure, result and photo for {days} days and the delivery photos themselves for {photoDays} days (delivery proof), never a track of your route. Questions: ask your dispatcher at {company}.',
  ok: 'OK',
  aboutLocation: 'About location',
  loading: 'Loading…',
  networkError: 'No signal. Trying again…',
  tryAgain: 'Try again',
  close: 'Close',
  // Part 2: results, the stop timer, photos and the offline queue.
  timerOn: 'Automatic timer on',
  stopTimer: 'Stop the timer',
  waitingGps: 'Waiting for location…',
  photosLabel: 'Photos: {n}',
  photosWaiting: 'Photos waiting to send: {n}',
  addPhoto: 'Add photo',
  photoLimit: 'Up to {n} photos',
  photoTooLarge: 'Photo too large - retake it.',
  photoFailed: 'The photo could not be used - retake it.',
  noPhotoCamera: 'No photo: camera not working',
  deliveredOf: 'Delivered {n} of {m}',
  allCases: 'All cases',
  recordedLate: 'Recorded after the trip closed',
  tripClosesWhenAll: 'Recorded. The trip closes when every stop has a result.',
  backAt: 'Back at depot {time}',
  notSentTitle: 'Not sent',
  keepOpenNoStorage: 'Keep this page open until everything is sent.',
  arrivedTapped: 'Arrived {time} (tapped)',
  arrivedFound: 'Arrived by {time} (page opened at the shop)',
  confirmBackTitle: 'Back at depot?',
  confirmUndo: 'Remove the result of this stop?',
  yes: 'Yes',
  no: 'No',
  enterResult: 'Record the result',
  resultOf: 'Result',
  notEditable: 'This result can no longer be changed here. Call your dispatcher.',
  locationNeeded: 'Allow location for this page so the timer can start by itself.',
  atStopMin: 'At the stop · {mm} min',
  signedInOther: 'This browser is signed in to RouteIQ for another company. Sign out, or open the link in another browser.',
} as const;

export type Key = keyof typeof EN;

const AR: Record<Key, string> = {
  appTitle: 'صفحة السائق',
  title: 'رحلات اليوم',
  truck: 'الشاحنة',
  driver: 'السائق',
  hiredTruck: 'شاحنة مستأجرة',
  tripOf: 'الرحلة {n} من {m}',
  stopsLabel: 'المحطات: {n}',
  casesLabel: 'الكراتين: {n}',
  depart: 'المغادرة {time}',
  backBy: 'العودة {time}',
  stopNo: 'المحطة {n}',
  'st.PLANNED': 'مخطط - قد يتغير',
  'st.LOCKED': 'لم يتم التحميل بعد',
  'st.LOADING': 'قيد التحميل',
  'st.DISPATCHED': 'في الطريق',
  'st.COMPLETED': 'منتهية',
  startDeliveries: 'ابدأ التوصيل',
  navigate: 'افتح الخريطة',
  noLocation: 'لا يوجد موقع - اتصل بمسؤول التوزيع',
  plannedArrival: 'الوصول المخطط {time}',
  unloadUntil: 'التفريغ حتى {time}',
  receivingHours: 'أوقات الاستلام',
  hoursRange: 'الاستلام {range}',
  bestHours: 'الأفضل {range}',
  anyTime: 'أي وقت',
  promised: 'موعد متفق عليه {range}',
  notes: 'ملاحظات',
  access: 'الدخول',
  salesOrder: 'أمر البيع',
  partOf: 'الجزء {n} من {m}',
  carriedFrom: 'منقول من {date}',
  changedAfterPlanning: 'تغيّر بعد التخطيط - اسأل مسؤول التوزيع',
  waitingArrive: 'بانتظار الوصول (ضمن {m} م)',
  iArrived: 'وصلت',
  arrivedTimer: 'وصلت {time} · التفريغ {mm} د',
  doneTimer: 'تم {time} · {mm} د',
  delivered: 'تم التسليم',
  partly: 'تسليم جزئي',
  notDelivered: 'لم يتم التسليم',
  noResult: 'بدون نتيجة',
  next: 'التالي',
  reason: 'السبب',
  'r.SHOP_CLOSED': 'المحل مغلق',
  'r.CUSTOMER_REFUSED': 'العميل رفض الاستلام',
  'r.NO_ONE_TO_RECEIVE': 'لا يوجد من يستلم',
  'r.WRONG_LOCATION': 'الموقع خطأ أو لم أجده',
  'r.NO_TIME_LEFT': 'لم يتبقَّ وقت',
  'r.PAYMENT_ISSUE': 'مشكلة في الدفع',
  'r.DAMAGED_GOODS': 'بضاعة تالفة',
  'r.NOT_ON_TRUCK': 'غير موجود في الشاحنة',
  'r.OTHER': 'سبب آخر',
  noteRequired: 'اكتب السبب',
  casesDelivered: 'الكراتين المسلَّمة',
  takePhoto: 'التقط صورة',
  retake: 'أعد التصوير',
  usePhoto: 'استخدم الصورة',
  photoRequired: 'الصورة مطلوبة',
  save: 'حفظ',
  cancel: 'إلغاء',
  changeResult: 'تغيير النتيجة',
  undo: 'إلغاء النتيجة',
  backAtDepot: 'عدت إلى المستودع',
  stopsWithoutResult: 'محطات بدون نتيجة: {n}. سيسجلها مسؤول التوزيع.',
  waitingToSend: 'بانتظار الإرسال ({n})',
  allSent: 'تم إرسال الكل',
  noSignal: 'لا يوجد اتصال',
  notSentYet: 'لم يُرسل بعد - سيتم إرساله تلقائيًا.',
  keepOpen: 'أبقِ هذه الصفحة مفتوحة. إذا قُفلت الشاشة قد يتوقف المؤقت.',
  gpsLost: 'فُقدت إشارة الموقع',
  locationOff: 'الموقع مغلق: لن يبدأ المؤقت تلقائيًا. اضغط «وصلت» عند كل عميل.',
  notDispatched: 'لم يسجّل مسؤول التوزيع خروج هذه الرحلة بعد. تُحفظ أوقات الوصول في الهاتف وتُرسل بعد ذلك، ويمكن تسجيل النتائج حينها.',
  noTrips: 'لا توجد رحلات للشاحنة {truck} في {date} حتى الآن.',
  linkInvalid: 'هذا الرابط لم يعد يعمل. اطلب رابطًا جديدًا من مسؤول التوزيع.',
  linkExpired: 'هذا الرابط كان ليوم {date} وانتهت صلاحيته.',
  carriedRefused: 'تم نقلها إلى {date} من المكتب. اتصل بمسؤول التوزيع.',
  linkDead: 'هذا الرابط لم يعد يعمل. {n} نتائج لم تُرسل: أبلغ مسؤول التوزيع.',
  linkReplaced: 'تم استبدال هذا الرابط برابط جديد. اطلبه من مسؤول التوزيع.',
  linksOff: 'روابط السائقين غير متاحة الآن. اسأل مسؤول التوزيع.',
  notSentList: 'لم تُرسل من هذا الهاتف: {n} - اعرض هذه القائمة على مسؤول التوزيع.',
  sendingSaved: 'جارٍ إرسال النتائج المحفوظة في هذا الهاتف…',
  openInChrome: 'افتح في كروم',
  openInSafari: 'اضغط ⋯ أو أيقونة المشاركة ثم «فتح في سفاري»',
  inAppTitle: 'افتح هذه الصفحة في المتصفح',
  inAppBody: 'قد يمنع هذا التطبيق الموقع والكاميرا.',
  copyLink: 'انسخ الرابط',
  linkCopied: 'تم نسخ الرابط',
  cameraNotWorking: 'الكاميرا لا تعمل',
  locationNotCaptured: 'لم يُسجَّل الموقع: أعد التصوير عند المحل إن أمكن',
  arrivedWhen: 'متى وصلت إلى {customer}؟',
  now: 'الآن',
  minAgo: 'قبل {n} د',
  skip: 'تخطَّ',
  whichCustomer: 'عند أي عميل أنت؟',
  openAgainHint: 'عند وصولك، افتح هذه الصفحة مرة أخرى',
  savedOnPhone: 'محفوظ في الهاتف - بانتظار الإرسال',
  changedByOffice: 'غيّرها المكتب / هاتف آخر',
  broughtForward: 'نُقلت إلى {date}',
  callDispatcher: 'اتصل بمسؤول التوزيع',
  draftRestored: 'تم حفظ آخر إدخال لك.',
  lastPhotoLost: 'لم تصل الصورة الأخيرة - التقطها مرة أخرى.',
  backAtDepotQ: 'هل عدت إلى المستودع؟',
  lastUpdated: 'آخر تحديث {time}',
  officeBanner: 'أنت مسجّل الدخول في RouteIQ باسم {name}: تُسجَّل النتائج باسم المكتب.',
  'pos.OK': 'تم تسجيل الموقع',
  'pos.POOR': 'الموقع غير دقيق',
  'pos.DENIED': 'الموقع مغلق',
  'pos.TIMEOUT': 'لا توجد إشارة موقع',
  'pos.UNSUPPORTED': 'الموقع غير متاح في هذا الهاتف',
  locationTitle: 'الموقع',
  locationNotice:
    'الموقع: تستخدم {company} موقع هاتفك في هذه الصفحة فقط أثناء فتحها، لبدء مؤقت التوقف عند وصولك إلى العميل ولتسجيل مكان التقاط صور التسليم. تحفظ وقت ومكان كل وصول ومغادرة ونتيجة وصورة لمدة {days} يومًا، وتحفظ صور التسليم نفسها لمدة {photoDays} يومًا (إثبات التسليم)، ولا تسجّل مسار رحلتك. للاستفسار: اسأل مسؤول التوزيع في {company}.',
  ok: 'حسنًا',
  aboutLocation: 'عن الموقع',
  loading: 'جارٍ التحميل…',
  networkError: 'لا يوجد اتصال. جارٍ إعادة المحاولة…',
  tryAgain: 'حاول مرة أخرى',
  close: 'إغلاق',
  timerOn: 'المؤقت التلقائي يعمل',
  stopTimer: 'أوقف المؤقت',
  waitingGps: 'بانتظار الموقع…',
  photosLabel: 'الصور: {n}',
  photosWaiting: 'صور بانتظار الإرسال: {n}',
  addPhoto: 'أضف صورة',
  photoLimit: 'حتى {n} صور',
  photoTooLarge: 'الصورة كبيرة جدًا - أعد التصوير.',
  photoFailed: 'تعذّر استخدام الصورة - أعد التصوير.',
  noPhotoCamera: 'بدون صورة: الكاميرا لا تعمل',
  deliveredOf: 'تم تسليم {n} من {m}',
  allCases: 'كل الكراتين',
  recordedLate: 'سُجّلت بعد إغلاق الرحلة',
  tripClosesWhenAll: 'تم التسجيل. تُغلق الرحلة عندما يكون لكل محطة نتيجة.',
  backAt: 'العودة إلى المستودع {time}',
  notSentTitle: 'لم يُرسل',
  keepOpenNoStorage: 'أبقِ هذه الصفحة مفتوحة حتى يتم إرسال كل شيء.',
  arrivedTapped: 'وصلت {time} (يدويًا)',
  arrivedFound: 'وصلت قبل {time} (فُتحت الصفحة عند المحل)',
  confirmBackTitle: 'هل عدت إلى المستودع؟',
  confirmUndo: 'هل تريد حذف نتيجة هذه المحطة؟',
  yes: 'نعم',
  no: 'لا',
  enterResult: 'سجّل النتيجة',
  resultOf: 'النتيجة',
  notEditable: 'لا يمكن تغيير هذه النتيجة من هنا. اتصل بمسؤول التوزيع.',
  locationNeeded: 'اسمح بالموقع لهذه الصفحة حتى يبدأ المؤقت تلقائيًا.',
  atStopMin: 'عند المحطة · {mm} د',
  signedInOther: 'هذا المتصفح مسجّل الدخول في RouteIQ لشركة أخرى. سجّل الخروج أو افتح الرابط في متصفح آخر.',
};

export const DICT: Record<Lang, Record<Key, string>> = { en: EN, ar: AR };

/** The label of the language toggle: the OTHER language, in its own script. */
export const LANG_TOGGLE: Record<Lang, string> = { en: 'العربية', ar: 'English' };

/** The text of `key` with its {placeholders} filled. A missing placeholder value stays visible as {name}. */
export function t(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  const s = DICT[lang][key] ?? DICT.en[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** The {placeholders} of a text, sorted (EN and AR must name the same ones). */
export function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

/** The language chosen: the stored choice, else the phone's language (Arabic or English). */
export function pickLang(stored: string | null | undefined, navigatorLanguage: string | null | undefined): Lang {
  if (stored === 'en' || stored === 'ar') return stored;
  return (navigatorLanguage ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

const LOCALE: Record<Lang, string> = { en: 'en-GB', ar: 'ar-OM-u-nu-latn' };

/** "Sun 5 Oct" (English) or its Arabic form, with Western digits, for a YYYY-MM-DD date. */
export function fmtDate(lang: Lang) {
  return (iso: string): string => {
    const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
  };
}

/** 390 -> "06:30" (24 h, Western digits in both languages); values past midnight get "+1". */
export function hhmm(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return '--:--';
  const m = Math.round(min);
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}${m >= 1440 ? ' +1' : ''}`;
}

/** An instant as HH:MM in the company's time zone (Western digits). */
export function clockTime(isoInstant: string, tz: string): string {
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) return '--:--';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(d);
}

type Hours = { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null } | null;
type Promised = { startMin: number | null; endMin: number | null } | null;

/** The stop's hours in words: the promised time, else the receiving hours (and the best hours), else "Any time". */
export function fmtHours(lang: Lang, hours: Hours, promised: Promised): string {
  // One isolated left-to-right run (\u2066 ... \u2069) in Arabic: in right-to-left text 07:00-12:00 would read 12:00-07:00.
  const range = (a: number | null, b: number | null) => {
    const r = `${a === null ? '00:00' : hhmm(a)}-${b === null ? '24:00' : hhmm(b)}`;
    return { range: lang === 'ar' ? `\u2066${r}\u2069` : r };
  };
  if (promised && (promised.startMin !== null || promised.endMin !== null)) return t(lang, 'promised', range(promised.startMin, promised.endMin));
  const parts: string[] = [];
  if (hours && (hours.hardStart !== null || hours.hardEnd !== null)) parts.push(t(lang, 'hoursRange', range(hours.hardStart, hours.hardEnd)));
  if (hours && (hours.prefStart !== null || hours.prefEnd !== null)) parts.push(t(lang, 'bestHours', range(hours.prefStart, hours.prefEnd)));
  return parts.length ? parts.join(' · ') : t(lang, 'anyTime');
}

export function reasonLabel(lang: Lang, reason: NotDeliveredReasonName): string {
  return t(lang, `r.${reason}` as Key);
}

export function statusLabel(lang: Lang, status: LoadStatusName): string {
  return t(lang, `st.${status}` as Key);
}

export function positionLabel(lang: Lang, status: PhotoPositionStatusName): string {
  return t(lang, `pos.${status}` as Key);
}
