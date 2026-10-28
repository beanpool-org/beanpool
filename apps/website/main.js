/**
 * BeanPool.org — Live Node Directory, Interactive Map, Newsletter, Language Banner & Utilities
 * 
 * Polls known BeanPool node endpoints for directory info,
 * then displays them as markers on a Leaflet map with radius circles.
 * All user-facing strings adapt by document.documentElement.lang via WORDS.
 */

const SUPABASE_URL = 'https://dpemwoermzkaxoctafzg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fmlYuaf6NCkTI2IwWnvZmw_bOzo-PrF';
const supabaseClient = (typeof window !== 'undefined' && window.supabase)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// ======================== WORDS & LOCALIZATION ========================
const GUIDE_LANGS = [
    'es', 'pt', 'hi', 'bn', 'fr', 'ar', 'id', 'ru',
    'zh-Hans', 'zh-Hant', 'it', 'de', 'tr', 'sw', 'ml', 'ta',
    'uk', 'ur', 'fa', 'vi', 'el', 'fil', 'ja', 'ko'
];

const LANGUAGE_NAMES = {
    en: 'English', es: 'Español', pt: 'Português', hi: 'हिन्दी', bn: 'বাংলা', fr: 'Français', ar: 'العربية',
    id: 'Bahasa Indonesia', ru: 'Русский', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', it: 'Italiano', de: 'Deutsch',
    tr: 'Türkçe', sw: 'Kiswahili', ml: 'മലയാളം', ta: 'தமிழ்', uk: 'Українська', ur: 'اردو', fa: 'فارسی',
    vi: 'Tiếng Việt', el: 'Ελληνικά', fil: 'Filipino', ja: '日本語', ko: '한국어',
};

