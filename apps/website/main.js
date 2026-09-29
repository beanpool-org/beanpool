/**
 * BeanPool.org — Live Node Directory, Interactive Map, Newsletter & Utilities
 * 
 * Polls known BeanPool node endpoints for directory info,
 * then displays them as markers on a Leaflet map with radius circles.
 */

const SUPABASE_URL = 'https://dpemwoermzkaxoctafzg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fmlYuaf6NCkTI2IwWnvZmw_bOzo-PrF';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ======================== MAP INIT ========================
const nodesMap = L.map('nodes-map', {
    center: [20, 0],
    zoom: 2,
    zoomControl: true,
    attributionControl: false,
    scrollWheelZoom: false,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OSM',
}).addTo(nodesMap);

L.control.attribution({ position: 'bottomright', prefix: false })
    .addAttribution('© <a href="https://openstreetmap.org">OSM</a>')
    .addTo(nodesMap);

// ======================== NODE POLLING ========================
const nodeIcon = L.divIcon({
    html: '<div class="map-pulse-marker"><div class="map-pulse-core"></div><div class="map-pulse-glow"></div></div>',
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
});

let totalMembers = 0;
let totalNodes = 0;
const bounds = [];
const markersLayer = L.layerGroup().addTo(nodesMap);

// ======================== DIRECTORY ROWS ========================
// Every field of a directory row is what some community published, and anyone who runs a node can publish one. This is
// also the site the registrar's admin page is on, so markup in a row would be script here. A popup is built from DOM
// nodes, each value put in as text; a link is made only from an email or a phone number that passes the check for its
// kind, and only as mailto: or tel:. A number that isn't one is left out, so Leaflet never throws on a row.

const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PHONE = /^\+?[0-9 ().-]{3,32}$/;

function mailtoHref(email) {
    return email.length <= 254 && EMAIL.test(email) ? `mailto:${email}` : null;
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
    const a = element('a', 'color:#10b981; text-decoration:none;', value);
    a.setAttribute('href', href);
    return a;
}

function directoryPopup(row) {
    const box = element('div', 'font-family:Inter,sans-serif;');
    box.appendChild(element('strong', null, row.name));
    box.appendChild(element('br'));
    const facts = [];
    if (row.memberCount !== null) facts.push(`${row.memberCount} members`);
    if (row.radiusKm !== null) facts.push(`${row.radiusKm}km radius`);
    box.appendChild(element('span', 'color:#94a3b8;font-size:0.85em;', facts.join(' · ')));
    if (row.email || row.phone) {
        box.appendChild(element('br'));
        const line = element('span', 'font-size:0.85em; color:#cbd5e1; display:inline-block; margin-top:4px;');
        if (row.email) line.appendChild(contact(row.email, mailtoHref(row.email)));
        if (row.email && row.phone) line.appendChild(document.createTextNode(' · '));
        if (row.phone) line.appendChild(contact(row.phone, telHref(row.phone)));
        box.appendChild(line);
    }
    return box;
}

async function pollNodes() {

    try {
        const { data: nodes, error } = await supabaseClient
            .from('directory_nodes')
            .select('*');

        if (error) throw error;

        totalNodes = 0;
        totalMembers = 0;
        markersLayer.clearLayers();

        (Array.isArray(nodes) ? nodes : []).forEach((node) => {
            const row = readRow(node);
            totalNodes++;
            totalMembers += row.memberCount || 0;
            if (row.lat === null || row.lng === null) return;

            L.marker([row.lat, row.lng], { icon: nodeIcon })
                .bindPopup(directoryPopup(row))
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
            bounds.push([row.lat, row.lng]);
        });
    } catch (err) {
        console.error('Failed to load directory nodes from Supabase:', err);
    }

    // Update map stats
    document.getElementById('stat-nodes').textContent = totalNodes || '—';
    document.getElementById('stat-members').textContent = totalMembers || '—';

    if (totalNodes === 0) {
        document.getElementById('nodes-map').style.opacity = '0.5';
    } else {
        document.getElementById('nodes-map').style.opacity = '1';
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

if (newsletterForm) {
    newsletterForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('newsletter-email').value.trim();
        if (!email) return;

        const btn = newsletterForm.querySelector('button');
        btn.textContent = 'Subscribing...';
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
                    newsletterStatus.textContent = "You're already subscribed! 🫘";
                    newsletterStatus.className = 'newsletter-status success';
                } else {
                    throw error;
                }
            } else {
                // Also insert into newsletter_subscribers for easy querying
                await supabaseClient
                    .from('newsletter_subscribers')
                    .insert({ email });

                newsletterStatus.textContent = 'Check your inbox for a confirmation email! 🫘';
                newsletterStatus.className = 'newsletter-status success';
                document.getElementById('newsletter-email').value = '';
            }
        } catch (err) {
            console.error('Newsletter signup failed:', err);
            newsletterStatus.textContent = 'Something went wrong. Please try again.';
            newsletterStatus.className = 'newsletter-status error';
        }

        btn.textContent = 'Subscribe';
        btn.disabled = false;
    });
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
    if (window.scrollY > 50) {
        nav.style.background = 'rgba(5, 10, 20, 0.95)';
    } else {
        nav.style.background = 'rgba(5, 10, 20, 0.85)';
    }
});

// ======================== INIT ========================
pollNodes();
// Re-poll every 5 minutes
setInterval(pollNodes, 300_000);

