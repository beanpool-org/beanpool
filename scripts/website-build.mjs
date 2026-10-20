/**
 * Website localization builder and CI verifier (translation slice S6; scratch/global-node/DESIGN-translation-fable.md §4, §7).
 *
 * Source of truth:
 * - English pages live in apps/website/<page>.html.
 * - Per-language pages live under apps/website/content/<lang>/<page>.html, each carrying `<!-- source-hash: <16-hex> -->`
 *   which records the content hash of the English page it was drafted from.
 * - Generated per-language pages are written to apps/website/<lang>/<page>.html. They are never hand-edited.
 *
 * Features:
 * - <html lang="..."> on every page.
 * - <link rel="alternate" hreflang="..."> for all 25 variants + x-default (26 tags total).
 * - Language row in the footer with all 25 languages in their own native names.
 * - RTL direction (`dir="rtl"` on <body>) for Arabic, Persian and Urdu.
 * - Outdated translation detection ("This page is newer in English." banner linking to English).
 * - Legal pages banner mechanism ("This is a translation to help you read it. The English version, dated <date>, is the one that applies.")
 *   with no legal translations shipped in this slice.
 * - Relative link rewrites: links to translated pages remain in <lang>/, links to untranslated pages (like legal) link to English.
 * - Asset path rewrites: relative paths (style.css, bean.png, fonts/, main.js) adjust for <lang>/ subdirectories.
 *
 * Modes:
 *   node scripts/website-build.mjs            Builds all pages from content/ into apps/website/<lang>/
 *   node scripts/website-build.mjs --check    Verifies generated files match build output and check rules
 *   node scripts/website-build.mjs --draft <lang>  Prepares/refreshes content/<lang>/ from current English
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'apps', 'website');
const CONTENT_DIR = path.join(WEBSITE_DIR, 'content');

export const GUIDE_LANGS = Object.freeze([
    'es', 'pt', 'hi', 'bn', 'fr', 'ar', 'id', 'ru',
    'zh-Hans', 'zh-Hant', 'it', 'de', 'tr', 'sw', 'ml', 'ta',
    'uk', 'ur', 'fa', 'vi', 'el', 'fil', 'ja', 'ko'
]);

export const LANGS = Object.freeze(['en', ...GUIDE_LANGS]);

export const RTL_LANGS = Object.freeze(['ar', 'fa', 'ur']);

export const LANGUAGE_NAMES = Object.freeze({
    en: 'English', es: 'Español', pt: 'Português', hi: 'हिन्दी', bn: 'বাংলা', fr: 'Français', ar: 'العربية',
    id: 'Bahasa Indonesia', ru: 'Русский', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', it: 'Italiano', de: 'Deutsch',
    tr: 'Türkçe', sw: 'Kiswahili', ml: 'മലയാളം', ta: 'தமிழ்', uk: 'Українська', ur: 'اردو', fa: 'فارسی',
    vi: 'Tiếng Việt', el: 'Ελληνικά', fil: 'Filipino', ja: '日本語', ko: '한국어',
});

/** Top-level pages published on the website that have translated versions. */
export const TRANSLATED_PAGES = Object.freeze([
    'index.html',
    'getting-started.html',
    'global.html',
    'help.html',
    'post-extraction.html',
    'rules.html',
    'safety.html',
    'status.html'
]);

/** Legal pages on the website: banner mechanism built, but translations deferred until lawyer's text is final. */
export const LEGAL_PAGES = Object.freeze([
    'privacy.html',
    'terms.html',
    'data-deletion.html'
]);

export const ALL_PAGES = Object.freeze([...TRANSLATED_PAGES, ...LEGAL_PAGES]);

