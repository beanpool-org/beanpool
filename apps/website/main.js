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
    }
};

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
    return {
        name: text(r.community_name) || text(r.callsign) || 'BeanPool community',
        lat: onEarth ? lat : null,
        lng: onEarth ? lng : null,
        radiusKm: radiusKm !== null && radiusKm > 0 && radiusKm <= 20037 ? radiusKm : null,
        memberCount: members !== null && Number.isSafeInteger(members) && members >= 0 ? members : null,
        email: text(r.contact_email),
        phone: text(r.contact_phone),
        url: nodeHref(text(r.node_url)),
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

function directoryPopup(row) {
    const box = element('div', 'font-family:Inter,sans-serif;');
    box.appendChild(element('strong', null, row.name));
    box.appendChild(element('br'));
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

async function pollNodes() {
    if (!supabaseClient) return;

    try {
        const { data: nodes, error } = await supabaseClient
            .from('directory_nodes')
            .select('*');

        if (error) throw error;

        directoryLoaded = true;
        totalNodes = 0;
        totalMembers = 0;
        if (markersLayer) markersLayer.clearLayers();

        (Array.isArray(nodes) ? nodes : []).forEach((node) => {
            const row = readRow(node);
            totalNodes++;
            totalMembers += row.memberCount || 0;
            if (row.lat === null || row.lng === null) return;

            if (markersLayer && nodeIcon) {
                L.marker([row.lat, row.lng], { icon: nodeIcon })
                    .bindPopup(directoryPopup(row), popupOptions())
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
    const UNTRANSLATED_PAGES = ['privacy.html', 'terms.html', 'data-deletion.html'];
    let pName = 'index.html';
    if (typeof window !== 'undefined' && window.location && window.location.pathname) {
        const seg = window.location.pathname.split('/').filter(Boolean).pop();
        if (seg && seg.endsWith('.html')) {
            if (UNTRANSLATED_PAGES.includes(seg)) return; // Do not recommend non-existent legal translations
            pName = seg;
        }
    }

    const langName = LANGUAGE_NAMES[matched] || matched;
    const banner = document.createElement('div');
    banner.className = 'read-in-banner';
    banner.id = 'read-in-banner';

    const link = document.createElement('a');
    link.href = `/${matched}/${pName}`;
    link.textContent = word('readIn', langName);
    link.addEventListener('click', () => {
        const secure = (typeof window !== 'undefined' && window.location.protocol === 'https:') ? ';Secure' : '';
        document.cookie = `beanpool_lang=${matched};path=/;max-age=31536000;SameSite=Lax${secure}`;
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