const WORDS = {
    en: {
        noneNear: 'No community near you yet.',
        notLoaded: "The list of communities isn't available right now. Try again soon.",
        members: (n) => `${n} members`,
        radius: (km) => `${km}km radius`,
        visit: (host) => `Visit ${host} →`,
        subscribing: 'Subscribing...',
        alreadySubscribed: "You're already subscribed! 🫘",
        checkInbox: 'Check your inbox for a confirmation email! 🫘',
        somethingWrong: 'Something went wrong. Please try again.',
        subscribe: 'Subscribe',
        readIn: (lang) => `Read this in ${lang} →`,
        notAnswering: 'Not answering lately',
    },
    es: {
        noneNear: 'Aún no hay una comunidad cerca de ti.',
        notLoaded: 'La lista de comunidades no está disponible en este momento. Inténtalo de nuevo pronto.',
        members: (n) => `${n} miembros`,
        radius: (km) => `Radio de ${km}km`,
        visit: (host) => `Visitar ${host} →`,
        subscribing: 'Suscribiendo...',
        alreadySubscribed: '¡Ya estás suscrito! 🫘',
        checkInbox: '¡Revisa tu bandeja de entrada para el correo de confirmación! 🫘',
        somethingWrong: 'Algo salió mal. Por favor, inténtalo de nuevo.',
        subscribe: 'Suscribirse',
        readIn: (lang) => `Leer esto en ${lang} →`,
        notAnswering: 'No responde últimamente',
    },
    pt: {
        noneNear: 'Ainda não há comunidade perto de você.',
        notLoaded: 'A lista de comunidades não está disponível no momento. Tente novamente em breve.',
        members: (n) => `${n} membros`,
        radius: (km) => `Raio de ${km}km`,
        visit: (host) => `Visitar ${host} →`,
        subscribing: 'Inscrevendo...',
        alreadySubscribed: 'Você já está inscrito! 🫘',
        checkInbox: 'Verifique sua caixa de entrada para o e-mail de confirmação! 🫘',
        somethingWrong: 'Algo deu errado. Por favor, tente novamente.',
        subscribe: 'Inscrever-se',
        readIn: (lang) => `Ler isto em ${lang} →`,
        notAnswering: 'Sem resposta ultimamente',
    },
    fr: {
        noneNear: 'Pas encore de communauté près de chez vous.',
        notLoaded: 'La liste des communautés n\'est pas disponible pour le moment. Réessayez bientôt.',
        members: (n) => `${n} membres`,
        radius: (km) => `Rayon de ${km}km`,
        visit: (host) => `Visiter ${host} →`,
        subscribing: 'Inscription en cours...',
        alreadySubscribed: 'Vous êtes déjà inscrit ! 🫘',
        checkInbox: 'Vérifiez votre boîte de réception pour un e-mail de confirmation ! 🫘',
        somethingWrong: 'Un problème est survenu. Veuillez réessayer.',
        subscribe: 'S\'inscrire',
        readIn: (lang) => `Lire en ${lang} →`,
        notAnswering: 'Ne répond pas ces derniers temps',
    },
    ru: {
        noneNear: 'Рядом с вами пока нет сообщества.',
        notLoaded: 'Список сообществ сейчас недоступен. Попробуйте позже.',
        members: (n) => `${n} участников`,
        radius: (km) => `Радиус ${km} км`,
        visit: (host) => `Перейти на ${host} →`,
        subscribing: 'Подписка...',
        alreadySubscribed: 'Вы уже подписаны! 🫘',
        checkInbox: 'Проверьте почту для подтверждения! 🫘',
        somethingWrong: 'Что-то пошло не так. Пожалуйста, попробуйте еще раз.',
        subscribe: 'Подписаться',
        readIn: (lang) => `Читать на ${lang} →`,
        notAnswering: 'В последнее время не отвечает',
    },
    ar: {
        noneNear: 'لا يوجد مجتمع بالقرب منك بعد.',
        notLoaded: 'قائمة المجتمعات غير متاحة حالياً. حاول مرة أخرى قريباً.',
        members: (n) => `${n} أعضاء`,
        radius: (km) => `نصف القطر ${km} كم`,
        visit: (host) => `زيارة ${host} ←`,
        subscribing: 'جارٍ الاشتراك...',
        alreadySubscribed: 'أنت مشترك بالفعل! 🫘',
        checkInbox: 'تحقق من بريدك الإلكتروني للحصول على رسالة التأكيد! 🫘',
        somethingWrong: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
        subscribe: 'اشتراك',
        readIn: (lang) => `اقرأ هذا باللغة ${lang} ←`,
        notAnswering: 'لا يستجيب مؤخرًا',
    },
    hi: {
        noneNear: 'आपके पास अभी कोई समुदाय नहीं है।',
        notLoaded: 'समुदायों की सूची अभी उपलब्ध नहीं है। कृपया थोड़ी देर बाद पुनः प्रयास करें।',
        members: (n) => `${n} सदस्य`,
        radius: (km) => `${km} किमी का दायरा`,
        visit: (host) => `${host} पर जाएँ →`,
        subscribing: 'सहेजा जा रहा है...',
        alreadySubscribed: 'आप पहले से ही सब्सक्राइब हैं! 🫘',
        checkInbox: 'पुष्टि ईमेल के लिए अपना इनबॉक्स देखें! 🫘',
        somethingWrong: 'कुछ गलत हो गया। कृपया पुन: प्रयास करें।',
        subscribe: 'सब्सक्राइब करें',
        readIn: (lang) => `इसे ${lang} में पढ़ें →`,
        notAnswering: 'हाल में जवाब नहीं दे रहा',
    },
    bn: {
        noneNear: 'আপনার আশেপাশে এখনও কোনো কমিউনিটি নেই।',
        notLoaded: 'কমিউনিটির তালিকা এই মুহূর্তে পাওয়া যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।',
        members: (n) => `${n} জন সদস্য`,
        radius: (km) => `${km} কিমি ব্যাসার্ধ`,
        visit: (host) => `${host} দেখুন →`,
        subscribing: 'সাবস্ক্রাইব করা হচ্ছে...',
        alreadySubscribed: 'আপনি ইতিমধ্যেই সাবস্ক্রাইব করেছেন! 🫘',
        checkInbox: 'নিশ্চিতকরণ ইমেলের জন্য আপনার ইনবক্স চেক করুন! 🫘',
        somethingWrong: 'কিছু ভুল হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।',
        subscribe: 'সাবস্ক্রাইব করুন',
        readIn: (lang) => `এটি ${lang} এ পড়ুন →`,
        notAnswering: 'সম্প্রতি সাড়া দিচ্ছে না',
    },
    id: {
        noneNear: 'Belum ada komunitas di dekat Anda.',
        notLoaded: 'Daftar komunitas saat ini tidak tersedia. Coba lagi segera.',
        members: (n) => `${n} anggota`,
        radius: (km) => `Radius ${km}km`,
        visit: (host) => `Kunjungi ${host} →`,
        subscribing: 'Berlangganan...',
        alreadySubscribed: 'Anda sudah berlangganan! 🫘',
        checkInbox: 'Periksa kotak masuk Anda untuk email konfirmasi! 🫘',
        somethingWrong: 'Terjadi kesalahan. Silakan coba lagi.',
        subscribe: 'Berlangganan',
        readIn: (lang) => `Baca ini dalam ${lang} →`,
        notAnswering: 'Belakangan tidak merespons',
    },
    'zh-Hans': {
        noneNear: '您附近暂无社区。',
        notLoaded: '社区列表目前无法获取。请稍后再试。',
        members: (n) => `${n} 位成员`,
        radius: (km) => `${km} 公里半径`,
        visit: (host) => `访问 ${host} →`,
        subscribing: '正在订阅...',
        alreadySubscribed: '您已经订阅了！🫘',
        checkInbox: '请检查您的收件箱以获取确认邮件！🫘',
        somethingWrong: '出了点问题。请重试。',
        subscribe: '订阅',
        readIn: (lang) => `用${lang}阅读 →`,
        notAnswering: '最近没有响应',
    },
    'zh-Hant': {
        noneNear: '您附近尚無社群。',
        notLoaded: '社群列表目前無法取得。請稍後再試。',
        members: (n) => `${n} 位成員`,
        radius: (km) => `${km} 公里半徑`,
        visit: (host) => `造訪 ${host} →`,
        subscribing: '正在訂閱...',
        alreadySubscribed: '您已經訂閱了！🫘',
        checkInbox: '請檢查您的收件匣以獲取確認電子郵件！🫘',
        somethingWrong: '發生問題。請再試一次。',
        subscribe: '訂閱',
        readIn: (lang) => `用${lang}閱讀 →`,
        notAnswering: '最近沒有回應',
    },
    it: {
        noneNear: 'Nessuna comunità ancora vicino a te.',
        notLoaded: 'L\'elenco delle comunità non è al momento disponibile. Riprova presto.',
        members: (n) => `${n} membri`,
        radius: (km) => `Raggio di ${km}km`,
        visit: (host) => `Visita ${host} →`,
        subscribing: 'Iscrizione in corso...',
        alreadySubscribed: 'Sei già iscritto! 🫘',
        checkInbox: 'Controlla la tua casella di posta per un\'email di conferma! 🫘',
        somethingWrong: 'Qualcosa è andato storto. Riprova.',
        subscribe: 'Iscriviti',
        readIn: (lang) => `Leggi in ${lang} →`,
        notAnswering: 'Non risponde di recente',
    },
    de: {
        noneNear: 'Noch keine Community in deiner Nähe.',
        notLoaded: 'Die Community-Liste ist derzeit nicht verfügbar. Bitte versuche es bald wieder.',
        members: (n) => `${n} Mitglieder`,
        radius: (km) => `${km}km Umkreis`,
        visit: (host) => `${host} besuchen →`,
        subscribing: 'Wird abonniert...',
        alreadySubscribed: 'Du bist bereits abonniert! 🫘',
        checkInbox: 'Prüfe deinen Posteingang für eine Bestätigungs-E-Mail! 🫘',
        somethingWrong: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
        subscribe: 'Abonnieren',
        readIn: (lang) => `Dies auf ${lang} lesen →`,
        notAnswering: 'Antwortet in letzter Zeit nicht',
    },
    tr: {
        noneNear: 'Yakınınızda henüz bir topluluk yok.',
        notLoaded: 'Topluluk listesi şu anda kullanılamıyor. Lütfen yakında tekrar deneyin.',
        members: (n) => `${n} üye`,
        radius: (km) => `${km}km yarıçap`,
        visit: (host) => `${host} adresini ziyaret et →`,
        subscribing: 'Abone olunuyor...',
        alreadySubscribed: 'Zaten abonesiniz! 🫘',
        checkInbox: 'Onay e-postası için gelen kutunuzu kontrol edin! 🫘',
        somethingWrong: 'Bir şeyler ters gitti. Lütfen tekrar deneyin.',
        subscribe: 'Abone Ol',
        readIn: (lang) => `Bunu ${lang} dilinde oku →`,
        notAnswering: 'Son zamanlarda yanıt vermiyor',
    },
    sw: {
        noneNear: 'Bado hakuna jumuiya karibu nawe.',
        notLoaded: 'Orodha ya jumuiya haipatikani kwa sasa. Jaribu tena hivi karibuni.',
        members: (n) => `wanachama ${n}`,
        radius: (km) => `kipenyo cha km ${km}`,
        visit: (host) => `Tembelea ${host} →`,
        subscribing: 'Inajiandikisha...',
        alreadySubscribed: 'Umejiandikisha tayari! 🫘',
        checkInbox: 'Angalia kikasha chako kwa barua pepe ya uthibitisho! 🫘',
        somethingWrong: 'Hitilafu imetokea. Tafadhali jaribu tena.',
        subscribe: 'Jiandikishe',
        readIn: (lang) => `Soma hii kwa ${lang} →`,
        notAnswering: 'Haijibu siku za karibuni',
    },
    ml: {
        noneNear: 'നിങ്ങളുടെ അടുത്ത് ഇതുവരെ കമ്മ്യൂണിറ്റികളൊന്നുമില്ല.',
        notLoaded: 'കമ്മ്യൂണിറ്റികളുടെ ലിസ്റ്റ് ഇപ്പോൾ ലഭ്യമല്ല. ഉടൻ വീണ്ടും ശ്രമിക്കുക.',
        members: (n) => `${n} അംഗങ്ങൾ`,
        radius: (km) => `${km} കി.മീ പരിധി`,
        visit: (host) => `${host} സന്ദർശിക്കുക →`,
        subscribing: 'സബ്‌സ്‌ക്രൈബ് ചെയ്യുന്നു...',
        alreadySubscribed: 'നിങ്ങൾ ഇതിനകം സബ്‌സ്‌ക്രൈബ് ചെയ്‌തിരിക്കുന്നു! 🫘',
        checkInbox: 'സ്ഥിരീകരണ ഇമെയിലിനായി നിങ്ങളുടെ ഇൻബോക്സ് പരിശോധിക്കുക! 🫘',
        somethingWrong: 'എന്തോ കുഴപ്പമുണ്ടായി. വീണ്ടും ശ്രമിക്കുക.',
        subscribe: 'സബ്‌സ്‌ക്രൈബ് ചെയ്യുക',
        readIn: (lang) => `ഇത് ${lang}ൽ വായിക്കുക →`,
        notAnswering: 'അടുത്തിടെ പ്രതികരിക്കുന്നില്ല',
    },
    ta: {
        noneNear: 'உங்கள் அருகில் இன்னும் சமூகம் இல்லை.',
        notLoaded: 'சமூகங்களின் பட்டியல் தற்போது கிடைக்கவில்லை. விரைவில் மீண்டும் முயற்சிக்கவும்.',
        members: (n) => `${n} உறுப்பினர்கள்`,
        radius: (km) => `${km} கி.மீ சுற்றளவு`,
        visit: (host) => `${host} ஐப் பார்வையிடவும் →`,
        subscribing: 'பதிவு செய்யப்படுகிறது...',
        alreadySubscribed: 'நீங்கள் ஏற்கனவே குழுசேர்ந்துள்ளீர்கள்! 🫘',
        checkInbox: 'உறுதிப்படுத்தல் மின்னஞ்சலுக்கு உங்கள் இன்பாக்ஸைச் சரிபார்க்கவும்! 🫘',
        somethingWrong: 'ஏதோ தவறாகிவிட்டது. தயவுசெய்து மீண்டும் முயற்சிக்கவும்.',
        subscribe: 'குழுசேர்',
        readIn: (lang) => `இதை ${lang} இல் படிக்கவும் →`,
        notAnswering: 'சமீபத்தில் பதிலளிக்கவில்லை',
    },
    uk: {
        noneNear: 'Поблизу вас поки немає спільноти.',
        notLoaded: 'Список спільнот зараз недоступний. Спробуйте знову незабаром.',
        members: (n) => `${n} учасників`,
        radius: (km) => `Радіус ${km} км`,
        visit: (host) => `Відвідати ${host} →`,
        subscribing: 'Підписка...',
        alreadySubscribed: 'Ви вже підписалися! 🫘',
        checkInbox: 'Перевірте поштову скриньку для підтвердження! 🫘',
        somethingWrong: 'Щось пішло не так. Будь ласка, спробуйте ще раз.',
        subscribe: 'Підписатися',
        readIn: (lang) => `Читати ${lang} мовою →`,
        notAnswering: 'Останнім часом не відповідає',
    },
    ur: {
        noneNear: 'آپ کے قریب ابھی کوئی کمیونٹی نہیں ہے۔',
        notLoaded: 'کمیونٹیز کی فہرست فی الحال دستیاب نہیں ہے۔ براہ کرم جلد دوبارہ کوشش کریں۔',
        members: (n) => `${n} اراکین`,
        radius: (km) => `${km} کلومیٹر رداس`,
        visit: (host) => `${host} پر جائیں ←`,
        subscribing: 'سبسکرائب ہو رہا ہے...',
        alreadySubscribed: 'آپ پہلے سے ہی سبسکرائب ہیں! 🫘',
        checkInbox: 'تصدیقی ای میل کے لیے اپنا ان باکس چیک کریں! 🫘',
        somethingWrong: 'کچھ خرابی پیش آگئی۔ براہ کرم دوبارہ کوشش کریں۔',
        subscribe: 'سبسکرائب کریں',
        readIn: (lang) => `اسے ${lang} میں پڑھیں ←`,
        notAnswering: 'حال ہی میں جواب نہیں دے رہا',
    },
    fa: {
        noneNear: 'هنوز جامعه‌ای نزدیک شما وجود ندارد.',
        notLoaded: 'فهرست جوامع در حال حاضر در دسترس نیست. به زودی دوباره امتحان کنید.',
        members: (n) => `${n} عضو`,
        radius: (km) => `شعاع ${km} کیلومتر`,
        visit: (host) => `بازدید از ${host} ←`,
        subscribing: 'در حال اشتراک...',
        alreadySubscribed: 'شما قبلاً مشترک شده‌اید! 🫘',
        checkInbox: 'برای ایمیل تأیید، صندوق ورودی خود را بررسی کنید! 🫘',
        somethingWrong: 'مشکلی پیش آمد. لطفاً دوباره تلاش کنید.',
        subscribe: 'اشتراک',
        readIn: (lang) => `این را به زبان ${lang} بخوانید ←`,
        notAnswering: 'اخیراً پاسخ نمی‌دهد',
    },
    vi: {
        noneNear: 'Chưa có cộng đồng nào gần bạn.',
        notLoaded: 'Danh sách cộng đồng hiện không khả dụng. Vui lòng thử lại sớm.',
        members: (n) => `${n} thành viên`,
        radius: (km) => `Bán kính ${km}km`,
        visit: (host) => `Truy cập ${host} →`,
        subscribing: 'Đang đăng ký...',
        alreadySubscribed: 'Bạn đã đăng ký rồi! 🫘',
        checkInbox: 'Kiểm tra hộp thư đến của bạn để nhận email xác nhận! 🫘',
        somethingWrong: 'Đã xảy ra lỗi. Vui lòng thử lại.',
        subscribe: 'Đăng ký',
        readIn: (lang) => `Đọc bằng ${lang} →`,
        notAnswering: 'Gần đây không phản hồi',
    },
    el: {
        noneNear: 'Δεν υπάρχει ακόμα κοινότητα κοντά σας.',
        notLoaded: 'Η λίστα κοινοτήτων δεν είναι διαθέσιμη αυτή τη στιγμή. Δοκιμάστε ξανά σύντομα.',
        members: (n) => `${n} μέλη`,
        radius: (km) => `Ακτίνα ${km}χλμ`,
        visit: (host) => `Επισκεφθείτε το ${host} →`,
        subscribing: 'Εγγραφή...',
        alreadySubscribed: 'Είστε ήδη εγγεγραμμένοι! 🫘',
        checkInbox: 'Ελέγξτε τα εισερχόμενά σας για το email επιβεβαίωσης! 🫘',
        somethingWrong: 'Κάτι πήγε στραβά. Παρακαλώ δοκιμάστε ξανά.',
        subscribe: 'Εγγραφή',
        readIn: (lang) => `Διαβάστε το στα ${lang} →`,
        notAnswering: 'Δεν απαντά τελευταία',
    },
    fil: {
        noneNear: 'Wala pang komunidad na malapit sa iyo.',
        notLoaded: 'Hindi available ang listahan ng mga komunidad ngayon. Subukang muli mamaya.',
        members: (n) => `${n} miyembro`,
        radius: (km) => `${km}km radius`,
        visit: (host) => `Bisitahin ang ${host} →`,
        subscribing: 'Nagsu-subscribe...',
        alreadySubscribed: 'Naka-subscribe ka na! 🫘',
        checkInbox: 'Tingnan ang iyong inbox para sa email ng kumpirmasyon! 🫘',
        somethingWrong: 'May nagkaproblema. Pakisubukan muli.',
        subscribe: 'Mag-subscribe',
        readIn: (lang) => `Basahin ito sa ${lang} →`,
        notAnswering: 'Hindi sumasagot nitong mga nakaraan',
    },
    ja: {
        noneNear: 'お近くにコミュニティはまだありません。',
        notLoaded: 'コミュニティ一覧は現在利用できません。しばらくしてからもう一度お試しください。',
        members: (n) => `${n} 人のメンバー`,
        radius: (km) => `半径 ${km}km`,
        visit: (host) => `${host} を訪問 →`,
        subscribing: '登録中...',
        alreadySubscribed: 'すでに登録されています！🫘',
        checkInbox: '確認メールを受信トレイでご確認ください！🫘',
        somethingWrong: '問題が発生しました。もう一度お試しください。',
        subscribe: '登録する',
        readIn: (lang) => `${lang}で読む →`,
        notAnswering: '最近応答がありません',
    },
    ko: {
        noneNear: '주변에 아직 커뮤니티가 없습니다.',
        notLoaded: '커뮤니티 목록을 지금 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
        members: (n) => `멤버 ${n}명`,
        radius: (km) => `반경 ${km}km`,
        visit: (host) => `${host} 방문 →`,
        subscribing: '구독 중...',
        alreadySubscribed: '이미 구독하셨습니다! 🫘',
        checkInbox: '확인 이메일을 받으려면 받은편지함을 확인하세요! 🫘',
        somethingWrong: '문제가 발생했습니다. 다시 시도해 주세요.',
        subscribe: '구독',
        readIn: (lang) => `${lang}로 읽기 →`,
        notAnswering: '최근 응답 없음',
    }
};