/** Stale translation notice words per language. */
export const STALE_WORDS = Object.freeze({
    en: { note: 'This page is newer in English.', link: 'Read the current English version →' },
    es: { note: 'Esta página es más reciente en inglés.', link: 'Leer la versión actual en inglés →' },
    pt: { note: 'Esta página é mais recente em inglês.', link: 'Ler a versão atual em inglês →' },
    hi: { note: 'यह पृष्ठ अंग्रेज़ी में नया है।', link: 'वर्तमान अंग्रेज़ी संस्करण पढ़ें →' },
    bn: { note: 'এই পৃষ্ঠাটি ইংরেজিতে আরও নতুন।', link: 'বর্তমান ইংরেজি সংস্করণ পড়ুন →' },
    fr: { note: 'Cette page est plus récente en anglais.', link: 'Lire la version anglaise actuelle →' },
    ar: { note: 'هذه الصفحة أحدث باللغة الإنجليزية.', link: 'اقرأ النسخة الإنجليزية الحالية ←' },
    id: { note: 'Halaman ini lebih baru dalam bahasa Inggris.', link: 'Baca versi bahasa Inggris saat ini →' },
    ru: { note: 'Эта страница новее на английском языке.', link: 'Читать актуальную версию на английском →' },
    'zh-Hans': { note: '此页面的英文版本较新。', link: '阅读当前英文版本 →' },
    'zh-Hant': { note: '此頁面的英文版本較新。', link: '閱讀當前英文版本 →' },
    it: { note: 'Questa pagina è più recente in inglese.', link: 'Leggi la versione inglese attuale →' },
    de: { note: 'Diese Seite ist auf Englisch neuer.', link: 'Aktuelle englische Version lesen →' },
    tr: { note: 'Bu sayfa İngilizce olarak daha günceldir.', link: 'Güncel İngilizce sürümü okuyun →' },
    sw: { note: 'Ukurasa huu ni mpya zaidi kwa Kiingereza.', link: 'Soma toleo la sasa la Kiingereza →' },
    ml: { note: 'ഈ പേജ് ഇംഗ്ലീഷിൽ പുതിയതാണ്.', link: 'നിലവിലെ ഇംഗ്ലീഷ് പതിപ്പ് വായിക്കുക →' },
    ta: { note: 'இந்தப் பக்கம் ஆங்கிலத்தில் புதியது.', link: 'தற்போதைய ஆங்கிலப் பதிப்பைப் படிக்கவும் →' },
    uk: { note: 'Ця сторінка новіша англійською мовою.', link: 'Читати актуальну версію англійською →' },
    ur: { note: 'یہ صفحہ انگریزی میں نیا ہے۔', link: 'موجودہ انگریزی ورژن پڑھیں ←' },
    fa: { note: 'این صفحه در زبان انگلیسی جدیدتر است.', link: 'نسخه فعلی انگلیسی را بخوانید ←' },
    vi: { note: 'Trang này bằng tiếng Anh mới hơn.', link: 'Đọc phiên bản tiếng Anh hiện tại →' },
    el: { note: 'Αυτή η σελίδα είναι νεότερη στα αγγλικά.', link: 'Διαβάστε την τρέχουσα αγγλική έκδοση →' },
    fil: { note: 'Mas bago ang pahinang ito sa Ingles.', link: 'Basahin ang kasalukuyang bersyon sa Ingles →' },
    ja: { note: 'このページは英語版の方が新しいです。', link: '現在の英語版を読む →' },
    ko: { note: '이 페이지는 영어로 된 최신 버전이 있습니다.', link: '현재 영어 버전 읽기 →' },
});

