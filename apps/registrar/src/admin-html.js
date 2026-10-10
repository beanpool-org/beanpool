export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BeanPool DNS & Tunnel Registrar — Super Admin</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #030712;
            --bg-surface: #0b0f19;
            --bg-card: rgba(17, 24, 39, 0.45);
            --text-primary: #f8fafc;
            --text-secondary: #cbd5e1;
            --text-muted: #64748b;
            --accent: #f59e0b;
            --radius-lg: 24px;
            --radius-sm: 10px;
            --font-header: 'Outfit', 'Space Grotesk', -apple-system, sans-serif;
            --font-body: 'Inter', -apple-system, sans-serif;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: var(--font-body); background-color: var(--bg-primary); color: var(--text-primary); min-height: 100vh; }
        .admin-card {
            background: rgba(11, 15, 25, 0.75);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: var(--radius-lg);
            padding: 1.5rem;
            backdrop-filter: blur(12px);
            margin-bottom: 2rem;
        }
        .admin-input {
            width: 100%;
            background: rgba(3, 7, 18, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.12);
            color: #f8fafc;
            padding: 0.75rem 1rem;
            border-radius: var(--radius-sm);
            font-family: monospace;
            font-size: 0.9rem;
        }
        .admin-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.85rem;
            text-align: left;
        }
        .admin-table th {
            padding: 0.75rem 1rem;
            background: rgba(17, 24, 39, 0.6);
            color: var(--text-muted);
            font-family: var(--font-header);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            font-size: 0.75rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .admin-table td {
            padding: 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
            color: var(--text-secondary);
        }
        .btn {
            display: inline-flex; align-items: center; justify-content: center;
            padding: 0.5rem 1rem; border-radius: var(--radius-sm); font-weight: 600;
            cursor: pointer; text-decoration: none; transition: all 0.2s;
        }
        .btn-approve { background: #10b981; color: white; border: none; padding: 0.4rem 0.85rem; font-size: 0.8rem; border-radius: var(--radius-sm); cursor: pointer; }
        .btn-approve:hover { background: #059669; }
        .btn-revoke {
            background: rgba(239, 68, 68, 0.15);
            color: #f87171;
            border: 1px solid rgba(239, 68, 68, 0.35);
            padding: 0.4rem 0.85rem;
            font-size: 0.8rem;
            border-radius: var(--radius-sm);
            cursor: pointer;
            transition: all 0.2s ease-in-out;
        }
        .btn-revoke:hover {
            background: rgba(239, 68, 68, 0.9);
            color: #ffffff;
            border-color: #ef4444;
            box-shadow: 0 0 12px rgba(239, 68, 68, 0.4);
        }
        .btn-logout { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
        .btn-logout:hover { background: rgba(239, 68, 68, 0.25); }
        .badge-mode {
            padding: 0.2rem 0.6rem; border-radius: 6px; font-size: 0.75rem;
            font-weight: 700; font-family: monospace; text-transform: uppercase;
        }
        .badge-tunnel { background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3); }
        .badge-direct { background: rgba(14, 165, 233, 0.15); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.3); }
        .scroll-x { overflow-x: auto; }
        .alert-modes { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; margin: 0.75rem 0; }
        .alert-mode { display: flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; }
        .alert-mode button { background: rgba(255,255,255,0.05); color: var(--text-secondary); border: 1px solid rgba(255,255,255,0.12); padding: 0.25rem 0.6rem; border-radius: 8px; cursor: pointer; font-size: 0.75rem; }
        .alert-mode button.on { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border-color: rgba(245, 158, 11, 0.5); font-weight: 700; }
        tr.lit td { background: rgba(245, 158, 11, 0.12); }
    </style>
</head>
<body>
    <div style="max-width: 1000px; margin: 0 auto; padding: 2rem 1.5rem;">
        <header style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem;">
            <div style="display: flex; align-items: center; gap: 1rem;">
                <img src="https://beanpool.org/bean.png" alt="BeanPool Logo" style="width: 48px; height: 48px; object-fit: contain;">
                <div>
                    <h1 style="font-family: var(--font-header); font-size: 1.5rem; color: #fff;">Super Admin — Registrar Control</h1>
                    <p style="font-size: 0.85rem; color: var(--text-muted);">Manage DNS subdomains & Cloudflare Tunnels for beanpool.org</p>
                </div>
            </div>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
                <button id="headerLogoutBtn" class="btn btn-logout" style="display: none; padding: 0.5rem 1rem; border-radius: 9999px;">🔒 Logout</button>
                <a href="/" class="btn" style="padding: 0.5rem 1rem; border-radius: 9999px; text-decoration: none; color: var(--text-secondary); background: rgba(255,255,255,0.05);">← Back to site</a>
            </div>
        </header>

        <div class="admin-card">
            <h2 style="font-size: 1rem; font-family: var(--font-header); margin-bottom: 0.75rem; color: var(--accent);">🔑 Super Admin Credentials</h2>
            <div style="display: flex; gap: 0.75rem; align-items: center;">
                <input type="password" id="adminSecretInput" class="admin-input" placeholder="Enter ADMIN_SECRET key..." style="flex: 1;">
                <button id="saveSecretBtn" class="btn btn-approve" style="white-space: nowrap;">Save & Connect</button>
                <button id="logoutSecretBtn" class="btn btn-logout" style="white-space: nowrap; display: none;">Logout</button>
            </div>
            <p id="secretStatus" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem;"></p>
        </div>

        <div class="admin-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #fbbf24;">⏳ Pending Name Claims (Awaiting Your Approval)</h2>
                <button id="refreshBtn" class="btn" style="padding: 0.35rem 0.8rem; font-size: 0.8rem; background: rgba(255,255,255,0.05); color: #fff; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer;">🔄 Refresh</button>
            </div>
            <div id="pendingTableContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading claims...</p></div>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #10b981; margin-bottom: 1rem;">🌐 Names (live, paused, blocked, released)</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1rem;">A name belongs to its node's key. Pause and Block stop routing but never free a name; only Release frees one: held 30 days for its key (which can take it back), then free to anyone — or at once, with "free now". A name you blocked or paused is held 30 days from every key, its own included.</p>
            <div id="activeTableContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading active allocations...</p></div>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #f59e0b; margin-bottom: 0.5rem;">📣 Alerts to your phone</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted);">Name requests, new communities, paused names, a suspended sweep, our servers below and your own actions, sent to one ntfy topic, and one quiet daily summary at 08:00 Brisbane. Each says a name, its community name and counts — never a contact address. At most 20 messages an hour.</p>
            <div id="alertsContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading alerts...</p></div>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #38bdf8; margin-bottom: 0.5rem;">🛰️ Our servers</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted);">Looked at every 5 minutes from this Worker, never from the server itself (WATCH_TARGETS). Two failed looks in a row and your phone hears of it; so it does of a locked vault, a vault report that is not right, a release that changed, and a node its watchdog restarted.</p>
            <div id="serversContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading servers...</p></div>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #818cf8; margin-bottom: 1rem;">🧾 Name events (newest first)</h2>
            <div id="eventsTableContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading events...</p></div>
        </div>
    </div>

    <script>
        const secretInput = document.getElementById('adminSecretInput');
        const saveBtn = document.getElementById('saveSecretBtn');
        const logoutBtn = document.getElementById('logoutSecretBtn');
        const headerLogoutBtn = document.getElementById('headerLogoutBtn');
        const statusText = document.getElementById('secretStatus');
        const refreshBtn = document.getElementById('refreshBtn');

        function updateAuthUI() {
            const savedSecret = sessionStorage.getItem('bp_registrar_admin_secret');
            if (savedSecret) {
                secretInput.value = savedSecret;
                statusText.textContent = 'Key connected.';
                statusText.style.color = '#10b981';
                logoutBtn.style.display = 'inline-flex';
                headerLogoutBtn.style.display = 'inline-flex';
            } else {
                secretInput.value = '';
                statusText.textContent = 'Disconnected / Logged out.';
                statusText.style.color = 'var(--text-muted)';
                logoutBtn.style.display = 'none';
                headerLogoutBtn.style.display = 'none';
            }
        }

        saveBtn.addEventListener('click', function() {
            const val = secretInput.value.trim();
            if (val) {
                sessionStorage.setItem('bp_registrar_admin_secret', val);
                updateAuthUI();
                loadRegistrarData();
            }
        });

        function performLogout() {
            sessionStorage.removeItem('bp_registrar_admin_secret');
            updateAuthUI();
            document.getElementById('pendingTableContainer').innerHTML = '<p style="color: #f87171;">Logged out. Please enter your ADMIN_SECRET key above.</p>';
            document.getElementById('activeTableContainer').innerHTML = '<p style="color: #f87171;">Logged out.</p>';
            document.getElementById('alertsContainer').innerHTML = '<p style="color: #f87171;">Logged out.</p>';
            document.getElementById('serversContainer').innerHTML = '<p style="color: #f87171;">Logged out.</p>';
        }

        logoutBtn.addEventListener('click', performLogout);
        headerLogoutBtn.addEventListener('click', performLogout);
        refreshBtn.addEventListener('click', function() { loadRegistrarData(); });

        // Node-supplied text (community name, contact, event details) goes into innerHTML: escape all of it.
        function esc(v) {
            return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }

        const CONFIRM = {
            approve: function(n) { return 'Approve ' + n + '.beanpool.org?'; },
            pause: function(n) { return 'Pause ' + n + '.beanpool.org?\\n\\nRouting stops (DNS removed); the name and tunnel stay with its owner. Only Resume lifts it — the node cannot.'; },
            resume: function(n) { return 'Resume ' + n + '.beanpool.org?\\n\\nRouting comes back only when nobody but its owner can be answering: at once on a fresh tunnel, otherwise after an edge re-attest signed by its key. A tunnel kept by a block, or by a pause you did not make, is deleted first. If the re-attest fails, your hold is lifted and the name stays paused until its node heals it.'; },
            block: function(n) { return '⚠️ BLOCK ' + n + '.beanpool.org?\\n\\nTunnel and DNS are deleted. The name stays held by this key and is NEVER free; its node cannot heal or release it. Undo with Resume. Release holds it 30 days from every key, this one included, then frees it (at once with "free now").'; },
            // fromAll: a name you blocked or paused — its release holds it from its own key too.
            release: function(n, freeNow, fromAll) {
                if (freeNow) return '⚠️ RELEASE ' + n + '.beanpool.org?\\n\\nTunnel and DNS are deleted and the name is FREE AT ONCE, to any key.';
                return fromAll
                    ? 'RELEASE ' + n + '.beanpool.org?\\n\\nTunnel and DNS are deleted. The name is held 30 days from EVERY key, this one included: its node cannot take it back. Then it is free to anyone, this key too. To keep this key off it, leave it blocked; to free it now for someone new, tick "free now".'
                    : 'RELEASE ' + n + '.beanpool.org?\\n\\nTunnel and DNS are deleted. The name is held 30 days for its key, which can take it back; then it is free. To free it now for someone new, tick "free now".';
            },
        };

        document.addEventListener('click', function(e) {
            const target = e.target.closest('[data-action]');
            if (target) adminAction(target.getAttribute('data-name'), target.getAttribute('data-action'), target);
        });

        async function loadRegistrarData() {
            const secret = secretInput.value.trim();
            if (!secret) {
                document.getElementById('pendingTableContainer').innerHTML = '<p style="color: #f87171;">Please enter your ADMIN_SECRET above to view claims.</p>';
                document.getElementById('activeTableContainer').innerHTML = '<p style="color: #f87171;">Please enter your ADMIN_SECRET above.</p>';
                return;
            }

            try {
                const res = await fetch('/api/local/admin/registrar/pending', {
                    headers: { 'x-admin-secret': secret }
                });

                if (res.status === 401) {
                    statusText.textContent = 'Invalid ADMIN_SECRET key.';
                    statusText.style.color = '#ef4444';
                    return;
                }

                const data = await res.json();
                const allocs = data.allocations || [];

                const pending = allocs.filter(function(a) { return a.status === 'pending'; });
                const active = allocs.filter(function(a) { return a.status !== 'pending'; });

                renderPending(pending);
                renderActive(active);
                showFragment();
                loadEvents(secret);
                loadAlerts(secret);
                loadServers(secret);
            } catch (err) {
                console.error(err);
                document.getElementById('pendingTableContainer').innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading allocations.</p>';
            }
        }

        function renderPending(pending) {
            const container = document.getElementById('pendingTableContainer');
            if (pending.length === 0) {
                container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No pending name claims awaiting approval.</p>';
                return;
            }

            let html = '<table class="admin-table"><thead><tr><th>Domain Name</th><th>Community / Operator</th><th>Node Pubkey</th><th>Mode</th><th>Requested</th><th style="text-align: right;">Action</th></tr></thead><tbody>';

            pending.forEach(function(claim) {
                const domain = esc(claim.name) + '.beanpool.org';
                const date = claim.requested_at ? new Date(claim.requested_at * 1000).toLocaleString() : '—';
                const pubkeyShort = claim.node_pubkey ? esc(claim.node_pubkey.slice(0, 12) + '...' + claim.node_pubkey.slice(-8)) : '—';
                const modeClass = claim.mode === 'direct' ? 'badge-direct' : 'badge-tunnel';
                const comm = claim.community_name ? esc(claim.community_name) : '—';
                const contactInfo = claim.contact ? ' (' + esc(claim.contact) + ')' : '';

                html += '<tr id="row-' + esc(claim.name) + '">' +
                    '<td style="font-weight: 700; color: #fbbf24; font-family: monospace;">' + domain + '</td>' +
                    '<td><span style="font-weight: 600; color: #fff;">' + comm + '</span><span style="font-size: 0.75rem; color: var(--text-muted);">' + contactInfo + '</span></td>' +
                    '<td style="font-family: monospace; font-size: 0.75rem;">' + pubkeyShort + '</td>' +
                    '<td><span class="badge-mode ' + modeClass + '">' + esc(claim.mode || 'tunnel') + '</span></td>' +
                    '<td style="font-family: monospace; font-size: 0.75rem;">' + date + '</td>' +
                    '<td style="text-align: right;">' +
                        '<button data-name="' + esc(claim.name) + '" data-action="approve" class="btn-approve">Approve</button>' +
                        '<button data-name="' + esc(claim.name) + '" data-action="release" data-free-now="1" class="btn-revoke" style="margin-left: 0.4rem;" title="Rejects the claim; the name is free again">Reject</button>' +
                    '</td>' +
                '</tr>';
            });

            html += '</tbody></table>';
            container.innerHTML = html;
        }

        function renderActive(active) {
            const container = document.getElementById('activeTableContainer');
            if (active.length === 0) {
                container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No active allocations currently live.</p>';
                return;
            }

            let html = '<table class="admin-table"><thead><tr><th>Domain Name</th><th>Community / Operator</th><th>Node Pubkey</th><th>Mode</th><th>Status</th><th style="text-align: right;">Action</th></tr></thead><tbody>';

            const LOOK = {
                live: ['🟢', '#10b981'], paused: ['⏸️', '#fbbf24'], blocked: ['⛔', '#f87171'], released: ['↩️', '#94a3b8'],
            };
            const ACTIONS = {
                live: [['pause', 'Pause'], ['block', 'Block']],
                paused: [['resume', 'Resume'], ['block', 'Block']],
                blocked: [['resume', 'Resume'], ['release', 'Release']],
                released: [['release', 'Free now', true]],   // a held release: this button frees it at once
            };

            active.forEach(function(alloc) {
                const domain = esc(alloc.name) + '.beanpool.org';
                const pubkeyShort = alloc.node_pubkey ? esc(alloc.node_pubkey.slice(0, 12) + '...' + alloc.node_pubkey.slice(-8)) : '—';
                const modeClass = alloc.mode === 'direct' ? 'badge-direct' : 'badge-tunnel';
                const comm = alloc.community_name ? esc(alloc.community_name) : '—';
                const contactInfo = alloc.contact ? ' (' + esc(alloc.contact) + ')' : '';
                const look = LOOK[alloc.status] || ['•', '#cbd5e1'];
                const why = alloc.pause_reason ? ' · ' + esc(alloc.pause_reason) : '';
                const since = alloc.paused_at || alloc.released_at;
                const sinceText = since ? '<br><span style="color: var(--text-muted); font-size: 0.7rem;">since ' + new Date(since * 1000).toLocaleString() + '</span>' : '';
                // An admin release with "free now" (or a withdrawn claim nobody approved) is already free; the owner's
                // release and the admin's default one are held 30 days for its key — "Free now" skips that.
                const acts = (alloc.status === 'released' && (alloc.pause_reason === 'admin' || alloc.pause_reason === 'withdrawn')) ? [] : (ACTIONS[alloc.status] || [['block', 'Block'], ['release', 'Release']]);
                // Released after you blocked or paused it, the name is held from its own key too (the Worker's rule).
                const fromAll = alloc.status === 'blocked' || (alloc.status === 'paused' && alloc.pause_reason === 'admin');

                html += '<tr id="row-' + esc(alloc.name) + '">' +
                    '<td style="font-weight: 700; color: ' + look[1] + '; font-family: monospace;">' + domain + '</td>' +
                    '<td><span style="font-weight: 600; color: #fff;">' + comm + '</span><span style="font-size: 0.75rem; color: var(--text-muted);">' + contactInfo + '</span></td>' +
                    '<td style="font-family: monospace; font-size: 0.75rem;">' + pubkeyShort + '</td>' +
                    '<td><span class="badge-mode ' + modeClass + '">' + esc(alloc.mode || 'tunnel') + '</span></td>' +
                    '<td><span style="color: ' + look[1] + '; font-weight: 600; font-size: 0.75rem; font-family: monospace;">' + look[0] + ' ' + esc(alloc.status) + why + '</span>' + sinceText + '</td>' +
                    '<td style="text-align: right; white-space: nowrap;">' +
                        acts.map(function(a) {
                            // Release holds the name 30 days (for its key, or from every key) unless its "free now" box is ticked.
                            const box = (a[0] === 'release' && !a[2])
                                ? '<label style="margin-left: 0.6rem; font-size: 0.75rem; color: var(--text-muted);" title="Free the name at once, to any key, instead of holding it 30 days">' +
                                    '<input type="checkbox" data-free-now-for="' + esc(alloc.name) + '"> free now</label>'
                                : '';
                            const flags = (a[2] ? ' data-free-now="1"' : '') + (a[0] === 'release' && fromAll ? ' data-held-from-all="1"' : '');
                            return box + '<button data-name="' + esc(alloc.name) + '" data-action="' + a[0] + '"' + flags + ' class="' + (a[0] === 'resume' ? 'btn-approve' : 'btn btn-revoke') + '" style="margin-left: 0.4rem;">' + a[1] + '</button>';
                        }).join('') +
                    '</td>' +
                '</tr>';
            });

            html += '</tbody></table>';
            container.innerHTML = html;
        }

        async function adminAction(name, action, target) {
            const secret = secretInput.value.trim();
            // A release frees the name at once only when its button says so (Free now, Reject) or its box is ticked.
            const box = document.querySelector('input[data-free-now-for="' + name + '"]');
            const freeNow = action === 'release' && ((!!target && target.getAttribute('data-free-now') === '1') || (!!box && box.checked));
            const fromAll = !!target && target.getAttribute('data-held-from-all') === '1';
            if (!CONFIRM[action] || !confirm(CONFIRM[action](name, freeNow, fromAll))) return;

            try {
                const init = { method: 'POST', headers: { 'x-admin-secret': secret } };
                if (action === 'release') {
                    init.headers['content-type'] = 'application/json';
                    init.body = JSON.stringify({ free_now: freeNow });
                }
                const res = await fetch('/api/local/admin/registrar/' + encodeURIComponent(name) + '/' + action, init);
                const data = await res.json();
                if (res.ok) {
                    alert(name + '.beanpool.org is now ' + data.status + (data.reason ? ' (' + data.reason + (data.why ? ': ' + data.why : '') + ')' : '') +
                        (data.held_until ? (data.reason === 'admin-held-all' ? ', held from every key, its own included, until ' : ', held for its key until ') + new Date(data.held_until * 1000).toLocaleString() : '') + '.');
                    loadRegistrarData();
                } else {
                    alert(action + ' failed: ' + (data.error || '') + (data.detail ? ' — ' + data.detail : '') + (data.ref ? ' (log ref ' + data.ref + ')' : ''));
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
        }

        async function loadEvents(secret) {
            const container = document.getElementById('eventsTableContainer');
            try {
                const res = await fetch('/api/local/admin/registrar/events?limit=100', { headers: { 'x-admin-secret': secret } });
                if (!res.ok) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Could not load events.</p>'; return; }
                const events = (await res.json()).events || [];
                if (events.length === 0) { container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No events yet.</p>'; return; }
                let html = '<table class="admin-table"><thead><tr><th>When</th><th>Name</th><th>Event</th><th>Detail</th></tr></thead><tbody>';
                events.forEach(function(ev) {
                    // incident-review rows are the ones waiting for a human decision.
                    const colour = ev.event === 'incident-review' ? '#fbbf24' : 'var(--text-secondary)';
                    html += '<tr>' +
                        '<td style="font-family: monospace; font-size: 0.75rem; white-space: nowrap;">' + new Date(ev.at * 1000).toLocaleString() + '</td>' +
                        '<td style="font-family: monospace;">' + esc(ev.name) + '</td>' +
                        '<td style="color: ' + colour + '; font-weight: 600;">' + esc(ev.event) + '</td>' +
                        '<td style="font-size: 0.8rem;">' + esc(ev.detail) + '</td>' +
                    '</tr>';
                });
                container.innerHTML = html + '</tbody></table>';
            } catch (err) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading events.</p>';
            }
        }

        // A tap on an alert opens /admin#<name>: once the tables are drawn, that name's row is scrolled to and lit.
        function showFragment() {
            const hash = typeof location !== 'undefined' ? location.hash : '';
            let name = '';
            try { name = decodeURIComponent(String(hash || '').replace(/^#/, '')).toLowerCase(); } catch (e) { return; }
            if (!/^[a-z0-9-]{3,32}$/.test(name)) return;
            const row = document.getElementById('row-' + name);
            if (!row || typeof row.scrollIntoView !== 'function') return;
            row.className = 'lit';
            row.scrollIntoView({ block: 'center' });
        }
        if (typeof window !== 'undefined') window.addEventListener('hashchange', showFragment);

        const CATEGORY_WORDS = {
            names: 'Names (requests, new communities, pauses)', health: 'Health (our servers, suspended sweep, refused deletions)',
            uptake: 'Uptake', admin: 'Your own actions',
        };
        const MODE_WORDS = { on: 'on', digest: 'digest', off: 'off' };
        const when = function(s) { return s ? new Date(s * 1000).toLocaleString() : 'never'; };

        function renderAlerts(st) {
            const container = document.getElementById('alertsContainer');
            const ch = st.channel || {};
            // The daily summary goes with the outside checks of our servers: none while WATCH_TARGETS is unset.
            const noDaily = st.daily_line === false;
            let html = '';
            if (!ch.set) {
                html += '<p style="color: #f87171; font-size: 0.85rem;">Not set: NTFY_URL is not a Worker secret, so nothing is sent' + (ch.waiting ? ' (' + ch.waiting + ' waiting for it)' : '') + '. Set it with <code>wrangler secret put NTFY_URL</code> (the full topic URL), and NTFY_TOKEN for an ntfy access token.</p>';
            } else {
                html += '<p style="font-size: 0.85rem;">ntfy: <b style="color: #10b981;">set</b>' + (ch.token ? ', with a token' : ', no token') +
                    ' · last sent ' + esc(when(ch.last_ok_at)) + ' · ' + esc(ch.waiting) + ' waiting' +
                    (ch.failed_in_a_row ? ' · <span style="color: #f87171;">failing: ' + esc(ch.last_status) + ' (' + esc(ch.failed_in_a_row) + ' in a row), next try ' + esc(when(ch.next_try_at)) + '</span>' : '') +
                    (ch.dropped ? ' · ' + esc(ch.dropped) + ' dropped (over 50 waiting)' : '') + '</p>';
            }
            const cap = st.cap || {};
            html += '<p style="font-size: 0.8rem; color: var(--text-muted);">This hour: ' + esc(cap.sent || 0) + ' sent (cap ' + esc(cap.per_hour || 20) + ', then one "muted" line; high and urgent still go, to 40)' + (cap.muted ? ', ' + esc(cap.muted) + ' muted' : '') + '.' +
                (st.held_for_digest ? ' ' + esc(st.held_for_digest) + (noDaily ? ' held, but there is no daily summary: WATCH_TARGETS is not set, and the daily line comes with the outside checks.'
                    : ch.set ? ' held for the daily summary (08:00 Brisbane): shown below.' : ' held — no channel set, so no daily summary carries them yet: shown below.') : '') + '</p>';
            html += '<div class="alert-modes">' + Object.keys(CATEGORY_WORDS).map(function(c) {
                const mode = (st.settings || {})[c] || 'on';
                return '<span class="alert-mode">' + esc(CATEGORY_WORDS[c]) + ': ' + Object.keys(MODE_WORDS).map(function(m) {
                    return '<button data-alert-category="' + c + '" data-alert-mode="' + m + '"' + (m === mode ? ' class="on"' : '') + '>' + MODE_WORDS[m] + '</button>';
                }).join('') + '</span>';
            }).join('') + '</div>';
            html += '<p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.75rem;">on = sent at once · ' + (noDaily
                ? 'digest = held for the daily summary, which is not sent while WATCH_TARGETS is not set' : 'digest = held, then sent in the daily summary at 08:00 Brisbane') + ' · off = nothing</p>';
            html += '<button data-alert-test="1" class="btn-approve">Send a test alert</button> <span id="alertTestResult" style="font-size: 0.8rem; color: var(--text-muted);"></span>';
            const active = st.active || [];
            if (active.length) {
                html += '<p style="font-size: 0.85rem; color: #fbbf24; margin-top: 1rem;">Raised now:</p><ul style="font-size: 0.8rem; margin-left: 1.25rem;">' + active.map(function(a) {
                    return '<li>' + esc(a.detail) + ' <span style="color: var(--text-muted);">(since ' + esc(when(a.since)) + ')</span></li>';
                }).join('') + '</ul>';
            }
            const recent = st.recent || [];
            if (recent.length) {
                html += '<div class="scroll-x" style="margin-top: 1rem;"><table class="admin-table"><thead><tr><th>When</th><th>Alert</th><th>State</th></tr></thead><tbody>' + recent.map(function(r) {
                    // A held event is marked sent only once the daily summary carrying it is sent.
                    const state = r.held ? (r.sent_at ? 'sent in the daily summary' : noDaily ? 'held — no daily summary (WATCH_TARGETS is not set)' : ch.set ? 'held for the daily summary' : 'held — no channel set')
                        : r.sent_at ? 'sent' : r.muted ? 'muted (over the hourly cap)' : 'waiting';
                    return '<tr><td style="font-family: monospace; font-size: 0.75rem; white-space: nowrap;">' + esc(when(r.at)) + '</td>' +
                        '<td><b style="color: #fff;">' + esc(r.title) + '</b><br><span style="font-size: 0.8rem;">' + esc(r.body) + '</span></td>' +
                        '<td style="font-size: 0.75rem;">' + esc(state) + '</td></tr>';
                }).join('') + '</tbody></table></div>';
            }
            container.innerHTML = html;
        }

        async function loadAlerts(secret) {
            const container = document.getElementById('alertsContainer');
            try {
                const res = await fetch('/api/local/admin/registrar/alerts', { headers: { 'x-admin-secret': secret } });
                if (!res.ok) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Could not load alerts.</p>'; return; }
                renderAlerts(await res.json());
            } catch (err) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading alerts.</p>';
            }
        }

        async function setAlertMode(category, mode) {
            const secret = secretInput.value.trim();
            const res = await fetch('/api/local/admin/registrar/alerts/settings', {
                method: 'POST', headers: { 'x-admin-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify({ category: category, mode: mode }),
            });
            if (res.ok) renderAlerts(await res.json());
            else alert('Could not change it: ' + ((await res.json()).error || res.status));
        }

        async function sendTestAlert() {
            const secret = secretInput.value.trim();
            const out = document.getElementById('alertTestResult');
            out.textContent = 'Sending...';
            try {
                const res = await fetch('/api/local/admin/registrar/alerts/test', { method: 'POST', headers: { 'x-admin-secret': secret } });
                const data = await res.json();
                out.textContent = data.sent ? 'Sent (' + data.status + '): check your phone.' : (data.error || 'Not sent.');
                loadAlerts(secret);
            } catch (err) {
                out.textContent = 'Network error: ' + err.message;
            }
        }

        function renderServers(st) {
            const container = document.getElementById('serversContainer');
            const targets = st.targets || [];
            if (!targets.length) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Nothing is watched: WATCH_TARGETS is not set in wrangler.toml.</p>'; return; }
            let html = '';
            if (!st.ticket_key_set) html += '<p style="color: #fbbf24; font-size: 0.8rem;">The vault report is not checked: VAULT_TICKET_KEYS (its ticket public key) is not set.</p>';
            if (st.fleet_differs_since) html += '<p style="color: #fbbf24; font-size: 0.8rem;">Our nodes run different releases, since ' + esc(when(st.fleet_differs_since)) + '.</p>';
            html += '<div class="scroll-x"><table class="admin-table"><thead><tr><th>Server</th><th>Now</th><th>Runs</th><th>Last 24 h</th></tr></thead><tbody>' + targets.map(function(t) {
                const l = t.last;
                const now = !l ? 'not looked at yet'
                    : l.ok ? 'answers (' + esc(l.status) + (l.ms != null ? ', ' + esc(l.ms) + ' ms' : '') + ')' + (l.state ? ' · ' + esc(l.state) : '') + (l.report ? ' · report ' + esc(l.report) : '')
                        : '<span style="color: #f87171;">does not answer: ' + esc(l.status) + '</span>' + (t.last_ok_at ? ' · last answered ' + esc(when(t.last_ok_at)) : '');
                const ver = l && (l.version || l.commit) ? esc(l.version || '') + (l.commit ? ' <span style="font-family: monospace;">(' + esc(String(l.commit).slice(0, 7)) + ')</span>' : '') : '—';
                const day = t.day || {};
                return '<tr id="server-' + esc(t.name) + '"><td><b style="color: #fff;">' + esc(t.name) + '</b><br><span style="font-size: 0.75rem; color: var(--text-muted);">' + esc(t.url) + '</span></td>' +
                    '<td style="font-size: 0.8rem;">' + now + (l ? '<br><span style="font-size: 0.7rem; color: var(--text-muted);">looked ' + esc(when(l.ran_at)) + '</span>' : '') + (l && l.recoveries ? '<br><span style="font-size: 0.75rem;">watchdog restarts: ' + esc(l.recoveries) + '</span>' : '') + '</td>' +
                    '<td style="font-size: 0.8rem;">' + ver + '</td>' +
                    '<td style="font-size: 0.8rem;">' + esc(day.ok || 0) + ' of ' + esc(day.looks || 0) + ' looks answered</td></tr>';
            }).join('') + '</tbody></table></div>';
            if (st.daily_sent_for) html += '<p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem;">Last daily summary: ' + esc(st.daily_sent_for) + ' (Brisbane day).</p>';
            container.innerHTML = html;
        }

        async function loadServers(secret) {
            const container = document.getElementById('serversContainer');
            try {
                const res = await fetch('/api/local/admin/registrar/servers', { headers: { 'x-admin-secret': secret } });
                if (!res.ok) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Could not load servers.</p>'; return; }
                renderServers(await res.json());
            } catch (err) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading servers.</p>';
            }
        }

        document.addEventListener('click', function(e) {
            const mode = e.target.closest('[data-alert-mode]');
            if (mode) setAlertMode(mode.getAttribute('data-alert-category'), mode.getAttribute('data-alert-mode'));
            if (e.target.closest('[data-alert-test]')) sendTestAlert();
        });

        updateAuthUI();
        if (sessionStorage.getItem('bp_registrar_admin_secret')) loadRegistrarData();
    </script>
</body>
</html>`;