if (typeof window !== 'undefined') {
    window.WORDS = WORDS;
}

function pageLang() {
    return (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'en';
}

function word(key, ...args) {
    const lang = pageLang();
    const table = WORDS[lang] || WORDS.en;
    const val = (table && table[key] !== undefined) ? table[key] : WORDS.en[key];
    return typeof val === 'function' ? val(...args) : val;
}

// ======================== MAP INIT ========================
const mapContainer = typeof document !== 'undefined' ? document.getElementById('nodes-map') : null;
const nodesMap = (mapContainer && typeof L !== 'undefined') ? L.map('nodes-map', {
    center: [20, 0],
    zoom: 2,
    zoomControl: true,
    attributionControl: false,
    scrollWheelZoom: false,
}) : null;

if (nodesMap) {
    // The tiles' credit (ODbL), said once: the attribution control shows each layer's own attribution, so it is given
    // here and nowhere else (an addAttribution as well showed it twice).
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(nodesMap);

    L.control.attribution({ position: 'bottomright', prefix: false }).addTo(nodesMap);
}

// ======================== NODE POLLING ========================
const nodeIcon = (typeof L !== 'undefined' && L.divIcon) ? L.divIcon({
    html: '<div class="map-pulse-marker"><div class="map-pulse-core"></div><div class="map-pulse-glow"></div></div>',
    className: '',
    // 44px to tap; .map-pulse-marker keeps the pin where it was in a 24px box
    iconSize: [44, 44],
    iconAnchor: [22, 22],
}) : null;

let totalMembers = 0;
let totalNodes = 0;
// Whether the directory has answered once: until it has, an empty map is unknown, never "none".
let directoryLoaded = false;
const bounds = [];
const markersLayer = (nodesMap && typeof L !== 'undefined') ? L.layerGroup().addTo(nodesMap) : null;

// ======================== DIRECTORY ROWS ========================
// Every field of a directory row is what some community published, and anyone who runs a node can publish one. This is
// also the site the registrar's admin page is on, so markup in a row would be script here. A popup is built from DOM
// nodes, each value put in as text; a link is made only from an email or a phone number that passes the check for its
// kind, and only as mailto: or tel:, or from the node_url, only as the https origin it names (as the server's
// directory cache reads it). A number that isn't one is left out, so Leaflet never throws on a row.

const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PHONE = /^\+?[0-9 ().-]{3,32}$/;

function mailtoHref(email) {
    return email.length <= 254 && EMAIL.test(email) ? `mailto:${email}` : null;
}

/** A community's address: its https origin, or null (a bare host is its https address; no IP literal, no localhost). */
function nodeHref(value) {
    if (!value || value.length > 300) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value
        : /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?\/?$/i.test(value) ? `https://${value}` : null;
    if (!withScheme) return null;
    let u;
    try { u = new URL(withScheme); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!/\.[a-z][a-z0-9-]*$/i.test(u.hostname)) return null;
    return u.origin;
}

function telHref(phone) {
    if (!PHONE.test(phone)) return null;
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 3 ? `tel:${phone.startsWith('+') ? '+' : ''}${digits}` : null;
}

function text(v) {
    return typeof v === 'string' ? v.trim() : '';
}

function number(v) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$/.test(v) ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
}