/** Legal banner words per language: "This is a translation to help you read it. The English version, dated <date>, is the one that applies." */
export const LEGAL_BANNER_WORDS = Object.freeze({
    en: (date) => `This is a translation to help you read it. The English version, dated ${date}, is the one that applies.`,
    es: (date) => `Esta es una traducción para ayudarle a leerla. La versión en inglés, con fecha del ${date}, es la que se aplica.`,
    pt: (date) => `Esta é uma tradução para ajudá-lo a lê-la. A versão em inglês, datada de ${date}, é a que se aplica.`,
    hi: (date) => `यह पढ़ने में सहायता के लिए एक अनुवाद है। ${date} दिनांकित अंग्रेज़ी संस्करण ही लागू होगा।`,
    bn: (date) => `এটি পড়ার সুবিধার্থে একটি অনুবাদ। ${date} তারিখের ইংরেজি সংস্করণটিই কার্যকর হবে।`,
    fr: (date) => `Ceci est une traduction pour vous aider à la lire. La version anglaise, en date du ${date}, est celle qui s'applique.`,
    ar: (date) => `هذه ترجمة لمساعدتك على قراءتها. النسخة الإنجليزية المؤرخة في ${date} هي المعتمدة.`,
    id: (date) => `Ini adalah terjemahan untuk membantu Anda membacanya. Versi bahasa Inggris, tertanggal ${date}, adalah versi yang berlaku.`,
    ru: (date) => `Это перевод для вашего удобства. Действительной является версия на английском языке от ${date}.`,
    'zh-Hans': (date) => `此翻译仅供阅读参考。以日期为 ${date} 的英文版本为准。`,
    'zh-Hant': (date) => `此翻譯僅供閱讀參考。以日期為 ${date} 的英文版本為準。`,
    it: (date) => `Questa è una traduzione per facilitarne la lettura. La versione in inglese, datata ${date}, è quella applicabile.`,
    de: (date) => `Dies ist eine Übersetzung als Lesehilfe. Die englische Fassung vom ${date} ist maßgebend.`,
    tr: (date) => `Bu, okumanıza yardımcı olmak için yapılan bir çeviridir. ${date} tarihli İngilizce sürüm geçerli olan sürümdür.`,
    sw: (date) => `Huu ni tafsiri ya kukusaidia kusoma. Toleo la Kiingereza, la tarehe ${date}, ndilo linalotumika.`,
    ml: (date) => `ഇത് വായിക്കാൻ സഹായിക്കുന്നതിനുള്ള ഒരു വിവർത്തനമാണ്. ${date} തീയതിയിലുള്ള ഇംഗ്ലീഷ് പതിപ്പാണ് ബാധകം.`,
    ta: (date) => `இது உங்களுக்கு வாசிக்க உதவும் மொழிபெயர்ப்பு. ${date} தேதியிட்ட ஆங்கிலப் பதிப்பே செல்லுபடியாகும்.`,
    uk: (date) => `Це переклад для полегшення читання. Дійсною є версія англійською мовою від ${date}.`,
    ur: (date) => `یہ آپ کو پڑھنے میں مدد کے لیے ترجمہ ہے۔ ${date} کی انگریزی ورژن ہی لاگو ہوگی۔`,
    fa: (date) => `این ترجمه برای سهولت در خواندن است. نسخه انگلیسی، مورخ ${date}، نسخه معتبر می‌باشد.`,
    vi: (date) => `Bản dịch này nhằm giúp bạn đọc dễ dàng hơn. Bản tiếng Anh, ghi ngày ${date}, là bản áp dụng chính thức.`,
    el: (date) => `Αυτή είναι μια μετάφραση για να σας βοηθήσει στην ανάγνωση. Η αγγλική έκδοση, με ημερομηνία ${date}, είναι αυτή που ισχύει.`,
    fil: (date) => `Ito ay isang salin upang matulungan kang basahin ito. Ang bersyong Ingles, na may petsang ${date}, ang siyang may bisa.`,
    ja: (date) => `これは読解を支援するための翻訳です。適用されるのは ${date} 付の英語版です。`,
    ko: (date) => `이 문서는 이해를 돕기 위한 번역본입니다. 적용되는 공식 문서는 ${date}자 영문본입니다.`,
});

/**
 * Computes canonical content hash of English HTML (sha256, first 16 hex digits).
 * Ignores dynamic frame elements (hreflang alternate tags, footer languages row, comments, whitespace).
 */
