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

async function pollNodes() {

    try {
        const { data: nodes, error } = await supabaseClient
            .from('directory_nodes')
            .select('*');
            
        if (error) throw error;
        
        totalNodes = 0;
        totalMembers = 0;
        markersLayer.clearLayers();

        nodes.forEach((node) => {
            totalNodes++;
            totalMembers += node.member_count || 0;
            
            // Map db fields to expected format
            const radiusKm = node.service_radius?.radiusKm || 0;
            const lat = node.service_radius?.lat || node.lat;
            const lng = node.service_radius?.lng || node.lng;
            const name = node.community_name || node.callsign;
            const url = node.node_url || '#';

            let contactHtml = '';
            if (node.contact_email || node.contact_phone) {
                const parts = [];
                if (node.contact_email) parts.push(`<a href="mailto:${node.contact_email}" style="color:#10b981; text-decoration:none;">${node.contact_email}</a>`);
                if (node.contact_phone) parts.push(`<a href="tel:${node.contact_phone}" style="color:#10b981; text-decoration:none;">${node.contact_phone}</a>`);
                contactHtml = `<br><span style="font-size:0.85em; color:#cbd5e1; display:inline-block; margin-top:4px;">${parts.join(' &middot; ')}</span>`;
            }

            // Add marker
            if (lat && lng) {
                if (radiusKm > 0) {
                    L.marker([lat, lng], { icon: nodeIcon })
                        .bindPopup(`
                            <div style="font-family:Inter,sans-serif;">
                                <strong>${name}</strong><br>
                                <span style="color:#94a3b8;font-size:0.85em;">${node.member_count} members &middot; ${radiusKm}km radius</span>
                                ${contactHtml}
                            </div>
                        `)
                        .addTo(markersLayer);

                    // Radius circle
                    L.circle([lat, lng], {
                        radius: radiusKm * 1000,
                        color: '#f59e0b',
                        fillColor: '#f59e0b',
                        fillOpacity: 0.06,
                        weight: 1.5,
                        dashArray: '6 4',
                        interactive: false,
                    }).addTo(markersLayer);
                } else {
                    L.marker([lat, lng], { icon: nodeIcon })
                        .bindPopup(`
                            <div style="font-family:Inter,sans-serif;">
                                <strong>${name}</strong><br>
                                <span style="color:#94a3b8;font-size:0.85em;">${node.member_count} members</span>
                                ${contactHtml}
                            </div>
                        `)
                        .addTo(markersLayer);
                }
                bounds.push([lat, lng]);
            }

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

// ======================== NAV SCROLL EFFECT ========================
window.addEventListener('scroll', () => {
    const nav = document.getElementById('navbar');
    if (window.scrollY > 50) {
        nav.style.background = 'rgba(5, 10, 20, 0.95)';
    } else {
        nav.style.background = 'rgba(5, 10, 20, 0.85)';
    }
});

// ======================== STEP DEEP DIVE MODAL ========================
const STEP_DETAILS = [
    {
        number: '01',
        icon: '🏡',
        tag: 'Infrastructure & Self-Hosting',
        title: 'Bootstrap a Sovereign Node',
        subtitle: 'Deploy an independent community exchange gateway for your town or valley with zero corporate intermediaries.',
        points: [
            { title: 'Single Docker Deployment', text: 'Run the entire stack (Node engine, SQLite database, P2P syncer, and Web gateway) in seconds with Docker Compose.' },
            { title: 'Community Data Ownership', text: 'All transaction history, profiles, and trust graphs are stored locally on your node. No subscriptions or third-party cloud lock-in.' },
            { title: 'Autonomous Fleet Telemetry', text: 'Node runners have access to the built-in Fleet Manager (/manager) with encrypted harvester backups and peer health checks.' }
        ],
        primaryAction: { label: 'Start Your Node (Docker) →', href: '#get-started' },
        secondaryAction: { label: '▶ Watch Setup Tutorial on YouTube', href: 'https://www.youtube.com/@beanpool' }
    },
    {
        number: '02',
        icon: '🔑',
        tag: 'Cryptographic Identity',
        title: 'Sovereign Identity & Dual-Custody',
        subtitle: 'Own your keys and trust reputation with passkeys and decentralized social recovery.',
        points: [
            { title: 'Ed25519 Cryptographic Keys', text: 'Your unique cryptographic identity is generated directly on your mobile device, signed and anchored in the community web of trust.' },
            { title: 'Dual-Custody Protection', text: 'Hardware passkeys in SecureStore for power users, plus 1-click encrypted Apple/Google SSO backup so everyday members never lose access.' },
            { title: 'Social Guardian Recovery', text: 'Appoint trusted neighborhood friends/vouchers to hold encrypted recovery shards in case your phone is ever lost or damaged.' }
        ],
        primaryAction: { label: 'Read Identity Guide (§3) →', href: 'getting-started.html#3' },
        secondaryAction: { label: '▶ Watch Mobile Pairing Walkthrough', href: 'https://www.youtube.com/@beanpool' }
    },
    {
        number: '03',
        icon: '⚖️',
        tag: 'Zero-Sum Mutual Credit',
        title: 'Earned Reciprocal Credit & Staking',
        subtitle: 'Value flows directly from community service to service — no debt, no interest, and no banks.',
        points: [
            { title: 'Start at Zero (Zero-Sum)', text: 'No fiat money is ever injected. Every transaction is balanced: one member is debited, another is credited symmetrically.' },
            { title: 'The Offer Covenant (−200 Beans)', text: 'Posting your first active marketplace offer instantly unlocks a credit line of −200 Beans (≈ 5 hours of community labor).' },
            { title: 'Escrow Protection & Reputation', text: 'Trades are secured in cryptographic escrow until the buyer confirms completion. Successful trades unlock deeper credit lines down to −2,000 Beans.' }
        ],
        primaryAction: { label: 'View Credit Rules (§4) →', href: 'rules.html#4' },
        secondaryAction: { label: '▶ Watch Mutual Credit Video', href: 'https://www.youtube.com/@beanpool' }
    },
    {
        number: '04',
        icon: '🌐',
        tag: 'Federation & Civic Commons',
        title: 'Keynesian Clearing & Democratic Commons',
        subtitle: 'Trade between towns without fiat currency, while circulation fees fund democratic local projects.',
        points: [
            { title: 'Keynesian Trade Connectors', text: 'Inspired by John Maynard Keynes\' Bancor, autonomous community nodes trade cross-border with multilateral clearing unions and zero currency drain.' },
            { title: 'Progressive Demurrage', text: 'A gentle progressive circulation incentive on idle surplus balances encourages active spending and prevents speculative hoarding.' },
            { title: '100% Member-Voted Commons', text: 'Circulation demurrage flows directly into a Community Commons pool, voted on democratically by residents for regenerative local projects.' }
        ],
        primaryAction: { label: 'View Federation Rules (§7) →', href: 'rules.html#7' },
        secondaryAction: { label: '▶ Watch Keynesian Clearing Video', href: 'https://www.youtube.com/@beanpool' }
    }
];

function openStepModal(index) {
    const data = STEP_DETAILS[index];
    if (!data) return;

    const modal = document.getElementById('step-modal');
    const content = document.getElementById('step-modal-content');

    const pointsHtml = data.points.map(p => `
        <div class="modal-point-card">
            <strong>${p.title}</strong>
            <p>${p.text}</p>
        </div>
    `).join('');

    content.innerHTML = `
        <div class="modal-step-header">
            <div class="modal-step-icon">${data.icon}</div>
            <div>
                <span class="modal-step-tag">Step ${data.number} &middot; ${data.tag}</span>
                <h2>${data.title}</h2>
            </div>
        </div>
        <p class="modal-step-subtitle">${data.subtitle}</p>
        <div class="modal-points-grid">
            ${pointsHtml}
        </div>
        <div class="modal-actions-row">
            <a href="${data.primaryAction.href}" class="btn btn-primary" onclick="closeStepModal()">${data.primaryAction.label}</a>
            <a href="${data.secondaryAction.href}" target="_blank" rel="noopener" class="btn btn-ghost" style="border-color: rgba(255, 0, 0, 0.4); color: #ff6666;">${data.secondaryAction.label}</a>
        </div>
    `;

    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function closeStepModal() {
    const modal = document.getElementById('step-modal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
}

// Close modal on backdrop click or ESC key
const stepModal = document.getElementById('step-modal');
if (stepModal) {
    stepModal.addEventListener('click', (e) => {
        if (e.target === stepModal) closeStepModal();
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeStepModal();
});

// ======================== INIT ========================
pollNodes();
// Re-poll every 5 minutes
setInterval(pollNodes, 300_000);