// ======================== WHICH ROWS ARE SHOWN ========================
// A listed row is a live, real, named community that leads somewhere (front doors S13). The directory's view,
// directory_listed, already gives only the rows pushed within 7 days with an https address or a contact, each with its
// shown_name and last_seen_at; the site checks the same again here, because every row is still what someone
// published, and because the view may not be there yet (then the site reads the table, with these same rules). The
// stats count only the rows shown.
const LISTED_FOR_MS = 7 * 24 * 3600 * 1000;
/** Past this since its last push, a row says "Not answering lately" under its name (core NOT_ANSWERING_AFTER_HOURS). */
const NOT_ANSWERING_AFTER_MS = 36 * 3600 * 1000;
/** The name a node stores when nobody named the community: never a name on the map (the host is shown instead). */
const DEFAULT_COMMUNITY_NAME = 'beanpool community';
/** Our own test and review servers: never a community on the map (the directory function refuses their pushes too). */
const OUR_TEST_HOSTS = ['review.beanpool.org', 'test.beanpool.org', '*.test.beanpool.org'];

function ourTestHost(host) {
    if (!host) return false;
    const h = host.toLowerCase();
    return OUR_TEST_HOSTS.some((entry) => entry.startsWith('*.')
        ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1
        : h === entry);
}

/** A time the directory gave (ms), or null. */
function timeOf(v) {
    if (typeof v !== 'string' || v.length > 64) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
}