export function pageContentHash(html) {
    const canonical = html
        .replace(/<link\s+rel="alternate"\s+hreflang="[^"]*"\s+href="[^"]*"\s*\/?>/gi, '')
        .replace(/<div\s+class="footer-languages"[\s\S]*?<\/div>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** Extracts source-hash from translation source file content. */
export function extractSourceHash(content) {
    const match = content.match(/<!--\s*source-hash:\s*([0-9a-f]{16})\s*-->/i);
    return match ? match[1] : null;
}

/** Builds hreflang alternate tags for a given page. For untranslated legal pages, only en and x-default are emitted. */
export function buildHreflangTags(page) {
    const isStatus = page === 'status.html';
    const isLegal = LEGAL_PAGES.includes(page);

    if (isLegal) {
        return [
            `    <link rel="alternate" hreflang="en" href="https://beanpool.org/${page}">`,
            `    <link rel="alternate" hreflang="x-default" href="https://beanpool.org/${page}">`
        ].join('\n');
    }

    const lines = [];
    for (const lang of LANGS) {
        let href;
        if (isStatus) {
            href = lang === 'en' ? '/status.html' : `/${lang}/status.html`;
        } else {
            href = lang === 'en' ? `https://beanpool.org/${page}` : `https://beanpool.org/${lang}/${page}`;
        }
        lines.push(`    <link rel="alternate" hreflang="${lang}" href="${href}">`);
    }

    const defaultHref = isStatus ? '/status.html' : `https://beanpool.org/${page}`;
    lines.push(`    <link rel="alternate" hreflang="x-default" href="${defaultHref}">`);

    return lines.join('\n');
}

/** Builds the footer language row with all 25 languages in their own names. */
export function buildFooterLanguagesRow(page, currentLang) {
    const isLegal = LEGAL_PAGES.includes(page);
    const links = LANGS.map((lang) => {
        const isCurrent = lang === currentLang;
        let href;
        if (currentLang === 'en') {
            if (isLegal && lang !== 'en') {
                // On a legal page, each language link goes to that language's HOME page (/es/)
                href = `/${lang}/`;
            } else {
                href = lang === 'en' ? page : `${lang}/${page}`;
            }
        } else {
            if (isLegal && lang !== 'en') {
                href = `/${lang}/`;
            } else if (lang === 'en') {
                href = `../${page}`;
            } else if (lang === currentLang) {
                href = page;
            } else {
                href = `../${lang}/${page}`;
            }
        }
        const currentAttr = isCurrent ? ' aria-current="page"' : '';
        return `                    <a href="${href}" hreflang="${lang}" lang="${lang}"${currentAttr}>${LANGUAGE_NAMES[lang]}</a>`;
    });

    return [
        '            <div class="footer-languages">',
        ...links,
        '            </div>'
    ].join('\n');
}

/** Extracts the "Last Updated: <date>" string from a legal page. */
export function extractLegalDate(html) {
    const match = html.match(/Last Updated:\s*([^<]+)<\/strong>/i) ||
                  html.match(/Last Updated:\s*([A-Za-z0-9, ]+)/i);
    return match ? match[1].trim() : 'October 15, 2026';
}

export const PAGES_WITH_MAIN_JS = Object.freeze([
    'index.html',
    'getting-started.html',
    'help.html',
    'post-extraction.html',
    'rules.html',
    'safety.html',
    'privacy.html',
    'terms.html',
    'data-deletion.html'
]);

/**
 * Injects hreflang tags and the footer language row into an English page.
 * Also ensures script loading and lang="en" on <html>.
 */
export function formatEnglishPage(page, html) {
    let out = html.replace(/\r\n/g, '\n');

    // 1. Ensure <html lang="en">
    out = out.replace(/<html(?:\s+lang="[^"]*")?/i, '<html lang="en"');

    // 2. Insert or replace hreflang tags inside <head>
    const hreflangBlock = buildHreflangTags(page);
    out = out.replace(/(\s*<link\s+rel="alternate"\s+hreflang="[^"]*"\s+href="[^"]*"\s*\/?>)+/gi, '');
    out = out.replace(/<\/head>/i, `${hreflangBlock}\n</head>`);

    // 3. Insert or replace footer languages row inside <footer>
    if (out.includes('<footer>')) {
        out = out.replace(/\s*<div\s+class="footer-languages"[\s\S]*?<\/div>/gi, '');
        const footerRow = buildFooterLanguagesRow(page, 'en');
        out = out.replace(/<\/div>\s*<div class="footer-bottom">/i, `</div>\n${footerRow}\n            <div class="footer-bottom">`);
    }

    // 4. Ensure main.js is loaded on pages with navigation (NOT global.html or status.html which have single-script / strict CSP invariants)
    if (PAGES_WITH_MAIN_JS.includes(page) && !out.includes('main.js')) {
        out = out.replace(/<\/body>/i, '    <script src="main.js"></script>\n</body>');
    }

    return out;
}

/**
 * Builds a translated page HTML from its content/ source, comparing against English.
 */
export function renderTranslatedPage(lang, page, sourceContent, englishHtml) {
    let out = sourceContent.replace(/\r\n/g, '\n');

    // 1. Remove the source-hash comment from the top of the body
    const sourceHash = extractSourceHash(out);
    out = out.replace(/<!--\s*source-hash:\s*[0-9a-f]{16}\s*-->\s*/i, '');

    const isRtl = RTL_LANGS.includes(lang);
    const isLegal = LEGAL_PAGES.includes(page);
    const enContentHash = pageContentHash(englishHtml);
    const isBehind = sourceHash && sourceHash !== enContentHash;

    // 2. Set <html lang="..."> and dir="rtl" for RTL languages
    out = out.replace(/<html(?:\s+[^>]*)?>/i, isRtl ? `<html lang="${lang}" dir="rtl">` : `<html lang="${lang}">`);
    if (isRtl) {
        out = out.replace(/<body(?:\s+[^>]*)?>/i, (m) => m.includes('dir=') ? m : m.replace('<body', '<body dir="rtl"'));
    } else {
        out = out.replace(/<body\s+dir="rtl"/i, '<body');
    }

    // 3. Rewrite relative asset paths
    // style.css, favicon.png, bean.png, fonts/, main.js, assets/
    out = out.replace(/\bhref="style\.css(\?v=[^"]*)?"/g, 'href="../style.css$1"');
    out = out.replace(/\bhref="favicon\.png"/g, 'href="../favicon.png"');
    out = out.replace(/\bsrc="bean\.png"/g, 'src="../bean.png"');
    out = out.replace(/\bhref="fonts\//g, 'href="../fonts/');
    out = out.replace(/\bsrc="main\.js(\?v=[^"]*)?"/g, 'src="../main.js$1"');
    out = out.replace(/\bsrc="assets\//g, 'src="../assets/');
    out = out.replace(/\bhref="guide\//g, 'href="../guide/');

    // 4. Rewrite internal page links:
    // For translated pages, links like href="getting-started.html" stay href="getting-started.html".
    // For legal pages (which are untranslated), links like href="privacy.html" become href="../privacy.html".
    for (const legalPage of LEGAL_PAGES) {
        const re = new RegExp(`\\bhref="${legalPage}(#[^"]*)?"`, 'g');
        out = out.replace(re, `href="../${legalPage}$1"`);
    }

    // Rewrite any links that point to the English root for pages that are translated
    // e.g. href="../rules.html" inside a translated page should be href="rules.html"
    for (const trPage of TRANSLATED_PAGES) {
        const re = new RegExp(`\\bhref="\\.\\./${trPage}(#[^"]*)?"`, 'g');
        out = out.replace(re, `href="${trPage}$1"`);
    }

    // 5. Insert hreflang tags
    const hreflangBlock = buildHreflangTags(page);
    out = out.replace(/(\s*<link\s+rel="alternate"\s+hreflang="[^"]*"\s+href="[^"]*"\s*\/?>)+/gi, '');
    out = out.replace(/<\/head>/i, `${hreflangBlock}\n</head>`);

    // 6. Insert footer language row
    if (out.includes('<footer>')) {
        out = out.replace(/\s*<div\s+class="footer-languages"[\s\S]*?<\/div>/gi, '');
        const footerRow = buildFooterLanguagesRow(page, lang);
        out = out.replace(/<\/div>\s*<div class="footer-bottom">/i, `</div>\n${footerRow}\n            <div class="footer-bottom">`);
    }

    // 7. Inject banner if stale ("newer in English") or if legal page
    out = out.replace(/\s*<div\s+class="website-stale-banner"[\s\S]*?<\/div>/gi, '');
    out = out.replace(/\s*<div\s+class="website-legal-banner"[\s\S]*?<\/div>/gi, '');

    const enHref = `../${page}`;

    if (isBehind) {
        const words = STALE_WORDS[lang] || STALE_WORDS.en;
        const banner = `    <div class="website-stale-banner"><p>${words.note} <a href="${enHref}">${words.link}</a></p></div>`;
        if (out.includes('<main')) {
            out = out.replace(/(<main\b[^>]*>)/i, `$1\n${banner}`);
        } else if (out.includes('</nav>')) {
            out = out.replace(/(<\/nav>)/i, `$1\n${banner}`);
        } else {
            out = out.replace(/(<body\b[^>]*>)/i, `$1\n${banner}`);
        }
    } else if (isLegal) {
        const date = extractLegalDate(englishHtml);
        const bannerFn = LEGAL_BANNER_WORDS[lang] || LEGAL_BANNER_WORDS.en;
        const bannerText = bannerFn(date);
        const banner = `    <div class="website-legal-banner"><p>${bannerText} <a href="${enHref}">English (${date})</a></p></div>`;
        if (out.includes('<main')) {
            out = out.replace(/(<main\b[^>]*>)/i, `$1\n${banner}`);
        } else if (out.includes('</nav>')) {
            out = out.replace(/(<\/nav>)/i, `$1\n${banner}`);
        } else {
            out = out.replace(/(<body\b[^>]*>)/i, `$1\n${banner}`);
        }
    }

    // 8. Ensure main.js is loaded on pages with navigation (except global.html and status.html)
    if (PAGES_WITH_MAIN_JS.includes(page) && !out.includes('main.js')) {
        out = out.replace(/<\/body>/i, '    <script src="../main.js"></script>\n</body>');
    }

    return out;
}

/** Prepares / drafts a language source under content/<lang>/. */
export function draftLanguage(lang) {
    if (!GUIDE_LANGS.includes(lang)) {
        throw new Error(`unknown language "${lang}"; must be one of ${GUIDE_LANGS.join(', ')}`);
    }

    const langDir = path.join(CONTENT_DIR, lang);
    fs.mkdirSync(langDir, { recursive: true });

    for (const page of TRANSLATED_PAGES) {
        const enPath = path.join(WEBSITE_DIR, page);
        if (!fs.existsSync(enPath)) continue;
        const enHtml = fs.readFileSync(enPath, 'utf8');
        const hash = pageContentHash(enHtml);
        const destPath = path.join(langDir, page);

        let contentToWrite;
        if (fs.existsSync(destPath)) {
            // Update source-hash header if already exists
            const existing = fs.readFileSync(destPath, 'utf8');
            if (extractSourceHash(existing)) {
                contentToWrite = existing.replace(/<!--\s*source-hash:\s*[0-9a-f]{16}\s*-->/i, `<!-- source-hash: ${hash} -->`);
            } else {
                contentToWrite = `<!-- source-hash: ${hash} -->\n${existing}`;
            }
        } else {
            // Fresh draft initialized from English
            contentToWrite = `<!-- source-hash: ${hash} -->\n${enHtml}`;
        }
        fs.writeFileSync(destPath, contentToWrite, 'utf8');
    }
}

/** Builds all website pages from English sources and content/ per-language files. */
export function buildAll() {
    // 1. Update English pages
    for (const page of ALL_PAGES) {
        const enPath = path.join(WEBSITE_DIR, page);
        if (!fs.existsSync(enPath)) continue;
        const raw = fs.readFileSync(enPath, 'utf8');
        const formatted = formatEnglishPage(page, raw);
        if (formatted !== raw) {
            fs.writeFileSync(enPath, formatted, 'utf8');
        }
    }

    // 2. Build per-language pages
    for (const lang of GUIDE_LANGS) {
        const contentLangDir = path.join(CONTENT_DIR, lang);
        if (!fs.existsSync(contentLangDir)) continue;

        const targetLangDir = path.join(WEBSITE_DIR, lang);
        fs.mkdirSync(targetLangDir, { recursive: true });

        for (const file of fs.readdirSync(contentLangDir)) {
            if (!file.endsWith('.html')) continue;
            const srcPath = path.join(contentLangDir, file);
            const enPath = path.join(WEBSITE_DIR, file);
            if (!fs.existsSync(enPath)) continue;

            const srcContent = fs.readFileSync(srcPath, 'utf8');
            const enHtml = fs.readFileSync(enPath, 'utf8');
            const rendered = renderTranslatedPage(lang, file, srcContent, enHtml);
            const targetPath = path.join(targetLangDir, file);
            fs.writeFileSync(targetPath, rendered, 'utf8');
        }
    }
}

/**
 * CI check:
 * - Every generated page matches renderTranslatedPage output bit-for-bit.
 * - Every generated page has lang attribute on <html>.
 * - Every generated page has 26 hreflang tags.
 * - Every generated page has the footer languages row.
 * - RTL languages (ar, fa, ur) have dir="rtl" on <body>.
 * - No English-only link where a translated page exists.
 * - Legal pages have banner mechanism, no legal translations shipped.
 */
export function checkWebsite() {
    const errors = [];

    // Check English pages
    for (const page of ALL_PAGES) {
        const enPath = path.join(WEBSITE_DIR, page);
        if (!fs.existsSync(enPath)) {
            errors.push(`missing English page: apps/website/${page}`);
            continue;
        }
        const current = fs.readFileSync(enPath, 'utf8');
        const expected = formatEnglishPage(page, current);
        if (current !== expected) {
            errors.push(`apps/website/${page} is out of sync with formatting; run 'node scripts/website-build.mjs'`);
        }
    }

    // Check translated pages
    for (const lang of GUIDE_LANGS) {
        const contentLangDir = path.join(CONTENT_DIR, lang);
        if (!fs.existsSync(contentLangDir)) {
            errors.push(`missing content source folder for language: apps/website/content/${lang}`);
            continue;
        }

        const targetLangDir = path.join(WEBSITE_DIR, lang);
        if (!fs.existsSync(targetLangDir)) {
            errors.push(`missing generated folder for language: apps/website/${lang}`);
            continue;
        }

        const isRtl = RTL_LANGS.includes(lang);

        for (const page of TRANSLATED_PAGES) {
            const srcPath = path.join(contentLangDir, page);
            if (!fs.existsSync(srcPath)) {
                errors.push(`missing source file: apps/website/content/${lang}/${page}`);
                continue;
            }

            const genPath = path.join(targetLangDir, page);
            if (!fs.existsSync(genPath)) {
                errors.push(`missing generated page: apps/website/${lang}/${page}`);
                continue;
            }

            const enPath = path.join(WEBSITE_DIR, page);
            const srcContent = fs.readFileSync(srcPath, 'utf8');
            const enHtml = fs.readFileSync(enPath, 'utf8');
            const expectedHtml = renderTranslatedPage(lang, page, srcContent, enHtml);
            const actualHtml = fs.readFileSync(genPath, 'utf8');

            if (actualHtml !== expectedHtml) {
                errors.push(`apps/website/${lang}/${page} is out of sync with content/; run 'node scripts/website-build.mjs'`);
            }

            // Verify <html lang="...">
            const langMatch = actualHtml.match(/<html[^>]*\blang="([^"]*)"/i);
            if (!langMatch || langMatch[1] !== lang) {
                errors.push(`apps/website/${lang}/${page} expected <html lang="${lang}">, got ${langMatch ? langMatch[0] : 'none'}`);
            }

            // Verify 26 hreflang tags
            const hreflangTags = [...actualHtml.matchAll(/<link\s+rel="alternate"\s+hreflang="([^"]*)"\s+href="([^"]*)"/gi)];
            if (hreflangTags.length !== 26) {
                errors.push(`apps/website/${lang}/${page} expected 26 hreflang tags (25 languages + x-default), got ${hreflangTags.length}`);
            }

            // Verify footer languages row (if page has footer)
            if (actualHtml.includes('<footer>') && !actualHtml.includes('class="footer-languages"')) {
                errors.push(`apps/website/${lang}/${page} missing footer languages row`);
            }

            // Verify RTL direction
            if (isRtl) {
                const bodyRtl = actualHtml.match(/<body[^>]*\bdir="rtl"/i);
                if (!bodyRtl) {
                    errors.push(`apps/website/${lang}/${page} is RTL language (${lang}) but <body> lacks dir="rtl"`);
                }
            }

            // Verify no English-only link where a translated page exists
            for (const trPage of TRANSLATED_PAGES) {
                if (trPage === page) continue;
                // Looking for links like href="../trPage" or href="/trPage" where trPage exists in this lang
                if (new RegExp(`href=["'](?:\\.\\./|/)${trPage}["']`, 'i').test(actualHtml)) {
                    errors.push(`apps/website/${lang}/${page} has English-only link to ${trPage} which exists translated`);
                }
            }
        }

        // Verify NO legal pages exist under content/<lang> or apps/website/<lang>
        for (const legalPage of LEGAL_PAGES) {
            if (fs.existsSync(path.join(contentLangDir, legalPage))) {
                errors.push(`legal translation ${legalPage} must NOT be shipped in slice S6`);
            }
            if (fs.existsSync(path.join(targetLangDir, legalPage))) {
                errors.push(`generated legal translation apps/website/${lang}/${legalPage} must NOT exist in slice S6`);
            }
        }
    }

    return errors;
}

// ── CLI Execution ─────────────────────────────────────────────────────────────
if (process.argv[1] === __filename) {
    const args = process.argv.slice(2);
    if (args.includes('--check')) {
        const errors = checkWebsite();
        if (errors.length > 0) {
            console.error('Website translation check failed:');
            for (const err of errors) console.error(`  ✗ ${err}`);
            process.exit(1);
        }
        console.log('✓ Website translation check passed.');
        process.exit(0);
    } else if (args[0] === '--draft') {
        const lang = args[1];
        if (!lang) {
            console.error('Usage: node scripts/website-build.mjs --draft <lang>');
            process.exit(1);
        }
        draftLanguage(lang);
        console.log(`✓ Drafted content for ${lang}.`);
        process.exit(0);
    } else {
        buildAll();
        console.log('✓ Built website pages in all languages.');
    }
}
