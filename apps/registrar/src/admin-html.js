export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BeanPool DNS & Tunnel Registrar — Super Admin</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <!-- No web font: this page asks nothing of Google. It draws in the system font (the stacks below fall through). -->
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
            padding: 0.75rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
            color: var(--text-secondary);
            vertical-align: top;
        }
        /* A table never runs past its card. Its columns are shares of the card (.w-*, each table's adding up to 100%,
           never a width in px), a long word (a contact, a long name) breaks rather than pushes, the action buttons
           wrap onto more lines, and below 1000px — where the card is narrower than its widest — a row is stacked. */
        .admin-table.stack { table-layout: fixed; }
        .admin-table th, .admin-table td { overflow-wrap: anywhere; }
        .admin-table th.act { text-align: right; }
        .w-name { width: 25%; } .w-comm { width: 22%; } .w-key { width: 12%; } .w-state { width: 17%; } .w-act { width: 24%; }
        .w-when { width: 20%; } .w-ev-name { width: 15%; } .w-event { width: 15%; } .w-detail { width: 50%; }
        .w-src { width: 26%; } .w-net { width: 20%; } .w-cnt { width: 20%; } .w-seen { width: 14%; } .w-sact { width: 20%; }
        .w-setting { width: 45%; } .w-now { width: 20%; } .w-change { width: 35%; }
        .w-notice { width: 50%; } .w-to { width: 18%; } .w-reach { width: 20%; } .w-nact { width: 12%; }
        .notice-text { white-space: pre-line; color: #fff; }
        .acts { display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: flex-end; align-items: center; }
        .acts > * { white-space: nowrap; }
        .acts label { font-size: 0.75rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: 0.25rem; }
        .pair { display: inline-flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
        .mono { font-family: monospace; }
        .domain { font-weight: 700; font-family: monospace; }
        .sub { display: block; font-size: 0.7rem; color: var(--text-muted); margin-top: 0.2rem; }
        .page { max-width: 1000px; margin: 0 auto; padding: 2rem 1.5rem; }
        .page-header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; margin-bottom: 2rem; }
        .row-wrap { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
        .row-wrap .admin-input { flex: 1 1 12rem; min-width: 0; }
        .card-head { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
        .released-head { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin-top: 1.5rem; font-size: 0.8rem; color: var(--text-muted); }
        details.released { margin-top: 0.75rem; }
        details.released > summary { cursor: pointer; color: #94a3b8; font-family: var(--font-header); font-weight: 600; padding: 0.4rem 0; }
        @media (max-width: 1000px) {
            .admin-table.stack thead { display: none; }
            .admin-table.stack, .admin-table.stack tbody, .admin-table.stack tr, .admin-table.stack td { display: block; width: 100%; }
            .admin-table.stack tr { border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding: 0.6rem 0; }
            .admin-table.stack td { border: none; padding: 0.2rem 0; }
            /* A stacked cell: its label in a narrow column, its value (and the line under it) beside it. */
            .admin-table.stack td[data-label] { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); align-items: baseline; }
            .admin-table.stack td[data-label]::before {
                content: attr(data-label); grid-column: 1; color: var(--text-muted); font-family: var(--font-header);
                text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.65rem;
            }
            .admin-table.stack td[data-label] > * { grid-column: 2; }
            .admin-table.stack .acts { justify-content: flex-start; padding-top: 0.35rem; }
        }
        @media (max-width: 480px) {
            .page { padding: 1rem 0.75rem; }
            .admin-card { padding: 1rem; border-radius: 16px; }
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
    <div class="page">
        <header class="page-header">
            <div style="display: flex; align-items: center; gap: 1rem;">
                <img src="https://beanpool.org/bean.png" alt="BeanPool Logo" style="width: 48px; height: 48px; object-fit: contain;">
                <div>
                    <h1 style="font-family: var(--font-header); font-size: 1.5rem; color: #fff;">Super Admin — Registrar Control</h1>
                    <p style="font-size: 0.85rem; color: var(--text-muted);">Manage DNS subdomains & Cloudflare Tunnels for beanpool.org</p>
                </div>
            </div>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
                <button id="headerLogoutBtn" class="btn btn-logout" style="display: none; padding: 0.5rem 1rem; border-radius: 9999px;">🔒 Sign out</button>
                <a href="/" class="btn" style="padding: 0.5rem 1rem; border-radius: 9999px; text-decoration: none; color: var(--text-secondary); background: rgba(255,255,255,0.05);">← Back to site</a>
            </div>
        </header>

        <div class="admin-card">
            <h2 style="font-size: 1rem; font-family: var(--font-header); margin-bottom: 0.75rem; color: var(--accent);">🔐 Signed in</h2>
            <p id="signInStatus" style="font-size: 0.85rem; color: var(--text-secondary);">Checking who is signed in...</p>
            <!-- Only for a registrar with no Cloudflare Access in front (no ACCESS_* vars): its ADMIN_SECRET, kept in this tab's memory, never stored. -->
            <div id="secretRow" class="row-wrap" style="display: none; margin-top: 0.75rem;">
                <input type="password" id="adminSecretInput" class="admin-input" placeholder="ADMIN_SECRET" autocomplete="off">
                <button id="saveSecretBtn" class="btn btn-approve" style="white-space: nowrap;">Connect</button>
            </div>
        </div>

        <div class="admin-card">
            <div class="card-head">
                <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #fbbf24;">⏳ Awaiting your approval</h2>
                <button id="refreshBtn" class="btn" style="padding: 0.35rem 0.8rem; font-size: 0.8rem; background: rgba(255,255,255,0.05); color: #fff; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer;">🔄 Refresh</button>
            </div>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1rem;">Claims of names held back for approval (big cities), and new names held over a limit (many from one source, the new-name budget, Hold all new names, the DNS zone near full: each says which, and where it came from). Nothing is made at Cloudflare until you approve one.</p>
            <div id="pendingTableContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading claims...</p></div>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #38bdf8; margin-bottom: 0.5rem;">⚙️ Setting up</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1rem;">New names that need nobody's approval, whose making at Cloudflare has not finished yet (Cloudflare was slow or failed, or the claim was cut off). Their node asks again, and the sweep finishes any older than two minutes, a few each time. Finish now makes it at once; Reject frees the name.</p>
            <div id="setupTableContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading claims...</p></div>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #f472b6; margin-bottom: 0.5rem;">🧭 New names, last 24 h</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1rem;">Where each new name came from: its source (one connecting address, kept only as a keyed hash, never the address) and its network. No limit refuses a claim: past one, a new name waits above for your approval. Approve the real ones; Reject all held frees a group's held names; Block all also blocks its live ones and refuses that source's new claims for 7 days. Kept 24 hours, or while a name from it is held.</p>
            <div id="sourcesContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading new names...</p></div>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #a3e635; margin-bottom: 0.5rem;">📨 Notices to operators</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1rem;">Write to one name, a group of names or every name. Each node hears it at its own next check-in (within 15 minutes) — blocked names too — shows it in its Settings under Public address, and tells its owners it has a message. Nothing is collected to reach anyone. A reply link lets its owner answer once, into the feedback inbox, without giving an address. Your words go to the node as written: never put a person's details in them.</p>
            <div id="noticesContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading notices...</p></div>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #10b981; margin-bottom: 1rem;">🌐 Names held now (live, paused, blocked)</h2>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1rem;">A name belongs to its node's key. Pause and Block stop routing but never free a name; only Release frees one: held 30 days for its key (which can take it back), then free to anyone — or at once, with "free now". A name you blocked or paused is held 30 days from every key, its own included. Released names are under "Released" below; one nobody holds any more can be removed from the list (it stays free to anyone). Past its 30 days, a name its key released (or you released without "free now") is free to others, but that key can still take it back as its own: "Free now" ends that, then it can be removed.</p>
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
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">The public status page: <a href="/status" style="color: #38bdf8;">beanpool.org/status</a> — the servers in STATUS_SERVERS and this registrar, up now, the last incident and 90 days' share, drawn from <a href="/api/registrar/status.json" style="color: #38bdf8;">/api/registrar/status.json</a>. Never a community's name.</p>
        </div>

        <div class="admin-card">
            <h2 style="font-size: 1.1rem; font-family: var(--font-header); color: #818cf8; margin-bottom: 1rem;">🧾 Name events (newest first)</h2>
            <div id="eventsTableContainer"><p style="color: var(--text-muted); font-size: 0.85rem;">Loading events...</p></div>
        </div>
    </div>

    <script>
        const secretInput = document.getElementById('adminSecretInput');
        const saveBtn = document.getElementById('saveSecretBtn');
        const secretRow = document.getElementById('secretRow');
        const headerLogoutBtn = document.getElementById('headerLogoutBtn');
        const statusText = document.getElementById('signInStatus');
        const refreshBtn = document.getElementById('refreshBtn');

        // Who is signed in (GET /whoami): Cloudflare Access, which signed the admin in with an email code and an
        // authenticator before this page was served — or, on a registrar with no Access in front, the ADMIN_SECRET typed
        // below, kept in this variable only (never stored: a reload asks again). The secret an older page kept in this
        // tab's storage is dropped.
        let signedIn = null;   // 'cloudflare-access' | 'admin-secret' | null
        let secret = '';
        try { sessionStorage.removeItem('bp_registrar_admin_secret'); } catch (e) { /* storage blocked: nothing kept */ }
        // Every request says it comes from this page (x-bp-admin: a header no other site can make a browser send).
        function authHeaders(extra) {
            const h = { 'x-bp-admin': '1' };
            if (secret) h['x-admin-secret'] = secret;
            for (const k in (extra || {})) h[k] = extra[k];
            return h;
        }

        function notSignedIn(why) {
            ['pendingTableContainer', 'setupTableContainer', 'sourcesContainer', 'activeTableContainer', 'alertsContainer', 'serversContainer'].forEach(function(id) {
                document.getElementById(id).innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">' + esc(why) + '</p>';
            });
        }

        async function checkSignIn() {
            let res = null;
            let data = {};
            try {
                res = await fetch('/api/local/admin/registrar/whoami', { headers: authHeaders() });
                data = (await res.json()) || {};
            } catch (err) {
                statusText.textContent = 'Could not reach the registrar: ' + err.message;
                statusText.style.color = '#ef4444';
                return;
            }
            if (res.ok && (data.via === 'cloudflare-access' || data.via === 'admin-secret')) {
                signedIn = data.via;
                statusText.textContent = data.via === 'cloudflare-access'
                    ? 'Signed in as ' + data.email + ' (Cloudflare Access: email code and authenticator).'
                    : 'Connected with the ADMIN_SECRET (this registrar has no Cloudflare Access in front).';
                statusText.style.color = '#10b981';
                secretRow.style.display = 'none';
                headerLogoutBtn.style.display = 'inline-flex';
                loadRegistrarData();
                return;
            }
            signedIn = null;
            headerLogoutBtn.style.display = 'none';
            statusText.style.color = '#ef4444';
            if (data.sign_in === 'cloudflare-access') {
                secretRow.style.display = 'none';
                statusText.textContent = 'Not signed in. Reload the page to sign in through Cloudflare Access.';
            } else {
                secretRow.style.display = 'flex';
                statusText.textContent = secret ? 'That is not the ADMIN_SECRET.' : 'This registrar has no Cloudflare Access in front: enter its ADMIN_SECRET.';
            }
        }

        saveBtn.addEventListener('click', function() {
            secret = secretInput.value.trim();
            secretInput.value = '';
            if (secret) checkSignIn();
        });

        // Access: its own sign-out, which ends the session for this site. The secret: forgotten, and the tables cleared.
        headerLogoutBtn.addEventListener('click', function() {
            if (signedIn === 'cloudflare-access') { location.href = '/cdn-cgi/access/logout'; return; }
            secret = '';
            signedIn = null;
            notSignedIn('Signed out.');
            checkSignIn();
        });
        refreshBtn.addEventListener('click', function() { loadRegistrarData(); });

        // Node-supplied text (community name, contact, event details) goes into innerHTML: escape all of it.
        function esc(v) {
            return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }

        const CONFIRM = {
            approve: function(n) { return 'Approve ' + n + '.beanpool.org?'; },
            // Finish now: an approve under the hood, of a name that needs no approval — its making at Cloudflare is done now.
            finish: function(n) { return 'Finish setting up ' + n + '.beanpool.org now?\\n\\nIt needs no approval: its tunnel and DNS record are made at Cloudflare now, and its node picks the tunnel up on its next check.'; },
            pause: function(n) { return 'Pause ' + n + '.beanpool.org?\\n\\nRouting stops (DNS removed); the name and tunnel stay with its owner. Only Resume lifts it — the node cannot.'; },
            resume: function(n) { return 'Resume ' + n + '.beanpool.org?\\n\\nRouting comes back only when nobody but its owner can be answering: at once on a fresh tunnel, otherwise after an edge re-attest signed by its key. A tunnel kept by a block, or by a pause you did not make, is deleted first. If the re-attest fails, your hold is lifted and the name stays paused until its node heals it.'; },
            block: function(n) { return '⚠️ BLOCK ' + n + '.beanpool.org?\\n\\nTunnel and DNS are deleted. The name stays held by this key and is NEVER free; its node cannot heal or release it. Undo with Resume. Release holds it 30 days from every key, this one included, then frees it (at once with "free now").'; },
            // fromAll: a name you blocked or paused — its release holds it from its own key too. takesBack: a release past
            // its hold that its old key can still take back as its own (Free now ends that).
            release: function(n, freeNow, fromAll, takesBack) {
                if (freeNow && takesBack) return '⚠️ FREE ' + n + '.beanpool.org NOW?\\n\\nIt is free to others already, but the key that released it can still take it back as its own — on a gated name without your approval. Free now ends that: that key becomes a new claimant, like anyone. Then it can be removed from the list.';
                if (freeNow) return '⚠️ RELEASE ' + n + '.beanpool.org?\\n\\nTunnel and DNS are deleted and the name is FREE AT ONCE, to any key.';
                return fromAll
                    ? 'RELEASE ' + n + '.beanpool.org?\\n\\nTunnel and DNS are deleted. The name is held 30 days from EVERY key, this one included: its node cannot take it back. Then it is free to anyone, this key too. To keep this key off it, leave it blocked; to free it now for someone new, tick "free now".'
                    : 'RELEASE ' + n + '.beanpool.org?\\n\\nTunnel and DNS are deleted. The name is held 30 days for its key, which can take it back; then it is free. To free it now for someone new, tick "free now".';
            },
            forget: function(n) { return 'Remove ' + n + '.beanpool.org from the list?\\n\\nNobody holds it: it stays free to anyone, as it is now. Anything Cloudflare still has for it is deleted. Its history stays under Name events.'; },
        };

        document.addEventListener('click', function(e) {
            const target = e.target.closest('[data-action]');
            if (target) adminAction(target.getAttribute('data-name'), target.getAttribute('data-action'), target);
            if (e.target.closest('[data-forget-all]')) forgetAllReleased();
            if (e.target.closest('[data-free-all]')) freeAllAndRemove();
        });

        async function loadRegistrarData() {
            if (!signedIn) {
                notSignedIn('Not signed in.');
                return;
            }

            try {
                const res = await fetch('/api/local/admin/registrar/pending', { headers: authHeaders() });

                if (res.status === 401) {
                    signedIn = null;
                    notSignedIn('Not signed in.');
                    checkSignIn();
                    return;
                }

                const data = await res.json();
                const allocs = data.allocations || [];

                const pending = allocs.filter(function(a) { return a.status === 'pending'; });
                const active = allocs.filter(function(a) { return a.status !== 'pending'; });

                renderPending(pending);
                renderActive(active);
                showFragment();
                loadSources();
                loadNotices();
                loadEvents();
                loadAlerts();
                loadServers();
            } catch (err) {
                console.error(err);
                // Under Access, an expired sign-in answers with a redirect to its sign-in page, which a fetch can't follow.
                document.getElementById('pendingTableContainer').innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading allocations.' +
                    (signedIn === 'cloudflare-access' ? ' If your sign-in has expired, reload the page.' : '') + '</p>';
            }
        }

        // Pending rows, in two lists by the Worker's word (awaiting_approval): a gated claim waits for you; an auto name
        // whose making did not finish waits for nobody ("Setting up"). A row that doesn't say is shown as awaiting you.
        function renderPending(pending) {
            // Held names from one source side by side: what "New names, last 24 h" below can reject or block in one click.
            const bySource = function(a, b) {
                const x = (a.source && a.source.id) || '', y = (b.source && b.source.id) || '';
                return x === y ? 0 : x < y ? -1 : 1;
            };
            renderClaims('pendingTableContainer', pending.filter(function(a) { return a.awaiting_approval !== false; }).sort(bySource),
                'No name claims awaiting your approval.', '#fbbf24', ['approve', 'Approve']);
            renderClaims('setupTableContainer', pending.filter(function(a) { return a.awaiting_approval === false; }),
                'No names being set up.', '#38bdf8', ['finish', 'Finish now']);
        }

        function renderClaims(id, claims, none, colour, act) {
            const container = document.getElementById(id);
            if (claims.length === 0) {
                container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">' + none + '</p>';
                return;
            }

            let html = namesHead('Requested');

            claims.forEach(function(claim) {
                const date = claim.requested_at ? new Date(claim.requested_at * 1000).toLocaleString() : '—';
                html += '<tr id="row-' + esc(claim.name) + '">' +
                    nameCell(claim, colour) + communityCell(claim) + keyCell(claim) +
                    '<td data-label="Requested" class="mono" style="font-size: 0.75rem;">' + date + heldLine(claim) + '</td>' +
                    '<td><div class="acts">' +
                        '<button data-name="' + esc(claim.name) + '" data-action="' + act[0] + '" class="btn-approve">' + act[1] + '</button>' +
                        '<button data-name="' + esc(claim.name) + '" data-action="release" data-free-now="1" class="btn-revoke" title="Rejects the claim; the name is free again">Reject</button>' +
                    '</div></td>' +
                '</tr>';
            });

            html += '</tbody></table>';
            container.innerHTML = html;
        }

        // The head and cells every names table shares (pending, held, released): state names its fourth column. The
        // domain may break before ".beanpool.org"; a key is shown short, in full on hover.
        // Why a held name waits, and where it came from (its network; its source shown short, never an address).
        function heldLine(a) {
            const src = a.source || null;
            const from = src ? (src.asn ? 'AS' + esc(src.asn) + (src.as_org ? ' ' + esc(src.as_org) : '') + (src.country ? ' (' + esc(src.country) + ')' : '') : '') + (src.id ? ' · source ' + esc(String(src.id).slice(0, 8)) : '') : '';
            if (!a.held_reason && !from) return '';
            return '<span class="sub">' + (a.held_reason ? 'held: ' + esc(HELD_WORDS[a.held_reason] || a.held_reason) : '') + (a.held_reason && from ? ' · ' : '') + from + '</span>';
        }

        function namesHead(state) {
            return '<table class="admin-table stack"><thead><tr><th class="w-name">Name</th><th class="w-comm">Community / Operator</th>' +
                '<th class="w-key">Key</th><th class="w-state">' + state + '</th><th class="w-act act">Action</th></tr></thead><tbody>';
        }
        function nameCell(a, colour) {
            const modeClass = a.mode === 'direct' ? 'badge-direct' : 'badge-tunnel';
            return '<td><span class="domain" style="color: ' + colour + ';">' + esc(a.name) + '<wbr>.beanpool.org</span>' +
                ' <span class="badge-mode ' + modeClass + '">' + esc(a.mode || 'tunnel') + '</span></td>';
        }
        function communityCell(a) {
            return '<td data-label="Community"><span style="font-weight: 600; color: #fff;">' + (a.community_name ? esc(a.community_name) : '—') + '</span>' +
                (a.contact ? '<span class="sub">' + esc(a.contact) + '</span>' : '') + '</td>';
        }
        function keyCell(a) {
            const k = a.node_pubkey ? esc(a.node_pubkey.slice(0, 8) + '…') : '—';
            return '<td data-label="Key" class="mono" style="font-size: 0.75rem;" title="' + esc(a.node_pubkey || '') + '">' + k + '</td>';
        }
        const when = function(s) { return s ? new Date(s * 1000).toLocaleString() : 'never'; };

        const LOOK = {
            live: ['🟢', '#10b981'], paused: ['⏸️', '#fbbf24'], blocked: ['⛔', '#f87171'], released: ['↩️', '#94a3b8'],
        };
        // Every held state can be released (its "free now" box frees it at once); the Worker refuses what doesn't apply.
        const ACTIONS = {
            live: [['pause', 'Pause'], ['block', 'Block']],
            paused: [['resume', 'Resume'], ['block', 'Block'], ['release', 'Release']],
            blocked: [['resume', 'Resume'], ['release', 'Release']],
        };
        // The released names nobody holds, as last drawn: what "Remove all released" removes. Every released name, as
        // last drawn: what "Free all and remove" frees and removes; of those, how many are still inside their hold, and how
        // many of those are held from the key the admin had blocked or paused ('admin-held-all'), which that key can claim
        // again once freed. Its confirm says both.
        let removable = [];
        let releasedNames = [];
        let releasedHeld = 0;
        let releasedHeldFromAll = 0;

        function renderActive(active) {
            const container = document.getElementById('activeTableContainer');
            const before = container.querySelector ? container.querySelector('details.released') : null;
            const wasOpen = !!(before && before.open);
            const held = active.filter(function(a) { return a.status !== 'released'; });
            const released = active.filter(function(a) { return a.status === 'released'; });
            // A release the Worker says still holds (holds, held_until) keeps "Free now", as does one past its hold that its
            // old key can still take back (takes_back); one neither can be removed. A row that doesn't say whether it holds
            // is treated as held: nothing is offered for removal that the Worker didn't call free. (The Worker refuses the
            // rest anyway: forgetRow.)
            const takesBack = function(a) { return a.holds === false && !!a.takes_back; };
            removable = released.filter(function(a) { return a.holds === false && !a.takes_back; }).map(function(a) { return a.name; });
            releasedNames = released.map(function(a) { return a.name; });
            const stillHeld = released.filter(function(a) { return a.holds !== false; });
            releasedHeld = stillHeld.length;
            releasedHeldFromAll = stillHeld.filter(function(a) { return a.pause_reason === 'admin-held-all'; }).length;
            const back = released.filter(takesBack).length;

            let html = held.length ? namesTable(held) : '<p style="color: var(--text-muted); font-size: 0.85rem;">No names held now.</p>';
            if (released.length) {
                const stay = released.length - removable.length - back;
                html += '<div class="released-head">' +
                    (removable.length ? '<button data-forget-all="1" class="btn-revoke">Remove all released (' + removable.length + ')</button>' : '') +
                    '<button data-free-all="1" class="btn-revoke" title="Frees every released name now, as its Free now does — its old server can no longer take it back — then removes it from the list">Free all and remove (' + released.length + ')</button>' +
                    '<span>' + (removable.length ? 'Removes the released names nobody holds: each stays free to anyone.' : '') +
                        (stay ? ' ' + stay + ' still held ' + (stay === 1 ? 'stays until its hold ends' : 'stay until their hold ends') + ' (or "Free now").' : '') +
                        (back ? ' ' + back + (back === 1 ? ' stays while the key that released it can take it back' : ' stay while the keys that released them can take them back') + ' ("Free now" ends that).' : '') + '</span></div>';
                html += '<details class="released"' + (wasOpen ? ' open' : '') + '><summary>Released (' + released.length + ')</summary>' + releasedTable(released) + '</details>';
            }
            container.innerHTML = html;
        }

        function namesTable(rows) {
            let html = namesHead('Status');
            rows.forEach(function(alloc) {
                const look = LOOK[alloc.status] || ['•', '#cbd5e1'];
                const why = alloc.pause_reason ? ' · ' + esc(alloc.pause_reason) : '';
                const since = alloc.paused_at;
                const acts = ACTIONS[alloc.status] || [['block', 'Block'], ['release', 'Release']];
                // Released after you blocked or paused it, the name is held from its own key too (the Worker's rule).
                const fromAll = alloc.status === 'blocked' || (alloc.status === 'paused' && alloc.pause_reason === 'admin');
                html += '<tr id="row-' + esc(alloc.name) + '">' +
                    nameCell(alloc, look[1]) + communityCell(alloc) + keyCell(alloc) +
                    '<td data-label="Status"><span class="mono" style="color: ' + look[1] + '; font-weight: 600; font-size: 0.75rem;">' + look[0] + ' ' + esc(alloc.status) + why + '</span>' +
                        (since ? '<span class="sub">since ' + when(since) + '</span>' : '') +
                        (alloc.probation ? '<span class="sub">on probation: not yet in the directory</span>' : '') + '</td>' +
                    '<td><div class="acts">' + acts.map(function(a) {
                        const button = '<button data-name="' + esc(alloc.name) + '" data-action="' + a[0] + '"' + (a[0] === 'release' && fromAll ? ' data-held-from-all="1"' : '') +
                            ' class="' + (a[0] === 'resume' ? 'btn-approve' : 'btn-revoke') + '">' + a[1] + '</button>';
                        if (a[0] !== 'release') return button;
                        // Release holds the name 30 days (for its key, or from every key) unless its "free now" box is ticked.
                        return '<span class="pair"><label title="Free the name at once, to any key, instead of holding it 30 days">' +
                            '<input type="checkbox" data-free-now-for="' + esc(alloc.name) + '"> free now</label>' + button + '</span>';
                    }).join('') + '</div></td>' +
                '</tr>';
            });
            return html + '</tbody></table>';
        }

        function releasedTable(rows) {
            let html = namesHead('Released');
            rows.forEach(function(alloc) {
                const free = alloc.holds === false;
                const back = free && !!alloc.takes_back;
                const hold = back ? 'free to others; its key can take it back'
                    : free ? 'free to anyone'
                    : alloc.held_until ? (alloc.pause_reason === 'admin-held-all' ? 'held from every key until ' : 'held for its key until ') + when(alloc.held_until)
                    : 'held';
                // A held release: "Free now" frees it at once; one its key can still take back: "Free now" ends that. One
                // nobody holds or can take back: "Remove from the list".
                const act = free && !back
                    ? '<button data-name="' + esc(alloc.name) + '" data-action="forget" class="btn-revoke" title="Nobody holds it: it leaves this list and stays free to anyone">Remove from the list</button>'
                    : '<button data-name="' + esc(alloc.name) + '" data-action="release" data-free-now="1"' + (back ? ' data-takes-back="1"' : '') + ' class="btn-revoke">Free now</button>';
                html += '<tr id="row-' + esc(alloc.name) + '">' +
                    nameCell(alloc, LOOK.released[1]) + communityCell(alloc) + keyCell(alloc) +
                    '<td data-label="Released"><span class="mono" style="font-size: 0.75rem;">' + LOOK.released[0] + ' ' + esc(alloc.pause_reason || 'released') + '</span>' +
                        '<span class="sub">' + (alloc.released_at ? when(alloc.released_at) + ' · ' : '') + hold + '</span></td>' +
                    '<td><div class="acts">' + act + '</div></td>' +
                '</tr>';
            });
            return html + '</tbody></table>';
        }

        // Remove all released: the names nobody holds, as last drawn, in batches the Worker takes (5 a request).
        const FORGET_BATCH = 5;
        async function forgetAllReleased() {
            const names = removable.slice();
            if (!names.length) return;
            if (!confirm('Remove ' + names.length + ' released name' + (names.length === 1 ? '' : 's') + ' nobody holds from the list?\\n\\nEach stays free to anyone, as it is now. Anything Cloudflare still has for one is deleted. Their history stays under Name events.')) return;
            const removed = [];
            const refused = [];
            const already = [];
            try {
                for (let i = 0; i < names.length; i += FORGET_BATCH) {
                    const batch = names.slice(i, i + FORGET_BATCH);
                    const res = await fetch('/api/local/admin/registrar/forget', {
                        method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
                        body: JSON.stringify({ names: batch }),
                    });
                    const data = await res.json();
                    if (!res.ok) { refused.push({ name: batch.join(', '), error: data.error || String(res.status) }); continue; }
                    removed.push.apply(removed, data.removed || []);
                    refused.push.apply(refused, data.refused || []);
                    already.push.apply(already, data.already || []);
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
            // Removed by another tab (or an earlier click) is not counted as removed by this one.
            alert('Removed ' + removed.length + ' from the list.' + (already.length ? '\\n\\nAlready removed: ' + already.join(', ') : '') + (refused.length ? '\\n\\nNot removed:\\n' + refused.map(function(r) { return r.name + ': ' + (r.error || r.status); }).join('\\n') : ''));
            loadRegistrarData();
        }

        // Free all and remove: every released name, as last drawn — each freed now, as its own Free now frees it (its old
        // server can no longer take it back), then removed — in batches the Worker takes (2 a request: FREE_FORGET_MAX).
        // The Worker refuses any name that is no longer released, untouched.
        const FREE_FORGET_BATCH = 2;
        async function freeAllAndRemove() {
            const names = releasedNames.slice();
            if (!names.length) return;
            // A name still inside its hold is freed at once, to any key; one held from the key the admin had stopped
            // ('admin-held-all') goes back to that key too, as its own "Free now" says ("FREE AT ONCE, to any key").
            const held = releasedHeld;
            const fromAll = releasedHeldFromAll;
            const holdNote = held ? '\\n\\n' + (held === 1 ? '1 is still inside its hold: it is freed at once, to any key.' : held + ' are still inside their hold: they are freed at once, to any key.') : '';
            const fromAllNote = fromAll ? ' ⚠️ ' + (fromAll === 1
                ? '1 of those is held from the key you blocked or paused: that key can claim it again at once. Cancel to keep that key off it until its hold ends.'
                : fromAll + ' of those are held from the keys you blocked or paused: those keys can claim them again at once. Cancel to keep those keys off them until their holds end.') : '';
            if (!confirm('Free and remove ' + names.length + ' released name' + (names.length === 1 ? '' : 's') + '? Their old servers can no longer take them back.' + holdNote + fromAllNote)) return;
            // One id for this click: the Worker tells your phone of it once, not of every batch.
            const run = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
            const removed = [];
            const refused = [];
            const already = [];
            try {
                for (let i = 0; i < names.length; i += FREE_FORGET_BATCH) {
                    const batch = names.slice(i, i + FREE_FORGET_BATCH);
                    const res = await fetch('/api/local/admin/registrar/forget', {
                        method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
                        body: JSON.stringify({ names: batch, free_now: true, run: run, total: names.length }),
                    });
                    const data = await res.json();
                    if (!res.ok) { refused.push({ name: batch.join(', '), error: data.error || String(res.status) }); continue; }
                    removed.push.apply(removed, data.removed || []);
                    refused.push.apply(refused, data.refused || []);
                    already.push.apply(already, data.already || []);
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
            alert('Freed and removed ' + removed.length + '.' + (already.length ? '\\n\\nAlready removed: ' + already.join(', ') : '') + (refused.length ? '\\n\\nNot removed:\\n' + refused.map(function(r) { return r.name + ': ' + (r.error || r.status); }).join('\\n') : ''));
            loadRegistrarData();
        }

        async function adminAction(name, action, target) {
            // A release frees the name at once only when its button says so (Free now, Reject) or its box is ticked.
            const box = document.querySelector('input[data-free-now-for="' + name + '"]');
            const freeNow = action === 'release' && ((!!target && target.getAttribute('data-free-now') === '1') || (!!box && box.checked));
            const fromAll = !!target && target.getAttribute('data-held-from-all') === '1';
            const takesBack = !!target && target.getAttribute('data-takes-back') === '1';
            if (!CONFIRM[action] || !confirm(CONFIRM[action](name, freeNow, fromAll, takesBack))) return;

            try {
                const init = { method: 'POST', headers: authHeaders() };
                if (action === 'release') {
                    init.headers['content-type'] = 'application/json';
                    init.body = JSON.stringify({ free_now: freeNow });
                }
                const res = await fetch('/api/local/admin/registrar/' + encodeURIComponent(name) + '/' + (action === 'finish' ? 'approve' : action), init);
                const data = await res.json();
                if (res.ok && action === 'forget') {
                    loadRegistrarData();
                } else if (res.ok) {
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

        async function loadEvents() {
            const container = document.getElementById('eventsTableContainer');
            try {
                const res = await fetch('/api/local/admin/registrar/events?limit=100', { headers: authHeaders() });
                if (!res.ok) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Could not load events.</p>'; return; }
                const events = (await res.json()).events || [];
                if (events.length === 0) { container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No events yet.</p>'; return; }
                let html = '<table class="admin-table stack"><thead><tr><th class="w-when">When</th><th class="w-ev-name">Name</th><th class="w-event">Event</th><th class="w-detail">Detail</th></tr></thead><tbody>';
                events.forEach(function(ev) {
                    // incident-review rows are the ones waiting for a human decision.
                    const colour = ev.event === 'incident-review' ? '#fbbf24' : 'var(--text-secondary)';
                    html += '<tr>' +
                        '<td class="mono" style="font-size: 0.75rem;">' + new Date(ev.at * 1000).toLocaleString() + '</td>' +
                        '<td data-label="Name" class="mono">' + esc(ev.name) + '</td>' +
                        '<td data-label="Event" style="color: ' + colour + '; font-weight: 600;">' + esc(ev.event) + '</td>' +
                        '<td data-label="Detail" style="font-size: 0.8rem;">' + esc(ev.detail) + '</td>' +
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
            // A released name's row is in the collapsed "Released" section: opened first.
            const section = typeof row.closest === 'function' ? row.closest('details') : null;
            if (section) section.open = true;
            row.className = 'lit';
            row.scrollIntoView({ block: 'center' });
        }
        if (typeof window !== 'undefined') window.addEventListener('hashchange', showFragment);

        const CATEGORY_WORDS = {
            names: 'Names (requests, new communities, pauses)', health: 'Health (our servers, suspended sweep, refused deletions)',
            uptake: 'Uptake', admin: 'Your own actions',
        };
        const MODE_WORDS = { on: 'on', digest: 'digest', off: 'off' };

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
            const dns = st.dns_records;
            if (dns) {
                if (dns.count != null) {
                    html += '<p style="font-size: 0.8rem; color: ' + (dns.pct >= (st.dns_alert_pct || 80) ? '#fbbf24' : 'var(--text-muted)') + ';">DNS records: <b>' + esc(dns.count) + '</b> of ' + esc(dns.cap) + ' (' + esc(dns.pct) + '%)' + (dns.checked_at ? ' · checked ' + esc(when(dns.checked_at)) : '') + '.</p>';
                } else if (dns.error) {
                    html += '<p style="font-size: 0.8rem; color: #f87171;">DNS records: couldn\'t count (' + esc(dns.error) + ')' + (dns.checked_at ? ' · checked ' + esc(when(dns.checked_at)) : '') + '.</p>';
                }
            }
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

        async function loadAlerts() {
            const container = document.getElementById('alertsContainer');
            try {
                const res = await fetch('/api/local/admin/registrar/alerts', { headers: authHeaders() });
                if (!res.ok) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Could not load alerts.</p>'; return; }
                renderAlerts(await res.json());
            } catch (err) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading alerts.</p>';
            }
        }

        async function setAlertMode(category, mode) {
            const res = await fetch('/api/local/admin/registrar/alerts/settings', {
                method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ category: category, mode: mode }),
            });
            if (res.ok) renderAlerts(await res.json());
            else alert('Could not change it: ' + ((await res.json()).error || res.status));
        }

        async function sendTestAlert() {
            const out = document.getElementById('alertTestResult');
            out.textContent = 'Sending...';
            try {
                const res = await fetch('/api/local/admin/registrar/alerts/test', { method: 'POST', headers: authHeaders() });
                const data = await res.json();
                out.textContent = data.sent ? 'Sent (' + data.status + '): check your phone.' : (data.error || 'Not sent.');
                loadAlerts();
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

        async function loadServers() {
            const container = document.getElementById('serversContainer');
            try {
                const res = await fetch('/api/local/admin/registrar/servers', { headers: authHeaders() });
                if (!res.ok) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Could not load servers.</p>'; return; }
                renderServers(await res.json());
            } catch (err) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading servers.</p>';
            }
        }

        // New names, last 24 h (GET /sources): the hold switch, the names against the DNS capacity, the groups by source
        // (Reject all held, Block all), the networks, the blocks, and the live settings. Never an address: a source is
        // its keyed hash, shown short.
        const HELD_WORDS = { source: 'many from one source', budget: 'the new-name budget', 'hold-all': 'Hold all new names', 'near-full': 'the DNS zone near full' };
        const shortId = function(id) { return id ? String(id).slice(0, 8) : ''; };
        const networkWords = function(g) {
            return g.asn ? 'AS' + esc(g.asn) + (g.as_org ? ' ' + esc(g.as_org) : '') + (g.country ? ' (' + esc(g.country) + ')' : '') : 'network unknown';
        };
        const STATUS_ICON = { pending: '⏳', live: '🟢', paused: '⏸️', blocked: '⛔', released: '↩️', abandoned: '·', gone: '·' };

        function renderSources(st) {
            const container = document.getElementById('sourcesContainer');
            if (!st || st.schema === false) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">' + esc((st && st.error) || 'Could not load new names.') + '</p>';
                return;
            }
            let html = '';
            const hold = st.hold || {};
            html += hold.on
                ? '<div class="row-wrap" style="margin-bottom: 0.75rem;"><span style="color: #fbbf24; font-weight: 700; font-size: 0.85rem;">⏸️ Hold all new names is ON until ' + esc(when(hold.until)) + ': every new name waits for your approval.</span>' +
                    '<button data-hold="0" class="btn-approve">Let go now</button></div>'
                : '<div class="row-wrap" style="margin-bottom: 0.75rem;"><button data-hold="1" class="btn-revoke">⏸️ Hold all new names (24 h)</button>' +
                    '<span style="font-size: 0.75rem; color: var(--text-muted);">Every new name then waits for your approval; names already held are untouched. It lets go by itself after 24 hours.</span></div>';
            if (!st.source_key_set) html += '<p style="color: #fbbf24; font-size: 0.8rem; margin-bottom: 0.5rem;">SOURCE_KEY is not set: claims have no source, so no per-source limit applies and nothing groups by source. Set it with <code>wrangler secret put SOURCE_KEY</code> (32 random bytes, hex).</p>';
            const cap = st.capacity || {};
            html += '<p style="font-size: 0.8rem; color: ' + (cap.names >= cap.alert_at ? '#fbbf24' : 'var(--text-secondary)') + '; margin-bottom: 0.75rem;">Names on the zone (live, or being made): <b>' + esc(cap.names) + '</b> of its ' + esc(cap.capacity) +
                ' DNS records (you are told from ' + esc(cap.alert_at) + '; from ' + esc(cap.hold_at) + ' every new name waits for you). Our own hand records count too.</p>';
            const groups = st.groups || [];
            if (!groups.length) html += '<p style="color: var(--text-muted); font-size: 0.85rem;">No new names in the last 24 hours.</p>';
            else {
                html += '<table class="admin-table stack"><thead><tr><th class="w-src">Source</th><th class="w-net">Network</th><th class="w-cnt">Names</th><th class="w-seen">When</th><th class="w-sact act">Action</th></tr></thead><tbody>';
                groups.forEach(function(g) {
                    const names = (g.rows || []).slice(0, 12).map(function(r) {
                        return (STATUS_ICON[r.status] || '·') + ' ' + esc(r.name) + (r.held_reason ? ' (held)' : '') + (r.probation ? ' (probation)' : '');
                    }).join(', ') + ((g.rows || []).length > 12 ? ', …' : '');
                    let acts = '';
                    if (g.held && (g.source || g.asn)) acts += '<button data-source-act="reject"' + (g.source ? ' data-source="' + esc(g.source) + '"' : ' data-asn="' + esc(g.asn) + '"') + ' data-total="' + esc(g.held) + '" class="btn-approve" title="Each held name from it is rejected: free again">Reject all held (' + esc(g.held) + ')</button>';
                    if (g.source) acts += '<button data-source-act="block" data-source="' + esc(g.source) + '" data-total="' + esc(g.names) + '" class="btn-revoke" title="Pending ones rejected (held, awaiting approval or being set up), live ones blocked, its new claims refused for 7 days">Block all (' + esc(g.names) + ')</button>';
                    // A notice to the group (Notices below): its names held now, blocked ones too — say why they were blocked.
                    if (g.source || g.asn) acts += '<button data-notice-group="1"' + (g.source ? ' data-source="' + esc(g.source) + '"' : ' data-asn="' + esc(g.asn) + '"') + ' data-label="' + (g.source ? 'source ' + esc(shortId(g.source)) : 'network AS' + esc(g.asn)) + '" class="btn-approve" title="Write to the names of this group (Notices to operators, below)">Notice</button>';
                    html += '<tr>' +
                        '<td data-label="Source"><span class="mono" style="color: #fff;">' + (g.source ? esc(shortId(g.source)) : 'no source') + '</span><span class="sub">' + names + '</span></td>' +
                        '<td data-label="Network" style="font-size: 0.8rem;"><span>' + networkWords(g) + '</span></td>' +
                        '<td data-label="Names" style="font-size: 0.8rem;"><span>' + esc(g.names) + (g.held ? ' · <b style="color: #fbbf24;">' + esc(g.held) + ' held</b>' : '') + ' · ' + esc(g.live) + ' live (' + esc(g.verified) + ' verified) · ' + esc(g.keys) + ' key' + (g.keys === 1 ? '' : 's') + '</span></td>' +
                        '<td data-label="When" class="mono" style="font-size: 0.7rem;">' + esc(when(g.first)) + (g.last !== g.first ? '<span class="sub">to ' + esc(when(g.last)) + '</span>' : '') + '</td>' +
                        '<td><div class="acts">' + acts + '</div></td></tr>';
                });
                html += '</tbody></table>';
            }
            const networks = (st.networks || []).slice(0, 10);
            if (networks.length) html += '<p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 1rem;">By network: ' + networks.map(function(n) {
                return networkWords(n) + ': ' + esc(n.names) + ' from ' + esc(n.sources) + ' source' + (n.sources === 1 ? '' : 's');
            }).join(' · ') + '</p>';
            const blocked = st.blocked || [];
            html += '<p style="font-size: 0.85rem; color: #f87171; margin-top: 1rem;">Blocked now' + (blocked.length ? '' : ': none') + '</p>';
            if (blocked.length) html += '<ul style="font-size: 0.8rem; margin-left: 1.25rem;">' + blocked.map(function(b) {
                return '<li>' + (b.kind === 'asn' ? 'network AS' + esc(b.value) : 'source <span class="mono">' + esc(shortId(b.value)) + '</span>') + (b.label ? ' — ' + esc(b.label) : '') +
                    ' · until ' + esc(when(b.until)) + (b.by ? ' · by ' + esc(b.by) : '') + ' <button data-unblock-kind="' + esc(b.kind) + '" data-unblock-value="' + esc(b.value) + '" class="btn-approve">Lift</button></li>';
            }).join('') + '</ul>';
            html += '<div class="row-wrap" style="margin-top: 0.5rem;"><input id="blockAsnInput" class="admin-input" inputmode="numeric" placeholder="ASN, e.g. 14061" autocomplete="off">' +
                '<button data-block-asn="1" class="btn-revoke" title="Every new name from that network is refused, honest ones too">Block a network (7 days)</button></div>';
            const rows = st.settings || [];
            if (rows.length) {
                html += '<details class="released" style="margin-top: 1rem;"><summary>Limits (live settings: kept here, never in the public code)</summary>' +
                    '<table class="admin-table stack"><thead><tr><th class="w-setting">Setting</th><th class="w-now">Now</th><th class="w-change act">Change</th></tr></thead><tbody>' + rows.map(function(r) {
                        return '<tr><td data-label="Setting"><span class="mono" style="color: #fff;">' + esc(r.key) + '</span><span class="sub">' + esc(r.words) + '</span></td>' +
                            '<td data-label="Now" class="mono">' + esc(r.value) + '<span class="sub">' + (r.set ? 'set ' + esc(when(r.set.at)) + (r.set.by ? ' by ' + esc(r.set.by) : '') : 'default') + ' · default ' + esc(r.default) + '</span></td>' +
                            '<td><div class="acts"><input id="set-' + esc(r.key) + '" class="admin-input" style="width: 7rem; flex: 0 0 auto;" inputmode="numeric" placeholder="' + esc(r.min) + '–' + esc(r.max) + '" autocomplete="off">' +
                            '<button data-setting-save="' + esc(r.key) + '" class="btn-approve">Save</button>' +
                            (r.set ? '<button data-setting-default="' + esc(r.key) + '" class="btn-revoke">Default</button>' : '') + '</div></td></tr>';
                    }).join('') + '</tbody></table></details>';
            }
            container.innerHTML = html;
        }

        async function loadSources() {
            const container = document.getElementById('sourcesContainer');
            try {
                const res = await fetch('/api/local/admin/registrar/sources', { headers: authHeaders() });
                if (!res.ok) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Could not load new names.</p>'; return; }
                renderSources(await res.json());
            } catch (err) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading new names.</p>';
            }
        }

        async function postAdmin(path, body) {
            const res = await fetch('/api/local/admin/registrar/' + path, { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
            return { ok: res.ok, status: res.status, data: await res.json() };
        }

        // Reject all held, or Block all, on a group: in the Worker's batches (3 names a request) until it says no more,
        // or a batch did nothing. One run id: your phone hears of the click once.
        async function sourceAction(act, source, asn, total) {
            const block = act === 'block';
            const n = total + ' name' + (total === 1 ? '' : 's');
            const text = block
                ? '⛔ BLOCK ALL from this source (' + n + ')?\\n\\nEach pending name (held, awaiting approval or being set up) is rejected (free again), each live one is blocked (tunnel and DNS deleted, the name kept from every key; Resume undoes one), and its new claims are refused for 7 days.'
                : 'Reject all held names from this group (' + n + ')?\\n\\nEach is freed again; its live names, its claims awaiting approval and its names being set up are left as they are.';
            if (!confirm(text)) return;
            const run = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
            const body = { run: run, total: total };
            if (source) body.source = source; else body.asn = Number(asn);
            if (block) body.block = true;
            const done = { rejected: [], blocked: [], refused: [] };
            try {
                for (let i = 0; i < 100; i++) {
                    const r = await postAdmin('sources', body);
                    if (!r.ok) { done.refused.push({ name: '(the request)', error: r.data.error || String(r.status) }); break; }
                    done.rejected.push.apply(done.rejected, r.data.rejected || []);
                    done.blocked.push.apply(done.blocked, r.data.blocked || []);
                    done.refused.push.apply(done.refused, r.data.refused || []);
                    if (!r.data.more) break;
                }
            } catch (err) {
                alert('Network error: ' + err.message);
            }
            alert((block ? 'Blocked ' + done.blocked.length + ', rejected ' + done.rejected.length + '.' : 'Rejected ' + done.rejected.length + '.') +
                (done.refused.length ? '\\n\\nNot done:\\n' + done.refused.map(function(r) { return r.name + ': ' + (r.error || r.status); }).join('\\n') : ''));
            loadRegistrarData();
        }

        async function sourcesClick(e) {
            const hold = e.target.closest('[data-hold]');
            if (hold) {
                const on = hold.getAttribute('data-hold') === '1';
                if (!confirm(on ? 'Hold all new names for 24 hours?\\n\\nEvery new name then waits for your approval; names already held are untouched. It lets go by itself after 24 hours.' : 'Let go of Hold all new names now?')) return;
                const r = await postAdmin('settings', { hold: on });
                if (r.ok) renderSources(r.data); else alert('Could not change it: ' + (r.data.error || r.status));
                return;
            }
            const act = e.target.closest('[data-source-act]');
            if (act) { await sourceAction(act.getAttribute('data-source-act'), act.getAttribute('data-source'), act.getAttribute('data-asn'), Number(act.getAttribute('data-total')) || 0); return; }
            const lift = e.target.closest('[data-unblock-kind]');
            if (lift) {
                if (!confirm('Lift this block? Its new claims are taken again.')) return;
                const r = await postAdmin('blocked', { kind: lift.getAttribute('data-unblock-kind'), value: lift.getAttribute('data-unblock-value'), remove: true });
                if (!r.ok) alert('Could not lift it: ' + (r.data.error || r.status));
                loadSources();
                return;
            }
            if (e.target.closest('[data-block-asn]')) {
                const asn = Number(String(document.getElementById('blockAsnInput').value || '').replace(/^AS/i, '').trim());
                if (!(asn > 0)) { alert('Type the number of the network (its ASN), as the list above shows it.'); return; }
                if (!confirm('Block every new name from network AS' + asn + ' for 7 days?\\n\\nHonest nodes on that network are refused too: a hosting network carries many. Names already held are untouched.')) return;
                const r = await postAdmin('blocked', { kind: 'asn', value: asn, days: 7 });
                if (!r.ok) alert('Could not block it: ' + (r.data.error || r.status));
                loadSources();
                return;
            }
            const save = e.target.closest('[data-setting-save]');
            const reset = e.target.closest('[data-setting-default]');
            if (save || reset) {
                const key = (save || reset).getAttribute(save ? 'data-setting-save' : 'data-setting-default');
                const value = save ? String(document.getElementById('set-' + key).value || '').trim() : null;
                if (save && !value) return;
                if (save && !/^\\d+$/.test(value)) { alert('Not saved: type a whole number, digits only (no commas, spaces or letters).'); return; }
                const r = await postAdmin('settings', save ? { key: key, value: Number(value) } : { key: key, reset: true });
                if (r.ok) renderSources(r.data); else alert('Not saved: ' + (r.data.error || r.status));
            }
        }
        document.addEventListener('click', function(e) { sourcesClick(e); });

        // Notices to operators (GET/POST /notices; index.js handleNoticeSend): the form, then the latest with how far each
        // got. A group picked from "New names, last 24 h" (its Notice button) is kept here until sent or cleared.
        let noticeGroup = null;   // { source } | { asn }, with its label
        const LEVEL_WORDS = { info: 'ℹ️ info', warning: '⚠️ warning', action: '❗ action needed' };
        function renderNotices(st) {
            const container = document.getElementById('noticesContainer');
            if (!st || st.schema === false) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">' + esc((st && st.error) || 'Could not load notices.') + '</p>';
                return;
            }
            const max = st.text_max || 500;
            let html = '<div class="row-wrap" style="margin-bottom: 0.5rem;">' +
                '<select id="noticeTo" class="admin-input" style="flex: 0 0 auto; width: auto;">' +
                (noticeGroup ? '<option value="group" selected>To ' + esc(noticeGroup.label) + '</option>' : '') +
                '<option value="names"' + (noticeGroup ? '' : ' selected') + '>To names</option><option value="all">To every name</option></select>' +
                '<input id="noticeNames" class="admin-input" placeholder="a name, or names separated by commas (at most ' + esc(st.names_max || 50) + ')" autocomplete="off">' +
                (noticeGroup ? '<button data-notice-clear="1" class="btn-revoke">Clear group</button>' : '') + '</div>' +
                '<textarea id="noticeText" class="admin-input" rows="4" maxlength="' + esc(max) + '" placeholder="What to tell them, at most ' + esc(max) + ' characters. The node shows it as written."></textarea>' +
                '<div class="row-wrap" style="margin-top: 0.5rem;">' +
                '<select id="noticeLevel" class="admin-input" style="flex: 0 0 auto; width: auto;"><option value="info">' + LEVEL_WORDS.info + '</option><option value="warning">' + LEVEL_WORDS.warning + '</option><option value="action">' + LEVEL_WORDS.action + '</option></select>' +
                '<label style="font-size: 0.8rem; color: var(--text-secondary); display: inline-flex; gap: 0.3rem; align-items: center;"><input type="checkbox" id="noticeReply"' + (st.reply_links ? '' : ' disabled') + '> with a reply link</label>' +
                '<label style="font-size: 0.8rem; color: var(--text-secondary); display: inline-flex; gap: 0.3rem; align-items: center;">for <input id="noticeDays" class="admin-input" style="width: 4.5rem; flex: 0 0 auto; padding: 0.4rem;" inputmode="numeric" value="' + esc((st.days && st.days.def) || 14) + '"> days</label>' +
                '<button data-notice-send="1" class="btn-approve">Send notice</button></div>';
            if (!st.reply_links) html += '<p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.4rem;">Reply links are off: REPLY_URL is not set (wrangler.toml), so nothing could answer them yet.</p>';
            const list = st.notices || [];
            if (!list.length) html += '<p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 1rem;">No notices sent yet.</p>';
            else {
                html += '<table class="admin-table stack" style="margin-top: 1rem;"><thead><tr><th class="w-notice">Notice</th><th class="w-to">To</th><th class="w-reach">Reached</th><th class="w-nact act">Who</th></tr></thead><tbody>';
                list.forEach(function(n) {
                    const over = n.expires_at <= Math.floor(Date.now() / 1000);
                    html += '<tr>' +
                        '<td data-label="Notice"><span class="notice-text">' + esc(n.text) + '</span><span class="sub">#' + esc(n.id) + ' · ' + (LEVEL_WORDS[n.level] || esc(n.level)) + ' · ' + esc(when(n.at)) + (n.by ? ' · by ' + esc(n.by) : '') + (n.reply ? ' · with a reply link' : '') + '</span></td>' +
                        '<td data-label="To" style="font-size: 0.8rem;"><span>' + esc(n.audience) + '</span></td>' +
                        '<td data-label="Reached" style="font-size: 0.8rem;"><span>' + esc(n.seen) + ' of ' + esc(n.recipients) + ' have it' + (n.delivered > n.seen ? ' (' + esc(n.delivered - n.seen) + ' more sent)' : '') + (n.replies ? ' · <b style="color: #a3e635;">' + esc(n.replies) + ' repl' + (n.replies === 1 ? 'y' : 'ies') + '</b>' : '') + '</span><span class="sub">' + (over ? 'no longer sent' : 'sent until ' + esc(when(n.expires_at))) + '</span></td>' +
                        '<td><div class="acts"><button data-notice-who="' + esc(n.id) + '" class="btn-approve">Who</button></div></td></tr>' +
                        '<tr id="notice-who-' + esc(n.id) + '" style="display: none;"><td colspan="4" style="font-size: 0.8rem;"></td></tr>';
                });
                html += '</tbody></table>';
            }
            container.innerHTML = html;
        }

        async function loadNotices() {
            const container = document.getElementById('noticesContainer');
            try {
                const res = await fetch('/api/local/admin/registrar/notices', { headers: authHeaders() });
                if (!res.ok) { container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Could not load notices.</p>'; return; }
                renderNotices(await res.json());
            } catch (err) {
                container.innerHTML = '<p style="color: #f87171; font-size: 0.85rem;">Error loading notices.</p>';
            }
        }

        async function noticesClick(e) {
            const group = e.target.closest('[data-notice-group]');
            if (group) {
                noticeGroup = group.getAttribute('data-source') ? { source: group.getAttribute('data-source') } : { asn: Number(group.getAttribute('data-asn')) };
                noticeGroup.label = group.getAttribute('data-label') || 'that group';
                await loadNotices();
                const card = document.getElementById('noticesContainer');
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            if (e.target.closest('[data-notice-clear]')) { noticeGroup = null; loadNotices(); return; }
            const who = e.target.closest('[data-notice-who]');
            if (who) {
                const id = who.getAttribute('data-notice-who');
                const row = document.getElementById('notice-who-' + id);
                if (!row) return;
                if (row.style.display !== 'none') { row.style.display = 'none'; return; }
                row.style.display = '';
                row.firstChild.textContent = 'Loading...';
                try {
                    const res = await fetch('/api/local/admin/registrar/notices?id=' + encodeURIComponent(id), { headers: authHeaders() });
                    const d = await res.json();
                    const rs = d.recipients || [];
                    row.firstChild.innerHTML = rs.length ? rs.map(function(r) {
                        return '<b style="color: #fff;">' + esc(r.name) + '</b> ' + (r.seen_at ? 'has it (' + esc(when(r.seen_at)) + ')' : r.delivered_at ? 'sent ' + esc(when(r.delivered_at)) + ', not yet seen' : 'not yet checked in') + (r.replied_at ? ', <b style="color: #a3e635;">replied</b>' : '');
                    }).join(' · ') : 'Nobody.';
                } catch (err) {
                    row.firstChild.textContent = 'Could not load who it went to.';
                }
                return;
            }
            if (!e.target.closest('[data-notice-send]')) return;
            const toKind = document.getElementById('noticeTo').value;
            const text = String(document.getElementById('noticeText').value || '').trim();
            const level = document.getElementById('noticeLevel').value;
            const reply = document.getElementById('noticeReply').checked;
            const days = Number(String(document.getElementById('noticeDays').value || '').trim());
            if (!text) { alert('Write what to tell them first.'); return; }
            let to;
            let whom;
            if (toKind === 'group' && noticeGroup) { to = noticeGroup.source ? { source: noticeGroup.source } : { asn: noticeGroup.asn }; whom = 'the names of ' + noticeGroup.label; }
            else if (toKind === 'all') { to = { all: true }; whom = 'EVERY name held now'; }
            else {
                const names = String(document.getElementById('noticeNames').value || '').split(/[\\s,]+/).map(function(n) { return n.trim().toLowerCase().replace(/\\.beanpool\\.org$/, ''); }).filter(Boolean);
                if (!names.length) { alert('Type a name, or names separated by commas.'); return; }
                to = { names: names };
                whom = names.join(', ');
            }
            if (!confirm('Send this ' + level + ' notice to ' + whom + '?\\n\\n' + text + '\\n\\nEach node shows it in its Settings and tells its owners' + (reply ? '; each gets a one-use reply link' : '') + '. It cannot be taken back.')) return;
            const r = await postAdmin('notices', { to: to, text: text, level: level, reply: reply, days: days });
            if (!r.ok) { alert('Not sent: ' + (r.data.error || r.status)); return; }
            noticeGroup = null;
            alert('Sent to ' + r.data.recipients + ' node' + (r.data.recipients === 1 ? '' : 's') + '. Each hears it at its next check-in, within 15 minutes.');
            loadNotices();
        }
        document.addEventListener('click', function(e) { noticesClick(e); });

        document.addEventListener('click', function(e) {
            const mode = e.target.closest('[data-alert-mode]');
            if (mode) setAlertMode(mode.getAttribute('data-alert-category'), mode.getAttribute('data-alert-mode'));
            if (e.target.closest('[data-alert-test]')) sendTestAlert();
        });

        checkSignIn();
    </script>
</body>
</html>`;