/** Whether a row is shown: not one of ours, somewhere to go (an address or a contact), and pushed within 7 days. */
function shownRow(row, now) {
    if (row.host && ourTestHost(row.host)) return false;
    if (!row.url && !row.email && !row.phone) return false;
    if (row.lastSeen !== null && now - row.lastSeen > LISTED_FOR_MS) return false;
    return true;
}

function notAnswering(row, now) {
    return row.lastSeen !== null && now - row.lastSeen > NOT_ANSWERING_AFTER_MS;
}

/** A directory row as the map shows it; anything that isn't what it should be is null or empty. */
function readRow(node) {
    const r = node && typeof node === 'object' ? node : {};
    const sr = r.service_radius && typeof r.service_radius === 'object' ? r.service_radius : {};
    const lat = number(sr.lat) ?? number(r.lat);
    const lng = number(sr.lng) ?? number(r.lng);
    // 0,0 is in the Gulf of Guinea: a default nobody changed, not a community.
    const onEarth = lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
    const radiusKm = number(sr.radiusKm);
    const members = number(r.member_count);
    const url = nodeHref(text(r.node_url));
    const host = url ? new URL(url).hostname : null;
    // The community's own name; the default or none is shown as its host, so two unnamed rows are never one name.
    const own = text(r.community_name);
    const ownName = own && own.toLowerCase() !== DEFAULT_COMMUNITY_NAME ? own : '';
    return {
        name: text(r.shown_name) || ownName || host || own || text(r.callsign) || 'BeanPool community',
        lat: onEarth ? lat : null,
        lng: onEarth ? lng : null,
        radiusKm: radiusKm !== null && radiusKm > 0 && radiusKm <= 20037 ? radiusKm : null,
        memberCount: members !== null && Number.isSafeInteger(members) && members >= 0 ? members : null,
        email: text(r.contact_email),
        phone: text(r.contact_phone),
        url,
        host,
        lastSeen: timeOf(r.last_seen_at) ?? timeOf(r.updated_at),
    };
}

function element(tag, style, content) {
    const el = document.createElement(tag);
    if (style) el.setAttribute('style', style);
    if (content !== undefined) el.textContent = content;
    return el;
}

/** A contact: a link when the value passes its check, else the value as plain text. */
function contact(value, href) {
    if (!href) return document.createTextNode(value);
    // 44px to tap, a box of its own: no margin pulls a neighbour's box over it. A long address breaks anywhere so it fits.
    const a = element('a', 'color:var(--success-ink); text-decoration:none; display:inline-block; position:relative; box-sizing:border-box; min-height:44px; padding:13px 0; line-height:18px; min-width:44px; overflow-wrap:anywhere;', value);
    a.setAttribute('href', href);
    return a;
}

function directoryPopup(row, now = Date.now()) {
    const box = element('div', 'font-family:Inter,sans-serif;');
    box.appendChild(element('strong', null, row.name));
    box.appendChild(element('br'));
    if (notAnswering(row, now)) {
        // Still listed, and still worth a try: the link stays (design §2.3).
        const quiet = element('span', 'color:var(--text-secondary);font-size:0.85em;font-style:italic;', word('notAnswering'));
        quiet.className = 'directory-not-answering';
        box.appendChild(quiet);
        box.appendChild(element('br'));
    }
    const facts = [];
    if (row.memberCount !== null) facts.push(word('members', row.memberCount));
    if (row.radiusKm !== null) facts.push(word('radius', row.radiusKm));
    box.appendChild(element('span', 'color:var(--text-dim);font-size:0.85em;', facts.join(' · ')));
    if (row.email || row.phone) {
        box.appendChild(element('br'));
        const line = element('span', 'font-size:0.85em; color:var(--text-secondary); display:inline-block;');
        if (row.email) line.appendChild(contact(row.email, mailtoHref(row.email)));
        if (row.email && row.phone) line.appendChild(document.createTextNode(' · '));
        if (row.phone) line.appendChild(contact(row.phone, telHref(row.phone)));
        box.appendChild(line);
    }
    if (row.url) {
        box.appendChild(element('br'));
        const visit = element('a', 'color:var(--success-ink); text-decoration:none; font-size:0.85em; display:inline-block; position:relative; box-sizing:border-box; min-height:44px; padding:13px 0; line-height:18px; font-weight:600;', word('visit', new URL(row.url).host));
        visit.setAttribute('href', row.url);
        visit.setAttribute('target', '_blank');
        visit.setAttribute('rel', 'noopener');
        box.appendChild(visit);
    }
    return box;
}

/** A popup fits inside the map and opens below the zoom buttons (they sit over popups), so every link in it can be tapped. */
function popupOptions() {
    const map = document.getElementById('nodes-map');
    const zoom = map ? map.querySelector('.leaflet-control-zoom') : null;
    return {
        maxWidth: Math.max(120, Math.min(300, (map ? map.clientWidth : 320) - 64)),
        autoPanPaddingTopLeft: [5, zoom ? zoom.offsetTop + zoom.offsetHeight + 5 : 5],
    };
}

/**
 * The directory's rows: its view of the rows a stranger is shown (directory_listed), or, while the view is not there yet
 * (the PR that made it merges before the director applies it), the table itself; the same rules are applied to both
 * here (shownRow). Throws when neither answers.
 */
async function readDirectory() {
    const listed = await supabaseClient.from('directory_listed').select('*');
    if (!listed.error) return listed.data;
    const table = await supabaseClient.from('directory_nodes').select('*');
    if (table.error) throw listed.error;
    return table.data;
}

async function pollNodes() {
    if (!supabaseClient) return;

    try {
        const nodes = await readDirectory();
        const now = Date.now();

        directoryLoaded = true;
        totalNodes = 0;
        totalMembers = 0;
        if (markersLayer) markersLayer.clearLayers();

        (Array.isArray(nodes) ? nodes : []).forEach((node) => {
            const row = readRow(node);
            // Only the rows shown are counted: never our test servers, a row that leads nowhere, or one gone quiet.
            if (!shownRow(row, now)) return;
            totalNodes++;
            totalMembers += row.memberCount || 0;
            if (row.lat === null || row.lng === null) return;

            if (markersLayer && nodeIcon) {
                L.marker([row.lat, row.lng], { icon: nodeIcon })
                    .bindPopup(directoryPopup(row, now), popupOptions())
                    .addTo(markersLayer);

                if (row.radiusKm !== null) {
                    L.circle([row.lat, row.lng], {
                        radius: row.radiusKm * 1000,
                        color: '#f59e0b',
                        fillColor: '#f59e0b',
                        fillOpacity: 0.06,
                        weight: 1.5,
                        dashArray: '6 4',
                        interactive: false,
                    }).addTo(markersLayer);
                }
            }
            bounds.push([row.lat, row.lng]);
        });
    } catch (err) {
        console.error('Failed to load directory nodes from Supabase:', err);
    }

    // Update map stats
    const statNodes = document.getElementById('stat-nodes');
    const statMembers = document.getElementById('stat-members');
    if (statNodes) statNodes.textContent = totalNodes || '—';
    if (statMembers) statMembers.textContent = totalMembers || '—';

    // Nothing on the map: "none" with Start a community once the directory answered with no rows; before it ever has
    // (a failed first read), the truth, and no Start.
    const emptyState = document.getElementById('map-empty-state');
    const mapEl = document.getElementById('nodes-map');
    if (totalNodes === 0) {
        if (mapEl) mapEl.style.opacity = '0.5';
        if (emptyState) {
            emptyState.style.display = 'block';
            const textEl = document.getElementById('map-empty-text');
            const startEl = document.getElementById('map-empty-start');
            if (textEl) textEl.textContent = directoryLoaded ? word('noneNear') : word('notLoaded');
            if (startEl) startEl.style.display = directoryLoaded ? '' : 'none';
        }
    } else {
        if (mapEl) mapEl.style.opacity = '1';
        if (emptyState) emptyState.style.display = 'none';
    }
}

// ======================== COPY TO CLIPBOARD ========================
function copyCode(btn) {
    const code = btn.parentElement.querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        }, 2000);
    });
}

// ======================== NEWSLETTER ========================
const newsletterForm = document.getElementById('newsletter-form');
const newsletterStatus = document.getElementById('newsletter-status');

if (newsletterForm && supabaseClient) {
    newsletterForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('newsletter-email').value.trim();
        if (!email) return;

        const btn = newsletterForm.querySelector('button');
        btn.textContent = word('subscribing');
        btn.disabled = true;
        newsletterStatus.textContent = '';
        newsletterStatus.className = 'newsletter-status';

        try {
            // Use Supabase Auth to create a real account — sends confirmation email automatically
            const { data, error } = await supabaseClient.auth.signUp({
                email,
                password: crypto.randomUUID(), // Auto-generate password; user won't need it
                options: {
                    data: { source: 'website_newsletter' },
                    emailRedirectTo: 'https://beanpool.org'
                }
            });

            if (error) {
                if (error.message.includes('already registered')) {
                    newsletterStatus.textContent = word('alreadySubscribed');
                    newsletterStatus.className = 'newsletter-status success';
                } else {
                    throw error;
                }
            } else {
                // Also insert into newsletter_subscribers for easy querying
                await supabaseClient
                    .from('newsletter_subscribers')
                    .insert({ email });

                newsletterStatus.textContent = word('checkInbox');
                newsletterStatus.className = 'newsletter-status success';
                document.getElementById('newsletter-email').value = '';
            }
        } catch (err) {
            console.error('Newsletter signup failed:', err);
            newsletterStatus.textContent = word('somethingWrong');
            newsletterStatus.className = 'newsletter-status error';
        }

        btn.textContent = word('subscribe');
        btn.disabled = false;
    });
}

// ======================== LANGUAGE RECOMMENDATION BANNER ========================
function normaliseBrowserLang(tag) {
    if (!tag || typeof tag !== 'string') return null;
    const lower = tag.toLowerCase().trim();
    if (lower === 'zh-cn' || lower === 'zh-sg' || lower === 'zh-hans') return 'zh-Hans';
    if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower === 'zh-hant') return 'zh-Hant';
    if (lower === 'in' || lower === 'id') return 'id';
    if (lower === 'tl' || lower === 'fil') return 'fil';
    const primary = lower.split(/[-_]/)[0];
    if (primary === 'en') return 'en';
    return GUIDE_LANGS.includes(primary) ? primary : null;
}

function initLanguageBanner() {
    if (pageLang() !== 'en') return;
    if (typeof document === 'undefined' || typeof navigator === 'undefined') return;

    let isDismissed = false;
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            isDismissed = window.localStorage.getItem('beanpool_lang_banner_dismissed') === 'true' ||
                          window.localStorage.getItem('beanpool_lang') !== null;
        }
    } catch (_) {
        // works without storage
    }
    if (isDismissed) return;

    if (document.cookie && /(?:^|;\s*)beanpool_lang=/.test(document.cookie)) return;

    let navLangs = [];
    if (navigator.languages && navigator.languages.length) {
        navLangs = Array.from(navigator.languages);
    }
    if (navigator.language && !navLangs.includes(navigator.language)) {
        navLangs.unshift(navigator.language);
    }

    let matched = null;
    for (const raw of navLangs) {
        matched = normaliseBrowserLang(raw);
        if (matched) break;
    }
    if (!matched || matched === 'en') return;

    // Figure out target page
    const UNTRANSLATED_PAGES = ['privacy', 'terms', 'data-deletion'];
    let p = '';
    if (typeof window !== 'undefined' && window.location && window.location.pathname) {
        const seg = window.location.pathname.split('/').filter(Boolean).pop() || '';
        p = seg.replace(/\.html$/, '');
    }
    if (p === 'index') p = '';
    if (UNTRANSLATED_PAGES.includes(p)) return; // Do not recommend non-existent legal translations

    const langName = LANGUAGE_NAMES[matched] || matched;
    const banner = document.createElement('div');
    banner.className = 'read-in-banner';
    banner.id = 'read-in-banner';

    const t = WORDS[matched] || WORDS.en;
    const link = document.createElement('a');
    link.href = p ? `https://beanpool.org/${matched}/${p}` : `https://beanpool.org/${matched}/`;
    link.lang = matched;
    link.dir = 'auto';
    link.textContent = typeof t.readIn === 'function' ? t.readIn(langName) : `Read this in ${langName} →`;
    link.addEventListener('click', () => {
        const secure = (typeof window !== 'undefined' && window.location.protocol === 'https:') ? ';Secure' : '';
        document.cookie = `beanpool_lang=${matched};path=/;max-age=31536000;SameSite=Lax${secure}`;
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                window.localStorage.setItem('beanpool_lang_banner_dismissed', 'true');
                window.localStorage.setItem('beanpool_lang', matched);
            }
        } catch (_) {
            // works without storage
        }
    });

    const updateBannerHeight = () => {
        if (!banner.isConnected) return;
        const bannerHeight = banner.offsetHeight || 61;
        if (document.documentElement) {
            document.documentElement.style.setProperty('--banner-height', `${bannerHeight}px`);
        }
    };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'read-in-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss language recommendation');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
        const secure = (typeof window !== 'undefined' && window.location.protocol === 'https:') ? ';Secure' : '';
        document.cookie = `beanpool_lang=en;path=/;max-age=31536000;SameSite=Lax${secure}`;
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                window.localStorage.setItem('beanpool_lang_banner_dismissed', 'true');
                window.localStorage.setItem('beanpool_lang', 'en');
            }
        } catch (_) {
            // works without storage
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', updateBannerHeight);
        }
        banner.remove();
        if (document.documentElement) {
            document.documentElement.style.removeProperty('--banner-height');
        }
        if (document.body) {
            document.body.classList.remove('has-read-in-banner');
        }
    });

    banner.appendChild(link);
    banner.appendChild(closeBtn);
    if (document.body) {
        document.body.classList.add('has-read-in-banner');
        document.body.prepend(banner);
        updateBannerHeight();
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', updateBannerHeight);
        }
    }
}

// ======================== SMOOTH SCROLL ========================
document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
        const target = document.querySelector(a.getAttribute('href'));
        if (target) {
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
});

// ======================== PHONE MENU ========================
// The menu is a plain <details>; close it once a link is chosen so it doesn't cover the section.
document.querySelectorAll('.nav-menu a').forEach(a => {
    a.addEventListener('click', () => {
        const menu = a.closest('details');
        if (menu) menu.open = false;
    });
});

// ======================== LANGUAGE SELECTOR ========================
// Keyboard accessibility: Escape closes open language menus and returns focus to the button if focused within.
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const openMenus = document.querySelectorAll('.lang-menu[open]');
        openMenus.forEach(menu => {
            const hadFocus = menu.contains(document.activeElement);
            menu.open = false;
            if (hadFocus) {
                const summary = menu.querySelector('summary');
                if (summary) summary.focus();
            }
        });
    }
});

// Click outside closes open language menus.
document.addEventListener('click', (e) => {
    document.querySelectorAll('.lang-menu[open]').forEach(menu => {
        if (!menu.contains(e.target)) {
            menu.open = false;
        }
    });
});

// Close language menu when a link inside it is clicked.
document.querySelectorAll('.lang-dropdown a').forEach(a => {
    a.addEventListener('click', () => {
        const menu = a.closest('.lang-menu');
        if (menu) menu.open = false;
    });
});

// ======================== NAV SCROLL EFFECT ========================
window.addEventListener('scroll', () => {
    const nav = document.getElementById('navbar');
    if (!nav) return;
    if (window.scrollY > 50) {
        nav.style.background = 'rgba(var(--rgb-nav), 0.95)';
    } else {
        nav.style.background = 'rgba(var(--rgb-nav), 0.85)';
    }
});

// ======================== INIT ========================
if (nodesMap) {
    pollNodes();
    // Re-poll every 5 minutes
    setInterval(pollNodes, 300_000);
}
initLanguageBanner();
