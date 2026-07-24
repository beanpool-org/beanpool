        const esc = s => String(s||'').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

        const API = '/api/local';
        let authToken = sessionStorage.getItem('bp-admin-token') || null;
        let settingsMap, settingsMarker;
        let radiusCircle;

        function updateRadiusCircle() {
            const lat = parseFloat(document.getElementById('cfg-lat').value);
            const lng = parseFloat(document.getElementById('cfg-lng').value);
            const km = parseInt(document.getElementById('radius-km').value) || 0;
            // Remove old circle
            if (radiusCircle) { settingsMap?.removeLayer(radiusCircle); radiusCircle = null; }
            // Draw new if valid
            if (settingsMap && !isNaN(lat) && !isNaN(lng) && km > 0) {
                radiusCircle = L.circle([lat, lng], {
                    radius: km * 1000,
                    color: '#f59e0b', fillColor: '#f59e0b',
                    fillOpacity: 0.08, weight: 2, dashArray: '6 4'
                }).addTo(settingsMap);
            }
        }

        // ======================== PASSWORD EYE TOGGLE ========================
        document.querySelectorAll('.pwd-eye').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const input = btn.closest('.pwd-wrapper').querySelector('input');
                input.type = input.type === 'password' ? 'text' : 'password';
            });
        });

        function showStatus(id, msg, type) {
            const el = document.getElementById(id);
            el.textContent = msg;
            el.className = `status-msg show ${type}`;
        }

        function showView(name) {
            document.getElementById('view-login').classList.toggle('hidden', name !== 'login');
            document.getElementById('view-settings').classList.toggle('hidden', name !== 'settings');
            const logoutBtn = document.getElementById('logout-btn');
            if (logoutBtn) {
                logoutBtn.classList.toggle('hidden', name !== 'settings');
            }
        }

        // ======================== TAB SWITCHING ========================
        function switchTab(tabName) {
            // Update buttons
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tabName);
            });
            // Show/hide panels
            document.querySelectorAll('#view-settings .glass[data-tab]').forEach(panel => {
                panel.style.display = panel.dataset.tab === tabName ? '' : 'none';
            });
            // Persist
            sessionStorage.setItem('bp-settings-tab', tabName);
            // Leaflet needs invalidateSize after being unhidden
            if (tabName === 'identity') {
                if (settingsMap) setTimeout(() => settingsMap.invalidateSize(), 50);
                loadNodeConfig();
            }
            if (tabName === 'network') {
                loadGatewayConfig();
                loadNodeConfig();
            }
            if (tabName === 'system') {
                loadVersionInfo();
            }
            // Load data for admin tabs
            if (tabName === 'moderation' || tabName === 'members') loadAdminData();
            if (tabName === 'members') loadThresholdGroup(AUDIT_THRESHOLD_KEYS);
            if (tabName === 'comms') loadAdminInbox();
            if (tabName === 'commons') { loadCommonsData(); loadNodeConfig(); loadThresholdGroup(COMMONS_THRESHOLD_KEYS); }
            if (tabName === 'diagnostics') {
                unseenWarningErrorCount = 0;
                updateDiagBadge();
                loadLogsHistory();
                loadDiagnostics();
                if (diagnosticsInterval) clearInterval(diagnosticsInterval);
                diagnosticsInterval = setInterval(loadDiagnostics, 3000);
            } else {
                if (diagnosticsInterval) {
                    clearInterval(diagnosticsInterval);
                    diagnosticsInterval = null;
                }
            }
            if (tabName === 'connections') {
                loadInitialConnections();
                initTrafficControls();
                if (connTimerInterval) clearInterval(connTimerInterval);
                connTimerInterval = setInterval(updateConnectionTimers, 1000);
            } else {
                if (connTimerInterval) {
                    clearInterval(connTimerInterval);
                    connTimerInterval = null;
                }
            }
            if (tabName === 'backup') {
                loadBackupTab();
                if (backupHealthInterval) clearInterval(backupHealthInterval);
                backupHealthInterval = setInterval(loadBackupStatus, 10000);
            } else {
                if (backupHealthInterval) {
                    clearInterval(backupHealthInterval);
                    backupHealthInterval = null;
                }
            }
        }
        let backupHealthInterval = null;

        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        // Apply initial tab (default: identity)
        // Moved to bottom of file to prevent ReferenceError with constants

        // ======================== LEAFLET MAP ========================
        const nodeIcon = L.divIcon({
            html: '<div style="width:14px;height:14px;background:#10b981;border-radius:50%;border:2px solid #064e3b;box-shadow:0 0 10px rgba(16,185,129,0.6)"></div>',
            className: '', iconSize: [14, 14], iconAnchor: [7, 7]
        });

        const sisterIcon = L.divIcon({
            html: '<div style="width:14px;height:14px;background:#3b82f6;border-radius:50%;border:2px solid #1e3a8a;box-shadow:0 0 10px rgba(59,130,246,0.6)"></div>',
            className: '', iconSize: [14, 14], iconAnchor: [7, 7]
        });
        const sisterMarkers = [];

        async function plotSisterNodes(connectors) {
            if (!settingsMap) return;
            sisterMarkers.forEach(m => settingsMap.removeLayer(m));
            sisterMarkers.length = 0;

            for (const c of connectors) {
                if (!c.enabled || !c.publicUrl) continue;
                try {
                    const res = await fetch(`${c.publicUrl}/api/local/status`).catch(() => null);
                    if (res && res.ok) {
                        const info = await res.json();
                        if (info.location && info.location.lat && info.location.lng) {
                            const marker = L.marker([info.location.lat, info.location.lng], { icon: sisterIcon })
                                .addTo(settingsMap)
                                .bindPopup(`<div style="text-align:center;"><b>${info.callsign || c.callsign || 'Sister Node'}</b><br><a href="${c.publicUrl}" target="_blank" style="color:#3b82f6;font-size:0.8rem;text-decoration:none;">Visit Node ↗</a></div>`);
                            sisterMarkers.push(marker);
                        }
                    }
                } catch(e) {}
            }
        }

        function initMap(lat, lng) {
            if (settingsMap) { settingsMap.invalidateSize(); return; }
            const center = (lat && lng) ? [lat, lng] : [0, 0];
            const zoom = (lat && lng) ? 10 : 2;
            settingsMap = L.map('settings-map').setView(center, zoom);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; OpenStreetMap', maxZoom: 18
            }).addTo(settingsMap);
            if (lat && lng) {
                settingsMarker = L.marker([lat, lng], { icon: nodeIcon }).addTo(settingsMap);
            }
            settingsMap.on('click', (e) => {
                document.getElementById('cfg-lat').value = e.latlng.lat;
                document.getElementById('cfg-lng').value = e.latlng.lng;
                if (settingsMarker) settingsMarker.setLatLng(e.latlng);
                else settingsMarker = L.marker(e.latlng, { icon: nodeIcon }).addTo(settingsMap);
                updateRadiusCircle();
            });
            // Draw initial radius circle if loaded
            updateRadiusCircle();
        }

        // Sync radius slider <-> km input
        document.getElementById('radius-slider').addEventListener('input', (e) => {
            document.getElementById('radius-km').value = e.target.value;
            updateRadiusCircle();
        });
        document.getElementById('radius-km').addEventListener('input', (e) => {
            const v = Math.min(parseInt(e.target.value) || 0, 500);
            document.getElementById('radius-slider').value = Math.min(v, 200);
            updateRadiusCircle();
        });

        // ======================== LOCATION SEARCH (NOMINATIM) ========================
        const searchInput = document.getElementById('location-search');
        const searchResults = document.getElementById('location-results');
        let searchTimeout;

        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            const q = e.target.value.trim();
            if (q.length < 3) { searchResults.classList.remove('active'); return; }
            searchTimeout = setTimeout(async () => {
                try {
                    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`);
                    const data = await res.json();
                    searchResults.innerHTML = data.map(r => `
                        <div class="item" data-lat="${r.lat}" data-lng="${r.lon}">
                            <div style="color:#e2e8f0">${esc(r.display_name)}</div>
                            <div class="type">${esc(r.type)}</div>
                        </div>
                    `).join('');
                    searchResults.classList.add('active');
                    searchResults.querySelectorAll('.item').forEach(item => {
                        item.addEventListener('click', () => {
                            const lat = parseFloat(item.dataset.lat);
                            const lng = parseFloat(item.dataset.lng);
                            document.getElementById('cfg-lat').value = lat;
                            document.getElementById('cfg-lng').value = lng;
                            searchInput.value = item.querySelector('div').textContent;
                            searchResults.classList.remove('active');
                            settingsMap.setView([lat, lng], 12);
                            if (settingsMarker) settingsMarker.setLatLng([lat, lng]);
                            else settingsMarker = L.marker([lat, lng], { icon: nodeIcon }).addTo(settingsMap);
                        });
                    });
                } catch (err) { console.error('Geocoding failed:', err); }
            }, 350);
        });
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-wrapper')) searchResults.classList.remove('active');
        });

        // ======================== LOGIN ========================
        document.getElementById('login-btn').addEventListener('click', async () => {
            const password = document.getElementById('login-password').value;
            if (!password) { showStatus('login-status', 'Enter your password', 'error'); return; }
            try {
                const res = await fetch(`${API}/verify-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                if (!res.ok) {
                    const err = await res.json();
                    showStatus('login-status', err.error || 'Invalid password', 'error');
                    return;
                }
                authToken = password;
                sessionStorage.setItem('bp-admin-token', password);
                initLogsWs();
                let dashboardData = null;
                const dashRes = await fetch(`${API}/dashboard`);
                if (dashRes.ok) {
                    dashboardData = await dashRes.json();
                    hydrateSettings(dashboardData);
                }
                showView('settings');
                loadVersionInfo();
                loadHealthDashboard();
                loadThresholds();
                loadCommunityInfo();
                loadAdminData();
                switchTab(sessionStorage.getItem('bp-settings-tab') || 'identity');
                setTimeout(() => {
                    initMap(
                        parseFloat(document.getElementById('cfg-lat').value) || null,
                        parseFloat(document.getElementById('cfg-lng').value) || null
                    );
                    if (dashboardData && dashboardData.connectors) plotSisterNodes(dashboardData.connectors);
                    maybeAutoCheck();
                }, 150);
            } catch (err) {
                showStatus('login-status', 'Login failed', 'error');
            }
        });

        // Enter key submits login
        document.getElementById('login-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('login-btn').click();
        });

        // ======================== HYDRATE SETTINGS ========================
        function hydrateSettings(data) {
            document.getElementById('hdr-peer-id').textContent = `PeerId: ${data.identity.peerId}`;
            document.getElementById('cfg-callsign').value = data.identity.callsign || '';
            if (data.identity.location) {
                document.getElementById('cfg-lat').value = data.identity.location.lat;
                document.getElementById('cfg-lng').value = data.identity.location.lng;
            }
            renderConnectors(data.connectors || []);
        }

        // ======================== CONNECTORS ========================
        // ======================== CONNECTORS ========================
        function renderConnectors(connectors) {
            const list = document.getElementById('connectors-list');
            if (connectors.length === 0) {
                list.innerHTML = '<p style="font-size:0.8rem;color:#475569;text-align:center;padding:1rem;">No connectors configured. Add one below.</p>';
                return;
            }
            list.innerHTML = connectors.map(c => {
                const trustLabels = { mirror: 'Mirror', peer: 'Peer', blocked: 'Blocked' };
                let badge;
                if (c.connected && c.mutualTrust) {
                    badge = `<span class="badge badge-mutual"><span style="font-size:0.45rem;line-height:1;margin-right:1px;">●</span>Mutual Trust</span>`;
                } else if (c.connected) {
                    badge = `<span class="badge badge-outbound"><span style="font-size:0.55rem;line-height:1;margin-right:1px;">◐</span>Outbound Only</span>`;
                } else {
                    badge = `<span class="badge badge-disconnected"><span style="font-size:0.55rem;line-height:1;margin-right:1px;">○</span>Disconnected</span>`;
                }

                const isPassive = c.enabled === false;
                const modeBadge = isPassive
                    ? `<span class="badge" style="background:rgba(148,163,184,0.15);color:#94a3b8;border:1px solid rgba(148,163,184,0.3);"><span style="font-size:0.75rem;line-height:1;margin-right:1px;display:flex;align-items:center;height:12px;">💤</span>Passive</span>`
                    : `<span class="badge" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3);"><span style="font-size:0.75rem;line-height:1;margin-right:1px;display:flex;align-items:center;height:12px;">⚡</span>Active</span>`;

                const isCollision = (c.enabled !== false && c.remoteActive === true);
                const collisionBadge = isCollision
                    ? `<span class="badge" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);"><span style="font-size:0.75rem;line-height:1;margin-right:1px;display:flex;align-items:center;height:12px;">⚠️</span>Collision</span>`
                    : '';

                const isDeadlock = (c.enabled === false && c.remoteActive === false && c.connected);
                const deadlockBadge = isDeadlock
                    ? `<span class="badge" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3);"><span style="font-size:0.75rem;line-height:1;margin-right:1px;display:flex;align-items:center;height:12px;">⚠️</span>Deadlock</span>`
                    : '';

                let latency = '—';
                if (c.latencyMs !== null && c.latencyMs > 0) {
                    latency = `${c.latencyMs}ms`;
                } else if (c.connected && isPassive) {
                    latency = '— (Inbound Verified)';
                }
                const lastVerified = c.lastVerified ? `${Math.round((Date.now() - c.lastVerified) / 1000)}s ago` : '—';
                const remoteTrust = c.remoteTrustLevel ? trustLabels[c.remoteTrustLevel] || c.remoteTrustLevel : '—';

                const collisionAlert = isCollision
                    ? `
                    <div style="margin-top:0.5rem;padding:0.5rem 0.6rem;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:6px;font-size:0.7rem;color:#f87171;line-height:1.4;display:flex;align-items:flex-start;gap:0.35rem;">
                        <span style="font-size:0.85rem;line-height:1;margin-top:1px;">⚠️</span>
                        <div>
                            <strong>Dual Active Collision!</strong> Both nodes are configured as <strong>Active</strong> dialers. Please click <strong>"💤 Make Passive"</strong> on one of them to prevent connection bouncing.
                        </div>
                    </div>
                    `
                    : '';

                const deadlockAlert = isDeadlock
                    ? `
                    <div style="margin-top:0.5rem;padding:0.5rem 0.6rem;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);border-radius:6px;font-size:0.7rem;color:#fbbf24;line-height:1.4;display:flex;align-items:flex-start;gap:0.35rem;">
                        <span style="font-size:0.85rem;line-height:1;margin-top:1px;">⚠️</span>
                        <div>
                            <strong>Dual Passive Deadlock!</strong> Both nodes are configured as <strong>Passive</strong> listeners. Neither node will initiate synchronization. Please click <strong>"⚡ Make Active"</strong> on one of them to start syncing.
                        </div>
                    </div>
                    `
                    : '';

                return `
                    <div class="connector-card">
                        <div class="header">
                            <div>
                                <div class="name">${esc(c.callsign || c.address)}</div>
                                <div class="addr">${esc(c.address)}</div>
                            </div>
                            <div style="display:flex;gap:0.25rem;align-items:center;">
                                ${modeBadge}
                                ${collisionBadge}
                                ${deadlockBadge}
                                ${badge}
                            </div>
                        </div>
                        <div class="meta">
                            <span>You → ${trustLabels[c.trustLevel] || c.trustLevel}</span>
                            <span>Them → ${remoteTrust}</span>
                            <span>RTT: ${latency}</span>
                        </div>
                        ${collisionAlert}
                        ${deadlockAlert}
                        <div class="actions">
                            ${c.connected
                        ? `<button class="btn btn-outline btn-sm" onclick="doDisconnect('${esc(c.address)}')">Disconnect</button>`
                        : `<button class="btn btn-outline btn-sm" onclick="doConnect('${esc(c.address)}')">Connect</button>`
                    }
                            <button class="btn btn-outline btn-sm" onclick="toggleConnectorMode('${esc(c.address)}', ${c.enabled === false}, '${esc(c.trustLevel)}', '${esc(c.callsign || '')}')">
                                ${isPassive ? '⚡ Make Active' : '💤 Make Passive'}
                            </button>
                            <button class="btn btn-danger btn-sm" onclick="doRemove('${esc(c.address)}')">Remove</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function refreshConnectors() {
            try {
                const res = await fetch(`${API}/connectors`);
                if (res.ok) renderConnectors(await res.json());
            } catch (e) { /* ignore */ }
        }

        window.doConnect = async function (address) {
            try {
                await fetch(`${API}/connectors/connect`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, address })
                });
                await refreshConnectors();
            } catch (e) { showStatus('connector-status', 'Connection failed', 'error'); }
        };

        window.doDisconnect = async function (address) {
            try {
                await fetch(`${API}/connectors/disconnect`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, address })
                });
                await refreshConnectors();
            } catch (e) { showStatus('connector-status', 'Disconnect failed', 'error'); }
        };

        window.doRemove = async function (address) {
            if (!confirm(`Remove connector ${address}?`)) return;
            try {
                await fetch(`${API}/connectors/remove`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, address })
                });
                await refreshConnectors();
            } catch (e) { showStatus('connector-status', 'Remove failed', 'error'); }
        };

        window.toggleConnectorMode = async function (address, makeActive, trustLevel, callsign) {
            try {
                await fetch(`${API}/connectors`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        password: authToken,
                        address,
                        trustLevel,
                        callsign: callsign || undefined,
                        enabled: makeActive
                    })
                });
                await refreshConnectors();
            } catch (e) { showStatus('connector-status', 'Failed to update mode', 'error'); }
        };

        // Add connector
        document.getElementById('add-connector-btn').addEventListener('click', async () => {
            const address = document.getElementById('new-addr').value.trim();
            const trustLevel = document.getElementById('new-trust').value;
            const mode = document.getElementById('new-mode').value;
            const callsign = document.getElementById('new-callsign').value.trim();
            if (!address) { showStatus('connector-status', 'Address is required', 'error'); return; }
            try {
                const res = await fetch(`${API}/connectors`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        password: authToken,
                        address,
                        trustLevel,
                        callsign: callsign || undefined,
                        enabled: mode === 'active'
                    })
                });
                if (res.ok) {
                    document.getElementById('new-addr').value = '';
                    document.getElementById('new-callsign').value = '';
                    showStatus('connector-status', 'Connector added!', 'success');
                    await refreshConnectors();
                } else {
                    const err = await res.json();
                    showStatus('connector-status', err.error || 'Failed', 'error');
                }
            } catch (e) { showStatus('connector-status', 'Failed', 'error'); }
        });

        // ======================== SAVE IDENTITY ========================
        document.getElementById('save-identity-btn').addEventListener('click', async () => {
            try {
                const res = await fetch(`${API}/update-identity`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        password: authToken,
                        callsign: document.getElementById('cfg-callsign').value,
                        lat: document.getElementById('cfg-lat').value ? parseFloat(document.getElementById('cfg-lat').value) : null,
                        lng: document.getElementById('cfg-lng').value ? parseFloat(document.getElementById('cfg-lng').value) : null,
                        communityName: document.getElementById('community-name').value,
                        contactEmail: document.getElementById('contact-email').value,
                        contactPhone: document.getElementById('contact-phone').value,
                    })
                });
                // Also save node config (radius + directory)
                await saveNodeConfig();
                if (res.ok) showStatus('identity-status', 'Saved!', 'success');
                else showStatus('identity-status', 'Save failed', 'error');
            } catch (e) { showStatus('identity-status', 'Save failed', 'error'); }
        });

        // ======================== COMMUNITY INFO ========================
        // Load community info after login
        async function loadCommunityInfo() {
            try {
                const res = await fetch(`${API}/community-info`);
                if (res.ok) {
                    const data = await res.json();
                    document.getElementById('community-name').value = data.communityName || '';
                    document.getElementById('contact-email').value = data.contactEmail || '';
                    document.getElementById('contact-phone').value = data.contactPhone || '';
                }
            } catch (e) { console.warn('Failed to load community info:', e); }
        }

        // ======================== SEED INVITE ========================
        // Tier selector visual highlighting
        document.querySelectorAll('#invite-tier-selector .tier-option').forEach(label => {
            label.addEventListener('click', () => {
                document.querySelectorAll('#invite-tier-selector .tier-option').forEach(l => {
                    l.style.borderColor = '#334155';
                    l.style.background = 'transparent';
                });
                const colors = { standard: '#6b7280', trusted: '#3b82f6', ambassador: '#8b5cf6', elder: '#f59e0b' };
                const type = label.dataset.type;
                label.style.borderColor = colors[type] || '#334155';
                label.style.background = (colors[type] || '#334155') + '15';
            });
            // Apply initial highlight for selected
            if (label.querySelector('input').checked) label.click();
        });

        document.getElementById('seed-invite-btn').addEventListener('click', async () => {
            try {
                if (!navigator.onLine) {
                    showStatus('seed-invite-status', '⚠️ You must be online to generate an invite code. Please check your connection and try again.', 'error');
                    return;
                }
                const selectedType = document.querySelector('input[name="invite-type"]:checked')?.value || 'standard';
                showStatus('seed-invite-status', 'Generating...', 'info');
                const res = await fetch('/api/admin/seed-invite', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, type: selectedType })
                });
                const data = await res.json();
                if (res.ok && data.code) {
                    const code = data.code.toUpperCase();
                    const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
                    document.getElementById('seed-invite-code').textContent = inviteUrl;
                    document.getElementById('seed-invite-qr').src =
                        `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(inviteUrl)}`;
                    document.getElementById('seed-invite-tier-label').textContent = data.tierLabel || '';
                    document.getElementById('seed-invite-result').classList.remove('hidden');
                    showStatus('seed-invite-status', data.message || 'Invite generated!', 'success');
                } else {
                    showStatus('seed-invite-status', data.error || 'Failed to generate invite', 'error');
                }
            } catch (e) { showStatus('seed-invite-status', 'Failed to generate invite', 'error'); }
        });

        document.getElementById('copy-invite-btn')?.addEventListener('click', () => {
            const code = document.getElementById('seed-invite-code').textContent;
            navigator.clipboard.writeText(code).then(() => {
                showStatus('seed-invite-status', 'Copied!', 'success');
            });
        });

        // ======================== CHANGE PASSWORD ========================
        const newPwdInput = document.getElementById('new-pwd');
        const reqBox = document.getElementById('pwd-requirements-box');

        newPwdInput.addEventListener('input', () => {
            const val = newPwdInput.value;
            if (!val) {
                reqBox.style.display = 'none';
                return;
            }
            reqBox.style.display = 'block';

            const checks = {
                len: val.length >= 8,
                upper: /[A-Z]/.test(val),
                lower: /[a-z]/.test(val),
                num: /[0-9]/.test(val),
                sym: /[!@#$%^&*(),.?":{}|<>\-_]/.test(val)
            };

            updateReqItem('req-len', checks.len);
            updateReqItem('req-upper', checks.upper);
            updateReqItem('req-lower', checks.lower);
            updateReqItem('req-num', checks.num);
            updateReqItem('req-sym', checks.sym);
        });

        function updateReqItem(id, met) {
            const el = document.getElementById(id);
            if (!el) return;
            if (met) {
                el.style.color = '#10b981';
                el.querySelector('.icon').textContent = '✅';
            } else {
                el.style.color = '#ef4444';
                el.querySelector('.icon').textContent = '❌';
            }
        }

        document.getElementById('change-pwd-btn').addEventListener('click', async () => {
            const np = document.getElementById('new-pwd').value;
            const nc = document.getElementById('new-pwd-confirm').value;
            if (!np) { showStatus('pwd-status', 'Enter a new password', 'error'); return; }

            // Validate strength client-side
            const meetsAll = np.length >= 8 && /[A-Z]/.test(np) && /[a-z]/.test(np) && /[0-9]/.test(np) && /[!@#$%^&*(),.?":{}|<>\-_]/.test(np);
            if (!meetsAll) {
                showStatus('pwd-status', 'Password does not meet the requirements', 'error');
                return;
            }

            if (np !== nc) { showStatus('pwd-status', 'Passwords do not match', 'error'); return; }
            try {
                const res = await fetch(`${API}/change-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ currentPassword: authToken, newPassword: np })
                });
                if (res.ok) {
                    authToken = np;
                    showStatus('pwd-status', 'Password updated!', 'success');
                    document.getElementById('new-pwd').value = '';
                    document.getElementById('new-pwd-confirm').value = '';
                    reqBox.style.display = 'none';
                } else {
                    const err = await res.json();
                    showStatus('pwd-status', err.error || 'Failed', 'error');
                }
            } catch (e) { showStatus('pwd-status', 'Failed', 'error'); }
        });

        // ======================== RESET ========================
        document.getElementById('reset-btn').addEventListener('click', async () => {
            // First offer a backup
            const wantsBackup = confirm('⚠️ LAST CHANCE: Download a backup before resetting?\n\nClick OK to download a backup first, or Cancel to proceed without one.');
            if (wantsBackup) {
                await downloadBackup();
                // Give them a chance to cancel after seeing the backup
                if (!confirm('Backup downloaded. Proceed with the reset?\n\nThis will erase your node identity and admin password.')) return;
            } else {
                if (!confirm('Are you absolutely sure?\n\nThis will erase your node identity, admin password, and all configuration. This cannot be undone.')) return;
            }
            try {
                const res = await fetch(`${API}/reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                const d = await res.json();
                if (d.success) {
                    showStatus('reset-status', 'Reset complete. Restart the container to reconfigure.', 'success');
                } else {
                    showStatus('reset-status', d.error || 'Reset failed', 'error');
                }
            } catch (e) { showStatus('reset-status', 'Failed', 'error'); }
            // Re-lock the button
            document.getElementById('reset-confirm-input').value = '';
            document.getElementById('reset-btn').disabled = true;
        });

        // ======================== SOFTWARE UPDATES ========================
        // Load current version on login
        async function loadVersionInfo() {
            try {
                const res = await fetch(`/api/version?t=${Date.now()}`);
                if (res.ok) {
                    const data = await res.json();
                    document.getElementById('current-version').textContent = `v${data.version}`;
                    const topDisplay = document.getElementById('top-version-display');
                    if (topDisplay) topDisplay.textContent = `V${data.version}`;
                    // If server has cached update info, show badge immediately
                    if (data.updateAvailable && data.latestVersion) {
                        const badge = document.getElementById('update-badge');
                        const badgeText = document.getElementById('update-badge-text');
                        const latestEl = document.getElementById('latest-version');
                        if (badge) {
                            badge.style.display = 'inline';
                            badgeText.textContent = `v${data.latestVersion} available`;
                        }
                        if (latestEl) {
                            latestEl.textContent = `v${data.latestVersion}`;
                            latestEl.style.color = '#f59e0b';
                        }
                        // Show instructions panel
                        const instructionsEl = document.getElementById('update-instructions');
                        if (instructionsEl) instructionsEl.style.display = 'block';
                    }
                }
            } catch { /* offline */ }
        }

        // Community Health dashboard
        async function loadHealthDashboard() {
            try {
                const res = await fetch('/api/community/health');
                if (!res.ok) return;
                const h = await res.json();

                // Stat cards
                const stats = [
                    { emoji: '👥', value: h.tree.totalMembers, label: 'Members' },
                    { emoji: '🌳', value: h.tree.maxDepth, label: 'Tree Depth' },
                    { emoji: '📈', value: h.activity.last7Days, label: 'Txns (7d)' },
                    { emoji: '📊', value: h.activity.last30Days, label: 'Txns (30d)' },
                    { emoji: '🟢', value: h.activity.activeMemberCount, label: 'Active', color: '#22c55e' },
                    { emoji: '⚪', value: h.activity.inactiveMemberCount, label: 'Inactive', color: '#64748b' },
                    { emoji: '🏦', value: h.activity.commonsBalance + 'B', label: 'Commons', color: '#f59e0b' },
                    { emoji: '💸', value: h.activity.totalTransactions, label: 'Total Txns' },
                ];
                const grid = document.getElementById('health-grid');
                grid.innerHTML = stats.map(s => `
                    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:0.6rem;text-align:center;">
                        <div style="font-size:1.1rem;">${s.emoji}</div>
                        <div style="font-size:1.2rem;font-weight:700;font-family:monospace;color:${s.color || '#f8fafc'};">${s.value}</div>
                        <div style="font-size:0.65rem;color:#64748b;text-transform:uppercase;letter-spacing:0.03em;">${s.label}</div>
                    </div>
                `).join('');

                // Widest branch
                const wEl = document.getElementById('health-widest');
                if (h.tree.widestBranch.children > 0) {
                    wEl.style.display = '';
                    wEl.innerHTML = `<div style="font-size:0.65rem;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.2rem;">Widest Branch</div><div style="font-size:0.95rem;font-weight:600;">🌿 ${esc(h.tree.widestBranch.callsign)} — ${h.tree.widestBranch.children} invitee${h.tree.widestBranch.children !== 1 ? 's' : ''}</div>`;
                } else {
                    wEl.style.display = 'none';
                }

                // Flags
                const fEl = document.getElementById('health-flags');
                if (h.flags.length === 0) {
                    fEl.innerHTML = '<div style="text-align:center;padding:0.75rem;border:1px solid #1a3a1a;border-radius:10px;background:rgba(34,197,94,0.05);"><div style="font-size:1.2rem;margin-bottom:0.15rem;">✅</div><div style="color:#22c55e;font-size:0.85rem;">No issues detected</div></div>';
                } else {
                    fEl.innerHTML = h.flags.map(f => {
                        const icon = f.type === 'wash_trading' ? '🔄' : f.type === 'isolated_branch' ? '🏝️' : '💤';
                        const borderColor = f.severity === 'alert' ? '#ef444466' : '#f59e0b44';
                        const bgColor = f.severity === 'alert' ? 'rgba(239,68,68,0.05)' : 'rgba(245,158,11,0.05)';
                        const labelColor = f.severity === 'alert' ? '#ef4444' : '#f59e0b';
                        return `<div style="border:1px solid ${borderColor};background:${bgColor};border-radius:10px;padding:0.75rem;margin-bottom:0.5rem;"><div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.2rem;"><span>${icon}</span><span style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:${labelColor};">${esc(f.type.replace(/_/g, ' '))}</span></div><div style="font-size:0.8rem;color:#cbd5e1;">${esc(f.description)}</div></div>`;
                    }).join('');
                }
            } catch { /* offline */ }
        }

        // ===================== THRESHOLDS (split by tab) =====================

        const AUDIT_THRESHOLD_KEYS = [
            'washTradingWindowHours', 'washTradingMinTxns', 'inactiveMemberDays',
            'isolatedBranchMinTxns', 'maxProjectExpiryDays',
            'sybilFunnelMinInvitees', 'sybilFunnelMinAmount', 'sybilFunnelWindowDays',
        ];
        const COMMONS_THRESHOLD_KEYS = ['circulationRate'];
        const ALL_THRESHOLD_KEYS = [...AUDIT_THRESHOLD_KEYS, ...COMMONS_THRESHOLD_KEYS];

        let _thresholdsCache = null;

        async function fetchThresholds() {
            try {
                const res = await fetch('/api/admin/thresholds/get', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) return null;
                _thresholdsCache = await res.json();
                return _thresholdsCache;
            } catch { return null; }
        }

        function populateThresholdInputs(keys, data) {
            if (!data) return;
            for (const key of keys) {
                const el = document.getElementById('th-' + key);
                if (el) el.value = data.thresholds[key];
            }
        }

        async function loadThresholds() {
            const data = await fetchThresholds();
            if (data) populateThresholdInputs(ALL_THRESHOLD_KEYS, data);
        }

        async function loadThresholdGroup(keys) {
            const data = _thresholdsCache || await fetchThresholds();
            if (data) populateThresholdInputs(keys, data);
        }

        async function saveThresholdGroup(keys, statusId) {
            const updates = { password: authToken };
            for (const key of keys) {
                const el = document.getElementById('th-' + key);
                if (el) updates[key] = parseFloat(el.value);
            }
            try {
                const res = await fetch('/api/admin/thresholds', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updates)
                });
                if (res.ok) {
                    showStatus(statusId, '✅ Saved!', 'success');
                    _thresholdsCache = null; // invalidate cache
                    loadHealthDashboard(); // Refresh health with new thresholds
                } else {
                    const data = await res.json();
                    showStatus(statusId, data.error || 'Save failed', 'error');
                }
            } catch {
                showStatus(statusId, 'Failed to save', 'error');
            }
        }

        async function resetThresholdGroup(keys, statusId) {
            const data = _thresholdsCache || await fetchThresholds();
            if (!data) return;
            for (const key of keys) {
                const el = document.getElementById('th-' + key);
                if (el) el.value = data.defaults[key];
            }
            showStatus(statusId, 'Defaults loaded — click Save to apply', 'success');
        }

        // Audit tab (detection thresholds)
        document.getElementById('save-audit-thresholds-btn').addEventListener('click', () => saveThresholdGroup(AUDIT_THRESHOLD_KEYS, 'audit-thresholds-status'));
        document.getElementById('reset-audit-thresholds-btn').addEventListener('click', () => resetThresholdGroup(AUDIT_THRESHOLD_KEYS, 'audit-thresholds-status'));

        // Commons tab (circulation rate)
        document.getElementById('save-commons-thresholds-btn').addEventListener('click', () => saveThresholdGroup(COMMONS_THRESHOLD_KEYS, 'commons-thresholds-status'));
        document.getElementById('reset-commons-thresholds-btn').addEventListener('click', () => resetThresholdGroup(COMMONS_THRESHOLD_KEYS, 'commons-thresholds-status'));


        document.getElementById('refresh-health-btn').addEventListener('click', loadHealthDashboard);

        // Old loadReports removed — reports are now surfaced in Moderation tab via admin data

        async function checkForUpdates() {
            showStatus('update-status', 'Checking...', 'success');
            try {
                const res = await fetch('/api/admin/check-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                const data = await res.json();
                if (!res.ok) {
                    showStatus('update-status', data.error || 'Check failed', 'error');
                    return;
                }
                document.getElementById('current-version').textContent = `v${data.currentVersion}`;
                const topDisplay = document.getElementById('top-version-display');
                if (topDisplay) topDisplay.textContent = `V${data.currentVersion}`;
                const latestEl = document.getElementById('latest-version');
                const badge = document.getElementById('update-badge');
                const badgeText = document.getElementById('update-badge-text');
                const instructionsEl = document.getElementById('update-instructions');
                const notesEl = document.getElementById('update-release-notes');
                const publishedEl = document.getElementById('update-published-at');

                if (data.updateAvailable && data.latestVersion) {
                    latestEl.textContent = `v${data.latestVersion}`;
                    latestEl.style.color = '#f59e0b';
                    // Show header badge
                    if (badge) {
                        badge.style.display = 'inline';
                        badgeText.textContent = `v${data.latestVersion} available`;
                    }
                    // Show instructions
                    if (instructionsEl) instructionsEl.style.display = 'block';
                    // Show release notes
                    if (data.releaseNotes && notesEl) {
                        notesEl.textContent = data.releaseNotes;
                        notesEl.style.display = 'block';
                    }
                    // Show published date
                    if (data.publishedAt && publishedEl) {
                        publishedEl.textContent = `Published: ${new Date(data.publishedAt).toLocaleDateString()}`;
                        publishedEl.style.display = 'block';
                    }
                    showStatus('update-status', '🆕 Update available!', 'success');
                } else {
                    latestEl.textContent = `v${data.currentVersion}`;
                    latestEl.style.color = '#10b981';
                    if (badge) badge.style.display = 'none';
                    if (instructionsEl) instructionsEl.style.display = 'none';
                    if (notesEl) notesEl.style.display = 'none';
                    if (publishedEl) publishedEl.style.display = 'none';
                    showStatus('update-status', '✓ You are up to date', 'success');
                }
                localStorage.setItem('beanpool-last-update-check', Date.now().toString());
            } catch (e) {
                showStatus('update-status', 'Check failed — offline?', 'error');
            }
        }

        // Copy update commands to clipboard
        window.copyUpdateCommands = function() {
            const commands = 'docker compose pull\ndocker compose up -d';
            navigator.clipboard.writeText(commands).then(() => {
                showStatus('update-status', '📋 Commands copied to clipboard!', 'success');
            }).catch(() => {
                // Fallback for older browsers
                const ta = document.createElement('textarea');
                ta.value = commands;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showStatus('update-status', '📋 Commands copied to clipboard!', 'success');
            });
        };

        document.getElementById('check-update-btn').addEventListener('click', checkForUpdates);

        // Auto-check for updates with configurable interval
        const autoCheckEl = document.getElementById('auto-check-updates');
        const intervalEl = document.getElementById('update-check-interval');

        // Restore saved preferences
        autoCheckEl.checked = localStorage.getItem('beanpool-auto-check') === 'true';
        const savedInterval = localStorage.getItem('beanpool-check-interval');
        if (savedInterval && intervalEl) intervalEl.value = savedInterval;

        autoCheckEl.addEventListener('change', () => {
            localStorage.setItem('beanpool-auto-check', autoCheckEl.checked.toString());
        });
        intervalEl?.addEventListener('change', () => {
            localStorage.setItem('beanpool-check-interval', intervalEl.value);
        });

        // Run auto-check if enabled and interval has elapsed
        function maybeAutoCheck() {
            if (!autoCheckEl.checked || !authToken) return;
            const lastCheck = parseInt(localStorage.getItem('beanpool-last-update-check') || '0');
            const interval = parseInt(intervalEl?.value || '21600000'); // default 6h
            if (Date.now() - lastCheck > interval) {
                checkForUpdates();
            }
        }

        // ======================== ADMIN CONSOLE ========================
        let adminDataCache = null;

        // ===================== COMMONS =====================
        let commonsData = null;

        async function loadCommonsData() {
            if (!authToken) return;
            try {
                const res = await fetch('/api/local/admin/commons/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) return;
                commonsData = await res.json();
                renderCommonsTab();
            } catch (e) { console.warn('Failed to load commons:', e); }
        }

        function renderCommonsTab() {
            if (!commonsData) return;
            document.getElementById('commons-balance').textContent = commonsData.balance.toFixed(2) + 'B';

            const activeRound = commonsData.rounds.find(r => r.status === 'open');
            const roundStatus = document.getElementById('commons-round-status');
            if (activeRound) {
                roundStatus.textContent = 'Open → ' + new Date(activeRound.closesAt).toLocaleDateString();
                roundStatus.style.color = '#10b981';
            } else {
                roundStatus.textContent = 'None';
                roundStatus.style.color = '#60a5fa';
            }

            const list = document.getElementById('commons-projects-list');
            if (!commonsData.projects.length) {
                list.innerHTML = '<div style="padding:1rem;text-align:center;color:#64748b;">No projects yet</div>';
                return;
            }
            list.innerHTML = commonsData.projects.map(p => {
                const statusBadge = {
                    proposed: '📋 Proposed',
                    active: '🗳️ Voting',
                    funded: '✅ Funded',
                    rejected: '❌ Rejected',
                    completed: '🎉 Completed',
                }[p.status] || p.status;
                const votes = p.votes?.length || 0;
                const currentAmt = p.currentAmount || 0;
                const exceeds = (p.status === 'active' || p.status === 'proposed') && p.requestedAmount > commonsData.balance;
                const progress = p.requestedAmount > 0 ? Math.min(100, (currentAmt / p.requestedAmount) * 100) : 0;
                const progressColor = progress >= 100 ? '#10b981' : '#8b5cf6';
                
                return `<div style="padding:0.6rem 0.75rem;border-bottom:1px solid #1e293b;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem;">
                        <div>
                            <strong style="font-size:0.85rem;">${esc(p.title)}</strong>
                            <div style="font-size:0.7rem;color:#64748b;margin-top:2px;">${esc(p.proposerCallsign)} · ${votes} vote${votes !== 1 ? 's' : ''}</div>
                        </div>
                        <div style="display:flex;gap:0.4rem;align-items:center;">
                            <span style="font-size:0.7rem;padding:2px 6px;border-radius:4px;background:${p.status === 'funded' ? '#10b98122' : p.status === 'rejected' ? '#ef444422' : '#2563eb22'};color:${p.status === 'funded' ? '#10b981' : p.status === 'rejected' ? '#ef4444' : '#60a5fa'};">${statusBadge}</span>
                            ${p.status === 'proposed' || p.status === 'active' ? `<button onclick="rejectProject('${esc(p.id)}')" style="padding:2px 6px;border-radius:4px;background:#ef444422;color:#ef4444;border:none;cursor:pointer;font-size:0.7rem;" aria-label="Reject project" title="Reject project">✕</button>` : ''}
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:0.5rem;">
                        <div style="flex:1;height:4px;background:#1e293b;border-radius:2px;overflow:hidden;">
                            <div style="height:100%;width:${progress}%;background:${progressColor};border-radius:2px;"></div>
                        </div>
                        <span style="font-size:0.7rem;color:${exceeds ? '#ef4444' : '#94a3b8'};white-space:nowrap;font-weight:${exceeds ? 'bold' : 'normal'};" title="${exceeds ? '⚠️ Goal exceeds available Commons balance' : ''}">${currentAmt.toFixed(0)} / ${p.requestedAmount.toFixed(0)}B${exceeds ? ' ⚠️' : ''}</span>
                    </div>
                </div>`;
            }).join('');
        }

        async function createRound() {
            if (!authToken || !commonsData) return;
            const proposed = commonsData.projects.filter(p => p.status === 'proposed');
            if (!proposed.length) { alert('No proposed projects to include in a round.'); return; }
            const days = prompt('How many days should voting be open?', '7');
            if (!days) return;
            const closesAt = new Date(Date.now() + Number(days) * 86400000).toISOString();
            try {
                await fetch('/api/local/admin/commons/round', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, action: 'create', projectIds: proposed.map(p => p.id), closesAt })
                });
                await loadCommonsData();
            } catch (e) { alert('Failed to create round: ' + e.message); }
        }

        async function closeRound() {
            if (!authToken || !commonsData) return;
            const activeRound = commonsData.rounds.find(r => r.status === 'open');
            if (!activeRound) { alert('No active round to close.'); return; }
            if (!confirm('Close the voting round and fund the winner?')) return;
            try {
                const res = await fetch('/api/local/admin/commons/round', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, action: 'close', roundId: activeRound.id })
                });
                const data = await res.json();
                if (data.winner) alert('🎉 Funded: ' + data.winner.title + ' (' + data.winner.requestedAmount + 'B)');
                else alert('Round closed. No project was funded (not enough in commons or no votes).');
                await loadCommonsData();
            } catch (e) { alert('Failed to close round: ' + e.message); }
        }

        async function rejectProject(projectId) {
            if (!authToken) return;
            if (!confirm('Reject this project?')) return;
            try {
                await fetch('/api/local/admin/commons/reject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, projectId })
                });
                await loadCommonsData();
            } catch (e) { alert('Failed: ' + e.message); }
        }

        async function saveNodeConfig() {
            if (!authToken) return;
            const lat = parseFloat(document.getElementById('cfg-lat').value);
            const lng = parseFloat(document.getElementById('cfg-lng').value);
            const km = parseInt(document.getElementById('radius-km').value) || 0;
            const publishLocation = document.getElementById('publish-location').checked;
            const publishMembers = document.getElementById('publish-members').checked;
            const publishContacts = document.getElementById('publish-contacts').checked;
            const publishHealth = document.getElementById('publish-health').checked;
            const val = parseInt(document.getElementById('directory-push-interval').value);
            const directoryPushIntervalHours = isNaN(val) ? 12 : val;
            
            const update = { publishLocation, publishMembers, publishContacts, publishHealth, directoryPushIntervalHours };
            if (!isNaN(lat) && !isNaN(lng)) {
                update.serviceRadius = { lat, lng, radiusKm: Math.max(0, km) };
            } else {
                update.serviceRadius = null;
            }
            try {
                await fetch('/api/local/admin/node/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, ...update })
                });
            } catch (e) { console.warn('Failed to save node config:', e); }
        }

        async function triggerDirectoryPush() {
            if (!authToken) return;
            const btn = document.getElementById('publish-now-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = '⏳ Publishing...';
            btn.disabled = true;
            try {
                const res = await fetch('/api/local/admin/directory/push', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                const data = await res.json();
                if (data.success) {
                    btn.innerHTML = '✅ Published!';
                    if (data.timestamp) {
                        const date = new Date(data.timestamp);
                        document.getElementById('last-published').innerText = `Last published: ${date.toLocaleString()}`;
                    }
                } else {
                    btn.innerHTML = '❌ Failed';
                }
            } catch (err) {
                console.error(err);
                btn.innerHTML = '❌ Failed';
            }
            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }, 3000);
        }

        async function loadNodeConfig() {
            try {
                const res = await fetch('/api/node/config');
                if (!res.ok) return;
                const config = await res.json();
                if (config.serviceRadius) {
                    const km = config.serviceRadius.radiusKm || 0;
                    document.getElementById('radius-slider').value = Math.min(km, 200);
                    document.getElementById('radius-km').value = km;
                    updateRadiusCircle();
                }
                document.getElementById('publish-location').checked = config.publishLocation !== false;
                document.getElementById('publish-members').checked = config.publishMembers !== false;
                document.getElementById('publish-contacts').checked = config.publishContacts !== false;
                document.getElementById('publish-health').checked = config.publishHealth !== false;
                if (config.directoryPushIntervalHours !== undefined) {
                    document.getElementById('directory-push-interval').value = config.directoryPushIntervalHours;
                }
                if (config.directoryPushIntervalHours === 0) {
                    document.getElementById('last-published').innerText = 'Last published: Disabled';
                } else if (config.lastDirectoryPush) {
                    const date = new Date(config.lastDirectoryPush);
                    document.getElementById('last-published').innerText = `Last published: ${date.toLocaleString()}`;
                } else {
                    document.getElementById('last-published').innerText = 'Last published: Never';
                }
            } catch { /* ignore */ }
        }

        async function loadAdminData() {
            if (!authToken) return;
            try {
                const res = await fetch('/api/local/admin/data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) return;
                adminDataCache = await res.json();
                renderAdminPosts();
                renderAdminMembers();
                renderAdminReports();
                renderHealthAlerts();
                updateModBadge();
            } catch (err) { console.error('Failed to load admin data', err); }
        }

        async function adminAction(endpoint, payload = {}) {
            if (!confirm('Are you sure you want to perform this administrative action?')) return;
            try {
                const res = await fetch('/api/local/admin' + endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...payload, password: authToken })
                });
                if (res.ok) {
                    alert('Action successful.');
                    loadAdminData();
                } else {
                    const err = await res.json();
                    alert('Action failed: ' + err.error);
                }
            } catch (err) {
                alert('Network error.');
            }
        }

        // Tier-badge picker handler. Uses its own confirm (not adminAction's generic one) so that a
        // cancel or failure can re-render the member list, snapping the <select> back to the stored
        // tier instead of leaving it showing an unapplied choice.
        async function setMemberTier(pubkey, tier) {
            const labels = { Newcomer: '🥚 Newcomer', Resident: '🏠 Resident', Steward: '🏛️ Steward', Elder: '⛰️ Elder' };
            if (!confirm(`Set tier badge to ${labels[tier] || tier}?\n\nThis adjusts the member's credit floor only — their balance is never touched.`)) {
                renderAdminMembers();
                return;
            }
            try {
                const res = await fetch('/api/local/admin/users/' + pubkey + '/tier', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tier, password: authToken })
                });
                if (res.ok) {
                    loadAdminData();
                } else {
                    const err = await res.json();
                    alert('Action failed: ' + (err.error || 'unknown error'));
                    renderAdminMembers();
                }
            } catch (err) {
                alert('Network error.');
                renderAdminMembers();
            }
        }

        // ======================== MODERATION: REPORT FILTER STATE ========================
        let reportFilterState = 'all';
        let postSearchDebounce = null;
        let selectedPostIds = new Set();
        let currentPostPage = 0;
        const POST_PAGE_SIZE = 25;

        function toggleReportFilter(filter) {
            reportFilterState = filter;
            document.querySelectorAll('[id^="report-filter-"]').forEach(b => {
                b.style.background = b.id === 'report-filter-' + filter ? '#3b82f6' : '';
                b.style.color = b.id === 'report-filter-' + filter ? '#fff' : '';
            });
            renderAdminReports();
        }

        function updateModBadge() {
            const badge = document.getElementById('mod-badge');
            const count = adminDataCache?.reportCount || 0;
            if (badge) {
                if (count > 0) {
                    badge.textContent = count;
                    badge.style.display = 'inline';
                } else {
                    badge.style.display = 'none';
                }
            }
        }

        function renderAdminReports() {
            const el = document.getElementById('admin-reports-inbox');
            if (!el) return;
            if (!adminDataCache) {
                el.innerHTML = `<div style="text-align:center;padding:1.5rem;color:#94a3b8;font-size:0.85rem;">
                    <div style="font-size:1.5rem;margin-bottom:0.5rem;">🔒</div>
                    <strong>Admin Authentication Required</strong><br>
                    <span style="font-size:0.75rem;color:#64748b;">Please enter the admin password in the top-right 🔒 Login box to unlock reports.</span>
                </div>`;
                return;
            }
            const reports = adminDataCache.reports || [];
            const filtered = reportFilterState === 'all' ? reports : reports.filter(r => r.status === reportFilterState);
            const pending = reports.filter(r => r.status === 'pending').length;
            
            const countBadge = document.getElementById('reports-count-badge');
            if (countBadge) countBadge.textContent = pending > 0 ? `(${pending} pending)` : '';

            if (filtered.length === 0) {
                el.innerHTML = `<div style="text-align:center;padding:1rem;">
                    <div style="font-size:1.2rem;">✅</div>
                    <div style="color:#22c55e;font-size:0.85rem;">No ${reportFilterState === 'all' ? '' : reportFilterState + ' '}reports</div>
                </div>`;
                return;
            }
            el.innerHTML = filtered.map(r => {
                const statusColor = r.status === 'pending' ? '#ef4444' : r.status === 'actioned' ? '#10b981' : '#64748b';
                const statusIcon = r.status === 'pending' ? '🔴' : r.status === 'actioned' ? '✅' : '👁️';
                return `
                <div style="padding:0.6rem 0.75rem;border-bottom:1px solid #1e293b;background:${r.status === 'pending' ? '#1a0a0a' : 'transparent'};">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.3rem;">
                        <div style="flex:1;">
                            <span style="font-size:0.8rem;font-weight:600;color:${statusColor};">${statusIcon} ${esc(r.reason)}</span>
                            <div style="font-size:0.75rem;color:#94a3b8;margin-top:0.2rem;">
                                <span style="color:#60a5fa;">${esc(r.reporterCallsign)}</span> → <span style="color:#f87171;">${esc(r.targetCallsign)}</span>
                            </div>
                            ${r.postTitle ? `<div style="font-size:0.7rem;color:#64748b;margin-top:0.1rem;">📦 "${esc(r.postTitle)}"</div>` : '<div style="font-size:0.7rem;color:#64748b;margin-top:0.1rem;">👤 User report (no specific post)</div>'}
                        </div>
                        <div style="display:flex;flex-direction:column;gap:0.25rem;align-items:flex-end;">
                            <span style="font-size:0.65rem;color:#64748b;">${new Date(r.createdAt).toLocaleDateString()}</span>
                            ${r.status === 'pending' ? `
                                <div style="display:flex;gap:0.25rem;">
                                    ${r.targetPostId ? `<button class="btn btn-sm btn-danger" onclick="reportAction('${r.id}', true)" style="padding:1px 6px;font-size:0.65rem;">🗑️ Delete Post</button>` : ''}
                                    <button class="btn btn-sm btn-outline" onclick="reportAction('${r.id}', false)" style="padding:1px 6px;font-size:0.65rem;">✓ Dismiss</button>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        window.reportAction = async function(reportId, deletePost) {
            const action = deletePost ? 'Delete the reported post and mark this report as actioned?' : 'Dismiss this report?';
            if (!confirm(action)) return;
            try {
                const endpoint = deletePost ? `/api/local/admin/reports/${reportId}/action` : `/api/local/admin/reports/${reportId}/dismiss`;
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, deletePost })
                });
                if (res.ok) { loadAdminData(); }
                else { alert('Action failed'); }
            } catch { alert('Network error'); }
        };

        function renderHealthAlerts() {
            const el = document.getElementById('admin-health-alerts');
            if (!el) return;
            if (!adminDataCache) {
                el.innerHTML = `<div style="text-align:center;padding:1rem;color:#64748b;font-size:0.8rem;">🔒 Authentication required</div>`;
                return;
            }
            const flags = adminDataCache.health?.flags || [];
            if (flags.length === 0) {
                el.innerHTML = '<div style="text-align:center;padding:0.75rem;"><div style="font-size:1rem;">✅</div><div style="color:#22c55e;font-size:0.8rem;">No health alerts</div></div>';
                return;
            }
            const icons = { wash_trading: '🔄', inactive_member: '💤', isolated_branch: '🏝️', invite_spam: '⚠️', sybil_funnel: '🕵️' };
            el.innerHTML = flags.map(f => `
                <div style="padding:0.5rem 0.75rem;border-bottom:1px solid #1e293b;display:flex;gap:0.5rem;align-items:flex-start;">
                    <span style="font-size:1rem;">${icons[f.type] || '⚠️'}</span>
                    <div>
                        <div style="font-size:0.8rem;font-weight:600;color:${f.severity === 'alert' ? '#ef4444' : '#f59e0b'};">${esc(f.description)}</div>
                        <div style="font-size:0.7rem;color:#64748b;margin-top:0.15rem;">${esc(f.members.join(', '))}</div>
                    </div>
                </div>
            `).join('');
        }

        function renderAdminPosts() {
            const el = document.getElementById('admin-posts-list');
            if (!el) return;
            if (!adminDataCache) {
                el.innerHTML = `<div style="text-align:center;padding:1.5rem;color:#94a3b8;font-size:0.85rem;">
                    <div style="font-size:1.5rem;margin-bottom:0.5rem;">🔒</div>
                    <strong>Admin Authentication Required</strong><br>
                    <span style="font-size:0.75rem;color:#64748b;">Please enter the admin password in the top-right 🔒 Login box to view all posts.</span>
                </div>`;
                return;
            }
            
            const searchQ = (document.getElementById('admin-post-search')?.value || '').toLowerCase().trim();
            const typeFilter = document.getElementById('admin-post-type-filter')?.value || 'all';
            const catFilter = document.getElementById('admin-post-category-filter')?.value || 'all';
            
            let posts = adminDataCache.posts.filter(p => (p.status !== 'cancelled' && p.active !== 0));
            
            // Apply filters
            if (typeFilter !== 'all') posts = posts.filter(p => p.type === typeFilter);
            if (catFilter !== 'all') posts = posts.filter(p => p.category === catFilter);
            if (searchQ) posts = posts.filter(p => 
                (p.title || '').toLowerCase().includes(searchQ) || 
                (p.authorCallsign || '').toLowerCase().includes(searchQ) ||
                (p.description || '').toLowerCase().includes(searchQ)
            );
            
            // Sort by date desc
            posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            
            // Get report counts per post
            const reportsByPost = {};
            (adminDataCache.reports || []).forEach(r => {
                if (r.targetPostId) {
                    reportsByPost[r.targetPostId] = (reportsByPost[r.targetPostId] || 0) + 1;
                }
            });

            // Pagination
            const totalFiltered = posts.length;
            const totalPages = Math.ceil(totalFiltered / POST_PAGE_SIZE);
            if (currentPostPage >= totalPages) currentPostPage = Math.max(0, totalPages - 1);
            const startIdx = currentPostPage * POST_PAGE_SIZE;
            const pageSlice = posts.slice(startIdx, startIdx + POST_PAGE_SIZE);

            // Update count label
            const countLabel = document.getElementById('post-count-label');
            if (countLabel) {
                if (totalFiltered <= POST_PAGE_SIZE) {
                    countLabel.textContent = `${totalFiltered} post${totalFiltered !== 1 ? 's' : ''}`;
                } else {
                    countLabel.textContent = `${startIdx + 1}–${Math.min(startIdx + POST_PAGE_SIZE, totalFiltered)} of ${totalFiltered}`;
                }
            }

            if (totalFiltered === 0) { 
                el.innerHTML = '<div style="padding:1rem;text-align:center;color:#64748b;">No posts match your filters</div>'; 
                return; 
            }
            
            let html = pageSlice.map(p => {
                const isSelected = selectedPostIds.has(p.id);
                const reportCount = reportsByPost[p.id] || 0;
                return `
                <div style="padding:0.5rem 0.75rem;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center;background:${isSelected ? '#1e293b' : 'transparent'};">
                    <div style="display:flex;align-items:center;gap:0.5rem;flex:1;min-width:0;">
                        <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="togglePostSelect('${esc(p.id)}')" style="accent-color:#f59e0b;cursor:pointer;">
                        <div style="min-width:0;flex:1;">
                            <div style="font-size:0.85rem;font-weight:600;color:${p.status==='active'?'#10b981':'#64748b'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                                ${esc(p.title) || 'Untitled'}
                                ${reportCount > 0 ? `<span style="background:#ef4444;color:#fff;font-size:0.6rem;padding:1px 4px;border-radius:6px;margin-left:4px;">🚩 ${reportCount}</span>` : ''}
                            </div>
                            <div style="font-size:0.7rem;color:#94a3b8;">${esc(p.authorCallsign) || 'Anon'} · ${esc(p.type)} · ${esc(p.category || 'general')} · ${new Date(p.createdAt).toLocaleDateString()}</div>
                        </div>
                    </div>
                    <div style="display:flex;gap:0.3rem;">
                        <button class="btn btn-sm btn-outline" onclick="viewMemberPosts('${esc(p.authorPublicKey)}')" title="View all posts by this author" style="padding:2px 6px;font-size:0.7rem;">👤</button>
                        <button class="btn btn-sm btn-danger" onclick="adminAction('/posts/${esc(p.id)}/delete')" style="padding:2px 6px;font-size:0.7rem;" aria-label="Delete post" title="Delete post">🗑️</button>
                    </div>
                </div>`;
            }).join('');

            // Pagination controls
            if (totalPages > 1) {
                html += `<div style="display:flex;justify-content:center;align-items:center;gap:0.75rem;padding:0.6rem;border-top:1px solid #334155;">
                    <button class="btn btn-sm btn-outline" onclick="postPageNav(-1)" ${currentPostPage === 0 ? 'disabled style="opacity:0.3;padding:2px 8px;"' : 'style="padding:2px 8px;"'}>◀ Prev</button>
                    <span style="font-size:0.75rem;color:#94a3b8;">Page ${currentPostPage + 1} of ${totalPages}</span>
                    <button class="btn btn-sm btn-outline" onclick="postPageNav(1)" ${currentPostPage >= totalPages - 1 ? 'disabled style="opacity:0.3;padding:2px 8px;"' : 'style="padding:2px 8px;"'}>Next ▶</button>
                </div>`;
            }

            el.innerHTML = html;
            updateBatchBar();
        }

        window.postPageNav = function(dir) {
            currentPostPage = Math.max(0, currentPostPage + dir);
            renderAdminPosts();
        };

        // Post search and filter event listeners
        document.getElementById('admin-post-search')?.addEventListener('input', () => {
            currentPostPage = 0;
            if (postSearchDebounce) clearTimeout(postSearchDebounce);
            postSearchDebounce = setTimeout(renderAdminPosts, 300);
        });
        document.getElementById('admin-post-type-filter')?.addEventListener('change', () => { currentPostPage = 0; renderAdminPosts(); });
        document.getElementById('admin-post-category-filter')?.addEventListener('change', () => { currentPostPage = 0; renderAdminPosts(); });

        // Batch selection functions
        window.togglePostSelect = function(id) {
            if (selectedPostIds.has(id)) selectedPostIds.delete(id);
            else selectedPostIds.add(id);
            updateBatchBar();
            renderAdminPosts();
        };

        function updateBatchBar() {
            const bar = document.getElementById('batch-action-bar');
            const countEl = document.getElementById('selected-count');
            if (bar && countEl) {
                bar.style.display = selectedPostIds.size > 0 ? 'flex' : 'none';
                countEl.textContent = selectedPostIds.size;
            }
        }

        window.selectAllPosts = function() {
            if (!adminDataCache) return;
            const searchQ = (document.getElementById('admin-post-search')?.value || '').toLowerCase().trim();
            const typeFilter = document.getElementById('admin-post-type-filter')?.value || 'all';
            const catFilter = document.getElementById('admin-post-category-filter')?.value || 'all';
            let posts = adminDataCache.posts.filter(p => (p.status !== 'cancelled' && p.active !== 0));
            if (typeFilter !== 'all') posts = posts.filter(p => p.type === typeFilter);
            if (catFilter !== 'all') posts = posts.filter(p => p.category === catFilter);
            if (searchQ) posts = posts.filter(p => (p.title || '').toLowerCase().includes(searchQ) || (p.authorCallsign || '').toLowerCase().includes(searchQ));
            posts.forEach(p => selectedPostIds.add(p.id));
            renderAdminPosts();
        };

        window.deselectAllPosts = function() {
            selectedPostIds.clear();
            renderAdminPosts();
        };

        window.bulkDeletePosts = async function() {
            if (selectedPostIds.size === 0) return;
            if (!confirm(`Delete ${selectedPostIds.size} post${selectedPostIds.size > 1 ? 's' : ''}? This will refund any pending escrows.`)) return;
            try {
                const res = await fetch('/api/local/admin/posts/bulk-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ postIds: [...selectedPostIds], password: authToken })
                });
                const data = await res.json();
                if (data.success) {
                    alert(`Deleted ${data.deleted} post${data.deleted !== 1 ? 's' : ''}.`);
                    selectedPostIds.clear();
                    loadAdminData();
                } else {
                    alert('Bulk delete failed: ' + (data.error || 'Unknown error'));
                }
            } catch { alert('Network error'); }
        };

        // Cross-tab: view posts by a specific author
        window.viewMemberPosts = function(pubkey) {
            switchTab('moderation');
            const member = adminDataCache?.members?.find(m => m.publicKey === pubkey);
            const searchEl = document.getElementById('admin-post-search');
            if (searchEl && member) {
                searchEl.value = member.callsign || pubkey.substring(0, 8);
                renderAdminPosts();
            }
        };

        let auditFilter = 'all';
        window.setAuditFilter = function(filter) {
            auditFilter = auditFilter === filter ? 'all' : filter;
            document.querySelectorAll('.audit-filter-btn').forEach(btn => {
                const isActive = btn.dataset.filter === auditFilter;
                btn.style.background = isActive ? '#334155' : 'transparent';
                btn.style.borderColor = isActive ? '#60a5fa' : '#334155';
            });
            renderAdminMembers();
        };

        // Free-text member search (callsign or public key). Works alongside the flag filters:
        // a node must satisfy both the active filter and the search term to count as a match.
        let memberSearch = '';
        window.setMemberSearch = function(val) {
            memberSearch = val || '';
            const input = document.getElementById('member-search');
            if (input && input.value !== memberSearch) input.value = memberSearch;
            const clearBtn = document.getElementById('member-search-clear');
            if (clearBtn) clearBtn.style.display = memberSearch ? 'block' : 'none';
            renderAdminMembers();
        };

        function renderAdminMembers() {
            const el = document.getElementById('admin-members-tree');
            if (!el) return;
            if (!adminDataCache) {
                el.innerHTML = `<div style="text-align:center;padding:2rem;color:#94a3b8;font-size:0.85rem;">
                    <div style="font-size:1.5rem;margin-bottom:0.5rem;">🔒</div>
                    <strong>Admin Authentication Required</strong><br>
                    <span style="font-size:0.75rem;color:#64748b;">Please enter the admin password in the top-right 🔒 Login box to view the audit tree.</span>
                </div>`;
                return;
            }
            const { members, profiles, health, reports, memberStats } = adminDataCache;
            const flags = health?.flags || [];
            const stats = memberStats || {};
            
            // Build report counts per target pubkey
            const reportsByMember = {};
            (reports || []).filter(r => r.status === 'pending').forEach(r => {
                reportsByMember[r.targetPubkey] = (reportsByMember[r.targetPubkey] || 0) + 1;
            });
            
            const nodeFlags = {}; // pubkey -> array of flags directly on this user
            flags.forEach(f => {
                f.members.forEach(m => {
                    if (!nodeFlags[m]) nodeFlags[m] = [];
                    nodeFlags[m].push(f);
                });
            });

            // Map members by invitedBy to build tree
            const tree = {};
            members.forEach(m => {
                const inv = m.invitedBy || 'genesis';
                if (!tree[inv]) tree[inv] = [];
                tree[inv].push(m);
            });

            const branchFlagsCache = {};
            function getBranchFlags(pubkey) {
                if (branchFlagsCache[pubkey]) return branchFlagsCache[pubkey];
                const direct = nodeFlags[pubkey] || [];
                const children = tree[pubkey] || [];
                let all = [...direct];
                children.forEach(c => all.push(...getBranchFlags(c.publicKey)));
                
                // Deduplicate by description
                const unique = [];
                const seen = new Set();
                all.forEach(f => {
                    if (!seen.has(f.description)) {
                        seen.add(f.description);
                        unique.push(f);
                    }
                });
                branchFlagsCache[pubkey] = unique;
                return unique;
            }

            // Recursive branch stats aggregation
            const branchStatsCache = {};
            function computeBranchStats(pubkey) {
                if (branchStatsCache[pubkey]) return branchStatsCache[pubkey];
                const personal = stats[pubkey] || { posts: 0, messages: 0, deals: 0, volume: 0, cancelled: 0 };
                const children = tree[pubkey] || [];
                const agg = { ...personal, memberCount: 1 };
                children.forEach(c => {
                    const childAgg = computeBranchStats(c.publicKey);
                    agg.posts += childAgg.posts;
                    agg.messages += childAgg.messages;
                    agg.deals += childAgg.deals;
                    agg.volume += childAgg.volume;
                    agg.cancelled += childAgg.cancelled;
                    agg.memberCount += childAgg.memberCount;
                });
                agg.volume = Math.round(agg.volume * 100) / 100;
                branchStatsCache[pubkey] = agg;
                return agg;
            }

            function buildNode(pubkey, depth = 0) {
                const member = members.find(m => m.publicKey === pubkey);
                if (!member) return '';
                const profile = profiles.find(p => p && p.publicKey === pubkey);
                const children = tree[pubkey] || [];
                const isPruned = profile?.status === 'pruned';
                const isActive = !profile || profile.status === 'active' || profile.status === undefined;
                const isGenesis = depth === 0;
                const memberReportCount = reportsByMember[pubkey] || 0;
                
                const isSystemAccount = pubkey === 'SYSTEM' || member.callsign === 'Admin' || member.callsign === 'System';
                // Tier badge lives in the granted-credit lane (earned_credit column) at fixed grant
                // values (Resident 200, Steward 600, Elder 1400; Newcomer clears it — protocol.ts).
                // Derive the current badge here so the tier picker and the Elder pill agree on one
                // source of truth. adminSetTier is the single lever behind both.
                const earnedGrant = member.earnedCredit || 0;
                const badgeTier = earnedGrant >= 1320 ? 'Elder'
                    : earnedGrant >= 600 ? 'Steward'
                    : earnedGrant >= 200 ? 'Resident'
                    : 'Newcomer';
                const isElderGranted = badgeTier === 'Elder';
                // Appointed-voucher capability (members.can_vouch) — surfaced by the admin /data
                // endpoint. Distinct from tier: it's the explicit power to hand out the welcome floor.
                const canV = !!member.canVouch;

                const bFlags = getBranchFlags(pubkey);
                const hasFlags = bFlags.length > 0;
                const isAlert = bFlags.some(f => f.severity === 'alert');
                
                let flagPill = '';
                if (hasFlags) {
                    flagPill = `<span style="background:${isAlert ? '#ef4444' : '#f59e0b'};color:#fff;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:12px;margin-left:0.4rem;font-weight:700;" title="${bFlags.map(f => esc(f.type.replace('_',' '))).join(', ')}">${bFlags.length} ⚠️</span>`;
                }
                let reportPill = '';
                if (memberReportCount > 0) {
                    reportPill = `<span style="background:#ef4444;color:#fff;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:12px;margin-left:0.3rem;font-weight:700;" title="${memberReportCount} pending report${memberReportCount > 1 ? 's' : ''}">🚩 ${memberReportCount}</span>`;
                }
                let elderPill = '';
                if (isElderGranted) {
                    elderPill = `<span style="background:#f59e0b;color:#fff;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:12px;margin-left:0.3rem;font-weight:700;" title="Elder tier badge — floor −1400">⛰️ Elder</span>`;
                }
                let voucherPill = '';
                if (canV) {
                    voucherPill = `<span style="background:#10b981;color:#fff;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:12px;margin-left:0.3rem;font-weight:700;" title="Appointed voucher — can verify (vouch for) newcomers, handing them the welcome floor">🤝 Voucher</span>`;
                }

                // Personal stat chips (compact inline indicators)
                const s = stats[pubkey] || { posts: 0, messages: 0, deals: 0, volume: 0, cancelled: 0 };
                let chipHtml = '<span style="display:inline-flex;gap:3px;margin-left:0.4rem;vertical-align:middle;">';
                if (s.posts > 0) chipHtml += `<span class="stat-chip posts" title="${s.posts} active posts">📦${s.posts}</span>`;
                if (s.messages > 0) chipHtml += `<span class="stat-chip msgs" title="${s.messages} messages sent">💬${s.messages}</span>`;
                if (s.deals > 0) chipHtml += `<span class="stat-chip deals" title="${s.deals} completed deals · B${s.volume} volume">🤝${s.deals}</span>`;
                if (s.cancelled > 0) chipHtml += `<span class="stat-chip cancelled" title="${s.cancelled} cancelled escrows">🚫${s.cancelled}</span>`;
                chipHtml += '</span>';

                // Branch stats card (expandable)
                const branchStats = computeBranchStats(pubkey);
                const hasBranch = children.length > 0;
                const statsCardId = `stats-${pubkey.slice(0,12)}`;
                let statsBtn = '';
                let statsCard = '';
                if (hasBranch || s.deals > 0 || s.posts > 0) {
                    statsBtn = `<button class="btn btn-sm btn-outline" onclick="event.preventDefault();event.stopPropagation();const c=document.getElementById('${statsCardId}');c.style.display=c.style.display==='none'?'grid':'none';" title="Toggle stats">📊</button>`;
                    statsCard = `<div id="${statsCardId}" class="stats-card" style="display:none;">
                        <div class="stat-row"><span class="label">📦 Posts</span><span class="value">${s.posts}</span></div>
                        <div class="stat-row"><span class="label">💬 Messages</span><span class="value">${s.messages}</span></div>
                        <div class="stat-row"><span class="label">🤝 Deals</span><span class="value">${s.deals}</span></div>
                        <div class="stat-row"><span class="label">💰 Volume</span><span class="value">B${s.volume}</span></div>
                        <div class="stat-row"><span class="label">🚫 Cancelled</span><span class="value">${s.cancelled}</span></div>
                        ${hasBranch ? `
                        <div class="stat-row full-width" style="background:#0f172a;border:1px solid #334155;margin-top:0.2rem;">
                            <span class="label" style="color:#60a5fa;">🌳 Branch (${branchStats.memberCount} members)</span>
                            <span class="value" style="color:#60a5fa;">📦${branchStats.posts} 💬${branchStats.messages} 🤝${branchStats.deals} 💰B${branchStats.volume}</span>
                        </div>` : ''}
                    </div>`;
                }

                const childrenHtml = children.map(c => buildNode(c.publicKey, depth + 1)).join('');

                // Filter + search: a node "matches" only if it satisfies BOTH the active flag filter
                // and the free-text search term. Non-matching ancestors are kept (dimmed) so a deep
                // match still shows its place in the tree.
                const directFlags = nodeFlags[member.callsign] || nodeFlags[pubkey] || [];
                const matchesType = auditFilter === 'all' ? true
                    : auditFilter === 'reported' ? memberReportCount > 0
                    : auditFilter === 'voucher' ? canV
                    : directFlags.some(f => f.type === auditFilter);
                const q = memberSearch.trim().toLowerCase();
                const matchesSearch = !q
                    || (member.callsign || '').toLowerCase().includes(q)
                    || pubkey.toLowerCase().includes(q);
                const matchesFilter = matchesType && matchesSearch;
                const filterActive = auditFilter !== 'all' || !!q;

                if (matchesFilter) matchCount++;

                if (filterActive && !matchesFilter && !childrenHtml.trim()) {
                    return ''; // No match and no matching descendants — hide completely
                }

                const dimStyle = (filterActive && !matchesFilter) ? 'opacity:0.4;' : '';
                const isSearchHit = !!q && matchesFilter;

                const hasChildren = children.length > 0;

                let html = `
                    <details class="${isSearchHit ? 'search-hit' : ''}" ${depth < 3 || hasFlags || memberReportCount > 0 || filterActive ? 'open' : ''} style="margin-left:${depth === 0 ? 0 : 15}px;">
                        <summary style="background:#1e293b; border-left:3px solid ${isPruned ? '#475569' : isActive ? '#10b981' : '#f59e0b'}; border-radius:0 8px 8px 0; cursor:${hasChildren ? 'pointer' : 'default'}; ${dimStyle}">
                            <div class="member-node">
                                <span class="member-tri" ${hasChildren ? '' : 'style="visibility:hidden;"'}>▶</span>
                                <div class="member-body">
                                    <div class="member-head">
                                        <strong style="color:${isPruned ? '#64748b' : isActive ? '#f8fafc' : '#f59e0b'}">${isPruned ? '🗑️ ' : !isActive ? '⏸️ ' : ''}${esc(member.callsign)} <span class="member-id">(${pubkey.substring(0,8)})</span></strong>
                                        ${flagPill}${reportPill}${elderPill}${voucherPill}${chipHtml}
                                    </div>
                                    <div class="member-active">Active: ${profile?.lastActiveAt ? new Date(profile.lastActiveAt).toLocaleString() : 'Never'}</div>
                                    <div class="member-actions">
                                        ${statsBtn}
                                        <button class="btn btn-sm btn-outline" onclick="event.preventDefault(); viewMemberPosts('${pubkey}')" title="View posts by this member">📦 Posts</button>
                                        ${!isGenesis && !isPruned ? `<button class="btn btn-sm ${isActive?'btn-outline':'btn-primary'}" onclick="event.preventDefault(); adminAction('/users/${pubkey}/status', {status:'${isActive?'disabled':'active'}'})">${isActive?'Pause':'Resume'}</button>` : ''}
                                        ${!isSystemAccount && !isPruned ? `<select class="tier-select" onclick="event.stopPropagation();" onchange="setMemberTier('${pubkey}', this.value)" title="Tier badge — sets this member's credit floor (Resident −200, Steward −600, Elder −1400; Newcomer clears the grant). This widens/narrows their credit limit only — their balance is never touched.">
                                            <option value="Newcomer" ${badgeTier==='Newcomer'?'selected':''}>🥚 Newcomer</option>
                                            <option value="Resident" ${badgeTier==='Resident'?'selected':''}>🏠 Resident</option>
                                            <option value="Steward" ${badgeTier==='Steward'?'selected':''}>🏛️ Steward</option>
                                            <option value="Elder" ${badgeTier==='Elder'?'selected':''}>⛰️ Elder</option>
                                        </select>` : ''}
                                        ${!isSystemAccount && !isPruned ? (canV
                                            ? `<button class="btn btn-sm" style="background:#10b981;color:#fff;border-color:#10b981;" onclick="event.preventDefault(); adminAction('/users/${pubkey}/voucher', {grant:false})" title="Revoke the vouch capability — this member can no longer hand the welcome floor to newcomers. Mints/moves no beans.">🤝 Voucher ✓</button>`
                                            : `<button class="btn btn-sm btn-outline" style="border-color:#10b981;color:#34d399;" onclick="event.preventDefault(); adminAction('/users/${pubkey}/voucher', {grant:true})" title="Grant the vouch capability so this trusted member can verify (vouch for) newcomers, handing them the welcome floor. Mints/moves no beans.">🤝 Grant vouch</button>`) : ''}
                                        ${!isSystemAccount && !isPruned ? `<button class="btn btn-sm btn-danger" onclick="event.preventDefault(); adminAction('/users/${pubkey}/prune')">Prune User</button>` : ''}
                                        ${!isSystemAccount && children.length > 0 ? `<button class="btn btn-sm btn-danger" onclick="event.preventDefault(); adminAction('/branches/${pubkey}/prune')">Prune Branch</button>` : ''}
                                        ${!isPruned ? `<button class="btn btn-sm btn-primary" style="background:#2563eb;color:#fff;border-color:#2563eb;" onclick="event.preventDefault(); promptWarning('${pubkey}')">✉️ Message</button>` : ''}
                                    </div>
                                </div>
                            </div>
                        </summary>
                        ${statsCard}
                        <div>
                            ${childrenHtml}
                        </div>
                    </details>
                `;
                return html;
            }

            let matchCount = 0; // incremented inside buildNode for every node matching the filter/search
            const roots = tree['genesis'] || [];
            if (roots.length === 0) {
                el.innerHTML = '<div style="padding:1rem;color:#64748b;">No tree found</div>';
            } else {
                const rendered = roots.map(r => buildNode(r.publicKey, 0)).join('');
                el.innerHTML = rendered.trim()
                    ? rendered
                    : `<div style="padding:1.25rem;color:#64748b;text-align:center;">No members match ${memberSearch.trim() ? '“' + esc(memberSearch.trim()) + '”' : 'this filter'}.</div>`;
            }

            // Result count next to the search box — reflects the active search/filter.
            const totalMembers = members.filter(m => m.publicKey !== 'SYSTEM').length;
            const countEl = document.getElementById('member-result-count');
            if (countEl) {
                const filtering = auditFilter !== 'all' || !!memberSearch.trim();
                countEl.textContent = filtering ? `${matchCount} of ${totalMembers} match` : `${totalMembers} members`;
            }

            // Update filter count badges (count unique members, not flag instances)
            const membersByFlag = {};
            flags.forEach(f => {
                if (!membersByFlag[f.type]) membersByFlag[f.type] = new Set();
                f.members.forEach(m => membersByFlag[f.type].add(m));
            });
            document.querySelectorAll('.filter-count').forEach(el => {
                const type = el.dataset.count;
                const count = type === 'reported'
                    ? Object.keys(reportsByMember).length
                    : type === 'voucher'
                    ? members.filter(m => m.canVouch).length
                    : membersByFlag[type]?.size || 0;
                el.textContent = count > 0 ? count : '';
            });
            
            window.promptWarning = async function(pubkey) {
                // Switch to the Inbox & Comms tab
                switchTab('comms');
                // Load inbox data then auto-select the user
                await loadAdminInbox();
                selectInboxUser(pubkey);
                // Focus the input so admin can start typing immediately
                const inp = document.getElementById('admin-inbox-input');
                if (inp) { inp.disabled = false; inp.focus(); }
            }
        }

        document.getElementById('btn-send-announcement')?.addEventListener('click', async () => {
            if (!authToken) return;
            const payload = {
                title: document.getElementById('admin-announce-title').value,
                body: document.getElementById('admin-announce-body').value,
                severity: document.getElementById('admin-announce-severity').value
            };
            try {
                const res = await fetch('/api/local/admin/announcements', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...payload, password: authToken })
                });
                if (res.ok) { showStatus('announce-status', '✅ Sent', 'success'); }
                else { showStatus('announce-status', 'Failed', 'error'); }
            } catch (e) { showStatus('announce-status', 'Error', 'error'); }
        });

        // ======================== ADMIN INBOX ========================
        let inboxDataCache = null;
        let inboxSelectedUser = null;
        let inboxAdminPubkey = null;

        function decodePlaintext(ciphertext, nonce) {
            try {
                if (nonce.startsWith('plaintext')) {
                    const text = decodeURIComponent(escape(atob(ciphertext)));
                    try {
                        const parsed = JSON.parse(text);
                        if (parsed.type === 'marketplace_request') {
                            const icons = { request: '📨', accept: '🤝', complete: '✅', reject: '❌', cancel: '🚫' };
                            return `<em>${icons[parsed.stage] || '🔄'} [Escrow System Event: ${esc(parsed.stage.toUpperCase())}]</em>`;
                        }
                    } catch {}
                    return esc(text);
                }
                return `<em>[Encrypted ${esc(nonce)}]</em>`;
            } catch { return '<em>[Encrypted]</em>'; }
        }

        async function loadAdminInbox() {
            if (!authToken) return;
            // Need members to build the user list
            if (!adminDataCache) await loadAdminData();
            
            try {
                const res = await fetch('/api/local/admin/inbox', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (res.ok) {
                    const data = await res.json();
                    inboxDataCache = data.conversations;
                    inboxAdminPubkey = data.adminPubkey;
                    renderAdminInboxList();
                    if (inboxSelectedUser) renderAdminInboxChat();
                }
            } catch (err) { console.error('Failed to load inbox', err); }
        }

        let showAllMembers = false;
        
        function renderAdminInboxList() {
            const listEl = document.getElementById('admin-inbox-list');
            if (!listEl || !adminDataCache) return;

            const searchTerm = document.getElementById('admin-inbox-search').value.toLowerCase();
            
            // Build a list of users, excluding the admin themselves
            let users = adminDataCache.members
                .filter(m => m.publicKey !== inboxAdminPubkey)
                .map(m => {
                const profile = adminDataCache.profiles.find(p => p.publicKey === m.publicKey);
                const conv = (inboxDataCache || []).find(c => c.participants.includes(m.publicKey));
                const lastMessage = conv?.messages?.length ? conv.messages[conv.messages.length - 1] : null;
                const unreadCount = conv?.unreadCount || 0;
                return {
                    publicKey: m.publicKey,
                    callsign: profile?.callsign || m.callsign,
                    conv,
                    lastMessage,
                    unreadCount
                };
            });

            // Filter by search
            if (searchTerm) {
                users = users.filter(u => u.callsign.toLowerCase().includes(searchTerm) || u.publicKey.toLowerCase().includes(searchTerm));
            }

            // Default: only show users with active conversations (unless toggled or searching)
            if (!showAllMembers && !searchTerm) {
                users = users.filter(u => u.conv && u.conv.messages && u.conv.messages.length > 0);
            }

            // Sort: unread first, then by most recent message
            users.sort((a, b) => {
                if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
                if (b.unreadCount > 0 && a.unreadCount === 0) return 1;
                const timeA = a.lastMessage ? new Date(a.lastMessage.timestamp).getTime() : 0;
                const timeB = b.lastMessage ? new Date(b.lastMessage.timestamp).getTime() : 0;
                return timeB - timeA;
            });

            const INBOX_MAX = 50;
            const totalUsers = users.length;
            const isTruncated = !searchTerm && users.length > INBOX_MAX;
            if (isTruncated) users = users.slice(0, INBOX_MAX);

            let html = users.map(u => `
                <div class="inbox-user-item" onclick="selectInboxUser('${u.publicKey}')" style="padding: 0.75rem; border-bottom: 1px solid #1e293b; cursor: pointer; background: ${inboxSelectedUser?.publicKey === u.publicKey ? '#1e293b' : 'transparent'}; transition: background 0.2s; display:flex; justify-content:space-between; align-items:center;">
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight: ${u.unreadCount > 0 ? '700' : '600'}; font-size: 0.85rem; color: #f8fafc;">${esc(u.callsign)}</div>
                        <div style="font-size: 0.7rem; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 0.2rem;">
                            ${u.lastMessage ? decodePlaintext(u.lastMessage.ciphertext, u.lastMessage.nonce) : '<em>No messages yet</em>'}
                        </div>
                    </div>
                    ${u.unreadCount > 0 ? `<span style="background:#ef4444;color:#fff;font-size:0.6rem;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;margin-left:0.5rem;box-shadow:0 0 6px rgba(239,68,68,0.6);">${u.unreadCount > 99 ? '99+' : u.unreadCount}</span>` : ''}
                </div>
            `).join('');

            if (isTruncated) {
                html += `<div style="padding:0.4rem;text-align:center;font-size:0.7rem;color:#64748b;border-top:1px solid #1e293b;">Showing ${INBOX_MAX} of ${totalUsers} — use search to find others</div>`;
            }

            // Show all members toggle
            if (!searchTerm) {
                html += `<div onclick="showAllMembers=!showAllMembers;renderAdminInboxList();" style="padding:0.5rem;text-align:center;cursor:pointer;color:#3b82f6;font-size:0.75rem;border-top:1px solid #1e293b;">${showAllMembers ? '▲ Show active only' : '▼ Show all members'}</div>`;
            }

            listEl.innerHTML = html;
        }

        function selectInboxUser(pubkey) {
            inboxSelectedUser = adminDataCache.members.find(m => m.publicKey === pubkey);
            const profile = adminDataCache.profiles.find(p => p.publicKey === pubkey);
            if (inboxSelectedUser) inboxSelectedUser.callsign = profile?.callsign || inboxSelectedUser.callsign;
            
            // Mark conversation as read (admin perspective)
            if (inboxAdminPubkey) {
                const conv = (inboxDataCache || []).find(c => c.participants.includes(pubkey));
                if (conv) {
                    fetch('/api/messages/mark-read', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pubkey: inboxAdminPubkey, conversationId: conv.id })
                    }).catch(() => {});
                    // Clear unread count locally
                    if (conv.unreadCount) conv.unreadCount = 0;
                }
            }
            
            document.getElementById('admin-inbox-input').disabled = false;
            document.getElementById('admin-inbox-send').disabled = false;
            renderAdminInboxList(); // update highlight
            renderAdminInboxChat();
        }

        function renderAdminInboxChat() {
            const headerEl = document.getElementById('admin-inbox-header');
            const messagesEl = document.getElementById('admin-inbox-messages');
            if (!headerEl || !messagesEl) return;

            if (!inboxSelectedUser) {
                headerEl.textContent = 'Select a conversation';
                messagesEl.innerHTML = '<div style="margin:auto;color:#475569;font-size:0.85rem;">No conversation selected</div>';
                return;
            }

            headerEl.textContent = 'Chat with ' + inboxSelectedUser.callsign;

            const conv = (inboxDataCache || []).find(c => c.participants.includes(inboxSelectedUser.publicKey));
            const messages = conv?.messages || [];

            if (messages.length === 0) {
                messagesEl.innerHTML = '<div style="margin:auto;color:#475569;font-size:0.85rem;">No messages yet. Send a warning to start the conversation.</div>';
                return;
            }

            messagesEl.innerHTML = messages.map(msg => {
                const isAdmin = msg.authorPubkey === inboxAdminPubkey || msg.authorPubkey === 'system';
                return `
                    <div style="align-self: ${isAdmin ? 'flex-end' : 'flex-start'}; max-width: 80%;">
                        <div style="background: ${isAdmin ? '#2563eb' : '#1e293b'}; border-radius: ${isAdmin ? '12px 12px 2px 12px' : '12px 12px 12px 2px'}; padding: 0.5rem 0.8rem; font-size: 0.85rem; color: #f8fafc; word-break: break-word;">
                            ${decodePlaintext(msg.ciphertext, msg.nonce)}
                        </div>
                        <div style="font-size: 0.65rem; color: #64748b; margin-top: 0.2rem; text-align: ${isAdmin ? 'right' : 'left'};">
                            ${new Date(msg.timestamp).toLocaleString()}
                        </div>
                    </div>
                `;
            }).join('');
            
            // Scroll to bottom
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        document.getElementById('admin-inbox-search')?.addEventListener('input', renderAdminInboxList);

        document.getElementById('admin-inbox-send')?.addEventListener('click', async () => {
            if (!authToken || !inboxSelectedUser) return;
            const inputEl = document.getElementById('admin-inbox-input');
            const message = inputEl.value.trim();
            if (!message) return;

            inputEl.disabled = true;
            try {
                const res = await fetch('/api/local/admin/inbox/send', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetPubkey: inboxSelectedUser.publicKey, message, password: authToken })
                });
                if (res.ok) {
                    inputEl.value = '';
                    await loadAdminInbox(); // refresh
                } else { alert('Failed to send message'); }
            } catch (e) { alert('Network error'); }
            finally { inputEl.disabled = false; inputEl.focus(); }
        });
        
        document.getElementById('admin-inbox-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('admin-inbox-send').click();
        });



        // ======================== DATABASE BACKUP ========================
        async function downloadBackup() {
            if (!authToken) return;
            const btn = document.getElementById('btn-backup');
            const statusEl = document.getElementById('backup-status');
            btn.disabled = true;
            btn.textContent = '⏳ Creating backup...';
            statusEl.textContent = '';
            try {
                const res = await fetch('/api/local/admin/backup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const disposition = res.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="(.+?)"/);
                a.download = match ? match[1] : `beanpool-backup-${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.tar.gz`;
                a.href = url;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                statusEl.textContent = '✅ Backup downloaded';
                statusEl.style.color = '#10b981';
            } catch (e) {
                statusEl.textContent = '❌ ' + e.message;
                statusEl.style.color = '#ef4444';
            } finally {
                btn.disabled = false;
                btn.textContent = '💾 Download Backup';
            }
        }
        // Make it globally accessible for onclick
        window.downloadBackup = downloadBackup;

        async function uploadBackup() {
            if (!authToken) return;
            const input = document.getElementById('backup-upload-input');
            if (!input.files || input.files.length === 0) return;
            
            const file = input.files[0];
            const statusEl = document.getElementById('restore-status');
            const labelEl = input.parentElement;
            const btn = document.getElementById('btn-backup');
            
            if (!confirm(`WARNING: This will completely overwrite your node's current database with the uploaded backup (${file.name}). This action cannot be undone.\n\nAre you sure you want to proceed?`)) {
                input.value = '';
                return;
            }

            labelEl.style.pointerEvents = 'none';
            labelEl.style.opacity = '0.5';
            labelEl.innerHTML = '⏳ Uploading...';
            btn.disabled = true;
            statusEl.textContent = '';
            
            try {
                const res = await fetch(`/api/local/admin/restore`, {
                    method: 'POST',
                    headers: {
                        'X-Admin-Password': authToken
                    },
                    body: file // Send as raw binary stream
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }

                statusEl.innerHTML = '✅ <b>Restore successful!</b><br/>The node is restarting. If you are not using a process manager (like Docker or PM2), your server has stopped and you must <b>restart it manually</b>.';
                statusEl.style.color = '#10b981';
                statusEl.classList.add('show');
                
                // Attempt to reload after 5 seconds to show login or re-connect
                setTimeout(() => {
                    window.location.reload();
                }, 5000);

            } catch (e) {
                statusEl.textContent = '❌ ' + e.message;
                statusEl.style.color = '#ef4444';
                statusEl.classList.add('show');
                labelEl.style.pointerEvents = 'auto';
                labelEl.style.opacity = '1';
                labelEl.innerHTML = '<input type="file" id="backup-upload-input" accept=".tar.gz" style="display:none;" onchange="uploadBackup()">📂 Upload Restore';
                btn.disabled = false;
                input.value = '';
            }
        }
        window.uploadBackup = uploadBackup;

        // ======================== BACKUP TAB ========================
        function relativeTime(ms) {
            if (!ms) return 'never';
            const diff = Date.now() - ms;
            if (diff < 0) return 'just now';
            const s = Math.floor(diff / 1000);
            if (s < 60) return `${s}s ago`;
            const m = Math.floor(s / 60);
            if (m < 60) return `${m}m ago`;
            const h = Math.floor(m / 60);
            if (h < 24) return `${h}h ago`;
            const d = Math.floor(h / 24);
            return `${d}d ago`;
        }

        function fmtBytes(n) {
            if (!n && n !== 0) return '—';
            if (n < 1024) return `${n} B`;
            if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
            if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
            return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
        }

        // Entry point when the Backup tab opens: load everything.
        function loadBackupTab() {
            loadBackupStatus();
            loadAutoSnapConfig();
            loadSnapshots();
            // Reset the enroll wizard each time the tab is opened.
            const result = document.getElementById('backup-enroll-result');
            if (result) result.style.display = 'none';
        }
        window.loadBackupTab = loadBackupTab;

        // ---- Role + Live backup health (poll every 10s) ----
        async function loadBackupStatus() {
            if (!authToken) {
                const card = document.getElementById('backup-status-card');
                if (card) {
                    card.innerHTML = `<div style="text-align:center;padding:1.5rem;color:#94a3b8;font-size:0.85rem;">
                        <div style="font-size:1.5rem;margin-bottom:0.5rem;">🔒</div>
                        <strong>Admin Authentication Required</strong><br>
                        <span style="font-size:0.75rem;color:#64748b;">Please enter the admin password in the top-right 🔒 Login box to view backup status.</span>
                    </div>`;
                }
                return;
            }
            try {
                const res = await fetch(`${API}/admin/backup-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) return;
                const d = await res.json();

                // Role
                const isBackup = d.role === 'backup';
                const roleBadge = document.getElementById('backup-role-badge');
                const roleDesc = document.getElementById('backup-role-desc');
                if (roleBadge) {
                    roleBadge.textContent = isBackup ? '🔵 Backup' : '🟢 Primary';
                    roleBadge.style.color = isBackup ? '#38bdf8' : '#10b981';
                }
                if (roleDesc) {
                    roleDesc.textContent = isBackup
                        ? 'This node pulls snapshots from a primary.'
                        : 'This node serves snapshots; it imports state from nobody.';
                }
                const urlRow = document.getElementById('backup-primary-url-row');
                const urlEl = document.getElementById('backup-primary-url');
                if (urlRow && urlEl) {
                    if (isBackup && d.primaryUrl) {
                        urlEl.textContent = d.primaryUrl;
                        urlRow.style.display = '';
                    } else {
                        urlRow.style.display = 'none';
                    }
                }

                // Health tile
                const lastEl = document.getElementById('backup-last-success');
                const streakEl = document.getElementById('backup-fail-streak');
                const intervalEl = document.getElementById('backup-interval');
                const badge = document.getElementById('backup-health-badge');
                const note = document.getElementById('backup-health-note');
                if (intervalEl) intervalEl.textContent = `${Math.round((d.intervalMs || 60000) / 1000)}s`;
                if (streakEl) streakEl.textContent = String(d.consecutiveFailures || 0);

                const enrollWizard = document.getElementById('backup-enroll-wizard');
                const restoreWizard = document.getElementById('backup-restore-wizard');
                const healthTile = document.getElementById('backup-health-tile');

                const accessPanel = document.getElementById('replication-access-panel');
                if (!isBackup) {
                    // A primary runs no puller — the health metrics don't apply, but the
                    // Replication Access panel (who's pulling our snapshots) does.
                    if (healthTile) healthTile.style.display = 'none';
                    if (enrollWizard) enrollWizard.style.display = 'block';
                    if (restoreWizard) restoreWizard.style.display = 'none';
                    if (accessPanel) { accessPanel.style.display = 'block'; loadReplicationAccess(); }
                    return;
                }

                if (healthTile) healthTile.style.display = 'block';
                if (enrollWizard) enrollWizard.style.display = 'none';
                if (restoreWizard) restoreWizard.style.display = 'block';
                if (accessPanel) accessPanel.style.display = 'none';

                if (lastEl) lastEl.textContent = relativeTime(d.lastSuccessAt);

                // Badge: green=converging, amber=stale, red=failing/not running
                let state, label, color, bg;
                const staleMs = (d.intervalMs || 60000) * 3;
                const everSucceeded = !!d.lastSuccessAt;
                const ageMs = everSucceeded ? Date.now() - d.lastSuccessAt : Infinity;
                if (!d.running || (d.consecutiveFailures >= 3)) {
                    state = 'red'; label = d.running ? 'FAILING' : 'NOT RUNNING'; color = '#fff'; bg = '#dc2626';
                } else if (!everSucceeded || ageMs > staleMs || d.consecutiveFailures > 0) {
                    state = 'amber'; label = 'STALE'; color = '#1c1917'; bg = '#f59e0b';
                } else {
                    state = 'green'; label = 'CONVERGING'; color = '#fff'; bg = '#16a34a';
                }
                if (badge) { badge.textContent = label; badge.style.background = bg; badge.style.color = color; }
                if (note) {
                    if (state === 'red') note.textContent = d.running
                        ? `Pulls are failing (${d.consecutiveFailures} in a row). Check the primary URL, admin password, and TLS/CA.`
                        : 'The backup puller is not running. Set NODE_ROLE=backup + BACKUP_PRIMARY_URL + BACKUP_ADMIN_PASSWORD and restart.';
                    else if (state === 'amber') note.textContent = 'Waiting to converge or last pull is stale — this is normal right after boot.';
                    else note.textContent = 'Replication healthy — snapshots are being pulled on schedule.';
                }

                // Replica consistency — does this backup hold the same data the primary sent?
                const consBox = document.getElementById('backup-consistency');
                const consBadge = document.getElementById('backup-consistency-badge');
                const consBody = document.getElementById('backup-consistency-body');
                const consMeta = document.getElementById('backup-consistency-meta');
                const c = d.consistency;
                if (consBox) {
                    if (!c) {
                        consBox.style.display = 'none';
                    } else {
                        consBox.style.display = 'block';
                        const ok = !!c.ok;
                        if (consBadge) {
                            consBadge.textContent = ok ? '✓ MATCHES PRIMARY' : '✗ DRIFT';
                            consBadge.style.background = ok ? '#16a34a' : '#dc2626';
                            consBadge.style.color = '#fff';
                        }
                        const fmt = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString();
                        const colStyle = 'grid-template-columns:1.4fr 1fr 1fr 0.4fr;gap:4px;';
                        const row = (label, p, b, match) => {
                            const mark = match ? '<span style="color:#22c55e;">✓</span>' : '<span style="color:#f87171;">✗</span>';
                            const lc = match ? '#cbd5e1' : '#fca5a5';
                            return `<div style="display:grid;${colStyle}padding:2px 0;color:${lc};"><span>${label}</span>`
                                + `<span style="text-align:right;font-variant-numeric:tabular-nums;">${fmt(p)}</span>`
                                + `<span style="text-align:right;font-variant-numeric:tabular-nums;">${fmt(b)}</span>`
                                + `<span style="text-align:center;">${mark}</span></div>`;
                        };
                        let html = `<div style="display:grid;${colStyle}font-size:0.62rem;color:#64748b;text-transform:uppercase;letter-spacing:0.03em;padding-bottom:3px;border-bottom:1px solid #1e293b;margin-bottom:3px;"><span>Table</span><span style="text-align:right;">Primary</span><span style="text-align:right;">Backup</span><span></span></div>`;
                        (c.tables || []).forEach(t => { html += row(t.name, t.primary, t.backup, t.match); });
                        html += `<div style="border-top:1px solid #1e293b;margin-top:3px;padding-top:3px;"></div>`;
                        if (c.sumBalances) html += row('Σ balances', c.sumBalances.primary, c.sumBalances.backup, c.sumBalances.match);
                        if (c.commons) html += row('commons pool', c.commons.primary, c.commons.backup, c.commons.match);
                        if (consBody) consBody.innerHTML = html;
                        if (consMeta) {
                            let snapAge = '';
                            if (c.snapshotGeneratedAt) {
                                const ms = Date.parse(c.snapshotGeneratedAt);
                                if (!isNaN(ms)) snapAge = ` · snapshot ${relativeTime(ms)}`;
                            }
                            consMeta.textContent = ok
                                ? `Backup holds the same rows, total balance and commons as the primary's last snapshot${snapAge}.`
                                : `Differs from the primary's last snapshot${snapAge} — if this persists past a pull cycle, the import may be incomplete or diverging.`;
                        }
                    }
                }
            } catch (e) { /* transient; next poll retries */ }
        }
        window.loadBackupStatus = loadBackupStatus;

        // ---- Create a backup server wizard ----
        async function generateBackupCommand() {
            if (!authToken) return;
            const btn = document.getElementById('backup-enroll-btn');
            const statusEl = document.getElementById('backup-enroll-status');
            btn.disabled = true;
            const orig = btn.textContent;
            btn.textContent = '⏳ Generating…';
            statusEl.textContent = '';
            try {
                const res = await fetch(`${API}/admin/backup-enroll`, {
                    method: 'GET',
                    headers: { 'X-Admin-Password': authToken }
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }
                const d = await res.json();
                // Prefill the primary URL; NEVER echo the admin password into the page.
                const cmd = `node scripts/setup-backup.mjs --primary ${d.primaryUrl} --admin-pw '<ADMIN_PASSWORD>'`;
                document.getElementById('backup-setup-command').textContent = cmd;
                document.getElementById('backup-enroll-result').style.display = '';
            } catch (e) {
                statusEl.textContent = '❌ ' + e.message;
                statusEl.style.color = '#ef4444';
                statusEl.classList.add('show');
            } finally {
                btn.disabled = false;
                btn.textContent = orig;
            }
        }
        window.generateBackupCommand = generateBackupCommand;

        function copyBackupCommand() {
            const cmd = document.getElementById('backup-setup-command').textContent;
            navigator.clipboard.writeText(cmd).then(() => {
                const statusEl = document.getElementById('backup-enroll-status');
                statusEl.textContent = '✅ Copied to clipboard';
                statusEl.style.color = '#10b981';
                statusEl.classList.add('show');
                setTimeout(() => { statusEl.classList.remove('show'); }, 2000);
            }).catch(() => {});
        }
        window.copyBackupCommand = copyBackupCommand;

        // ---- Restore a primary server wizard ----
        function generateRestoreCommand() {
            const backupUrl = window.location.origin;
            const cmd = `node scripts/restore-primary.mjs --backup ${backupUrl} --admin-pw '<BACKUP_ADMIN_PASSWORD>'`;
            document.getElementById('backup-restore-command').textContent = cmd;
            document.getElementById('backup-restore-result').style.display = 'block';
        }
        window.generateRestoreCommand = generateRestoreCommand;

        function copyRestoreCommand() {
            const cmd = document.getElementById('backup-restore-command').textContent;
            navigator.clipboard.writeText(cmd).then(() => {
                const statusEl = document.getElementById('backup-restore-status');
                statusEl.textContent = '✅ Copied to clipboard';
                statusEl.style.color = '#10b981';
                statusEl.classList.add('show');
                setTimeout(() => { statusEl.classList.remove('show'); }, 2000);
            }).catch(() => {});
        }
        window.copyRestoreCommand = copyRestoreCommand;

        // ---- Dynamic replication config editing form ----
        async function toggleReplicationConfigForm() {
            const form = document.getElementById('replication-config-form');
            if (!form) return;
            const isVisible = form.style.display === 'block';
            if (isVisible) {
                form.style.display = 'none';
            } else {
                form.style.display = 'block';
                const statusEl = document.getElementById('rep-config-status');
                statusEl.textContent = '';
                
                // Load existing configuration
                try {
                    const res = await fetch(`${API}/admin/replication-config/get`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: authToken })
                    });
                    if (res.ok) {
                        const config = await res.json();
                        document.getElementById('rep-primary-url').value = config.primaryUrl || '';
                        document.getElementById('rep-primary-pw').value = '';
                        document.getElementById('rep-primary-pw').placeholder = config.hasPassword
                            ? '•••••••• (Leave blank to keep current)'
                            : 'Enter primary admin password';
                        const tokInput = document.getElementById('rep-primary-token');
                        if (tokInput) {
                            tokInput.value = '';
                            tokInput.placeholder = config.hasToken
                                ? '•••••••• (Leave blank to keep current)'
                                : 'Paste the token shown on the primary';
                        }
                    }
                } catch (e) {
                    console.error('Failed to load replication config:', e);
                }
            }
        }
        window.toggleReplicationConfigForm = toggleReplicationConfigForm;

        async function saveReplicationConfig() {
            const urlInput = document.getElementById('rep-primary-url');
            const pwInput = document.getElementById('rep-primary-pw');
            const tokInput = document.getElementById('rep-primary-token');
            const statusEl = document.getElementById('rep-config-status');
            if (!urlInput || !pwInput || !statusEl) return;

            const primaryUrl = urlInput.value.trim();
            const primaryPassword = pwInput.value;
            const primaryToken = tokInput ? tokInput.value.trim() : '';

            statusEl.textContent = '⏳ Saving connection...';
            statusEl.style.color = '#94a3b8';
            statusEl.classList.add('show');

            try {
                const body = { password: authToken, primaryUrl, primaryPassword };
                // Only send the token when the operator typed one — a blank field keeps
                // the current token rather than clearing it.
                if (primaryToken) body.primaryToken = primaryToken;
                const res = await fetch(`${API}/admin/replication-config/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Failed to save' }));
                    throw new Error(err.error || 'Server error');
                }
                statusEl.textContent = '✅ Connection saved successfully!';
                statusEl.style.color = '#10b981';
                pwInput.value = ''; // Clear password field
                if (tokInput) tokInput.value = '';
                
                // Reload backup status to reflect the new primary URL
                setTimeout(() => {
                    toggleReplicationConfigForm();
                    loadBackupStatus();
                }, 1000);
            } catch (e) {
                statusEl.textContent = '❌ ' + e.message;
                statusEl.style.color = '#ef4444';
            }
        }
        window.saveReplicationConfig = saveReplicationConfig;

        // ---- Force resync (backup side) ----
        async function forceResync() {
            if (!authToken) return;
            const btn = document.getElementById('backup-resync-btn');
            const statusEl = document.getElementById('backup-resync-status');
            if (!confirm('Force a full resync? This clears the backup\'s replicated tables and rebuilds them from the primary\'s current snapshot.')) return;
            // Animated spinner (reuses the page's @keyframes spin) so a slow rebuild
            // visibly reads as "working" rather than frozen.
            const spinner = '<span style="display:inline-block;width:12px;height:12px;border:2px solid #334155;border-top-color:#10b981;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:6px;"></span>';
            if (btn) { btn.disabled = true; btn.innerHTML = spinner + 'Resyncing…'; }
            if (statusEl) { statusEl.classList.add('show'); statusEl.style.color = '#94a3b8'; statusEl.innerHTML = spinner + 'Rebuilding from the primary… this can take a moment.'; }
            try {
                const res = await fetch(`${API}/admin/replication-resync`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                const d = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(d.error || 'Resync failed');
                if (statusEl) { statusEl.style.color = '#10b981'; statusEl.textContent = '✅ Resync complete — replica rebuilt from the primary.'; }
                loadBackupStatus();
            } catch (e) {
                if (statusEl) { statusEl.style.color = '#ef4444'; statusEl.textContent = '❌ ' + e.message; }
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = '🔄 Force full resync'; }
            }
        }
        window.forceResync = forceResync;

        // ---- Replication token (primary side) ----
        async function generateReplicationToken() {
            if (!authToken) return;
            if (!confirm('Generate a new replication token? Any existing token stops working immediately — you must paste the new one into every backup.')) return;
            const statusEl = document.getElementById('rep-token-status');
            try {
                const res = await fetch(`${API}/admin/replication-token/generate`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                const d = await res.json().catch(() => ({}));
                if (!res.ok || !d.token) throw new Error(d.error || 'Failed to generate token');
                const reveal = document.getElementById('rep-token-reveal');
                const val = document.getElementById('rep-token-value');
                if (val) val.textContent = d.token;
                if (reveal) reveal.style.display = 'block';
                if (statusEl) { statusEl.classList.add('show'); statusEl.style.color = '#10b981'; statusEl.textContent = '✅ Token generated — copy it now.'; }
                loadReplicationAccess();
            } catch (e) {
                if (statusEl) { statusEl.classList.add('show'); statusEl.style.color = '#ef4444'; statusEl.textContent = '❌ ' + e.message; }
            }
        }
        window.generateReplicationToken = generateReplicationToken;

        function copyReplicationToken() {
            const val = document.getElementById('rep-token-value');
            if (val && val.textContent && navigator.clipboard) navigator.clipboard.writeText(val.textContent);
        }
        window.copyReplicationToken = copyReplicationToken;

        async function setTokenOnlyMode() {
            if (!authToken) return;
            const cb = document.getElementById('rep-token-only');
            const statusEl = document.getElementById('rep-token-status');
            const tokenOnly = !!(cb && cb.checked);
            try {
                const res = await fetch(`${API}/admin/replication-token/mode`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, tokenOnly })
                });
                const d = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(d.error || 'Failed to update mode');
                if (statusEl) { statusEl.classList.add('show'); statusEl.style.color = '#10b981'; statusEl.textContent = tokenOnly ? '✅ Token-only enforced — admin-password pulls now rejected.' : '✅ Admin-password fallback re-enabled.'; }
            } catch (e) {
                if (cb) cb.checked = !tokenOnly; // revert the toggle on failure
                if (statusEl) { statusEl.classList.add('show'); statusEl.style.color = '#ef4444'; statusEl.textContent = '❌ ' + e.message; }
            }
        }
        window.setTokenOnlyMode = setTokenOnlyMode;

        async function loadReplicationAccess() {
            if (!authToken) return;
            try {
                const res = await fetch(`${API}/admin/replication-access`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) return;
                const d = await res.json();
                const stateEl = document.getElementById('rep-token-state');
                if (stateEl) {
                    stateEl.textContent = d.hasToken
                        ? (d.tokenOnly ? 'set · token-only enforced' : 'set · admin-password fallback active')
                        : 'not set (admin password in use)';
                    stateEl.style.color = d.hasToken ? '#10b981' : '#f59e0b';
                }
                const cb = document.getElementById('rep-token-only');
                if (cb) cb.checked = !!d.tokenOnly;
                const lastPull = document.getElementById('rep-last-pull');
                if (lastPull) lastPull.textContent = d.lastPullAt
                    ? `${relativeTime(d.lastPullAt)}${d.lastPullIp ? ' · ' + d.lastPullIp : ''}${d.lastPullAuth ? ' · ' + d.lastPullAuth : ''}`
                    : 'never';
                const totalPulls = document.getElementById('rep-total-pulls');
                if (totalPulls) totalPulls.textContent = String(d.totalPulls || 0);
                const rejected = document.getElementById('rep-rejected');
                if (rejected) {
                    rejected.textContent = d.totalRejected
                        ? `${d.totalRejected}${d.lastRejectedAt ? ' · last ' + relativeTime(d.lastRejectedAt) : ''}`
                        : '0';
                    rejected.style.color = d.totalRejected ? '#f87171' : '#e2e8f0';
                }
                const recent = document.getElementById('rep-recent');
                if (recent) {
                    const items = (d.recent || []).slice(0, 6);
                    if (!items.length) { recent.innerHTML = ''; }
                    else {
                        recent.innerHTML = '<div style="font-size:0.6rem;color:#64748b;text-transform:uppercase;margin-bottom:3px;">Recent</div>'
                            + items.map(ev => {
                                const ok = ev.auth !== 'rejected';
                                const color = ok ? '#22c55e' : '#f87171';
                                const tag = ok ? ev.auth : ('rejected' + (ev.reason ? ' (' + ev.reason + ')' : ''));
                                return `<div style="display:flex;justify-content:space-between;gap:8px;padding:1px 0;"><span style="color:${color};">${tag}</span><span style="color:#64748b;">${ev.ip || '—'} · ${relativeTime(ev.at)}</span></div>`;
                            }).join('');
                    }
                }
            } catch (e) { /* transient; next poll retries */ }
        }
        window.loadReplicationAccess = loadReplicationAccess;

        // ---- Auto-snapshot config ----
        async function loadAutoSnapConfig() {
            if (!authToken) return;
            try {
                const res = await fetch(`${API}/admin/snapshots/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) return;
                const d = await res.json();
                if (d.config) {
                    document.getElementById('autosnap-enabled').checked = !!d.config.enabled;
                    document.getElementById('autosnap-interval').value = d.config.intervalHours;
                    document.getElementById('autosnap-keep').value = d.config.keep;
                }
            } catch (e) { /* ignore */ }
        }
        window.loadAutoSnapConfig = loadAutoSnapConfig;

        async function saveAutoSnapConfig() {
            if (!authToken) return;
            const statusEl = document.getElementById('autosnap-status');
            const enabled = document.getElementById('autosnap-enabled').checked;
            const intervalHours = parseInt(document.getElementById('autosnap-interval').value) || 24;
            const keep = parseInt(document.getElementById('autosnap-keep').value) || 7;
            try {
                const res = await fetch(`${API}/admin/snapshots/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, enabled, intervalHours, keep })
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const d = await res.json();
                if (d.config) {
                    document.getElementById('autosnap-interval').value = d.config.intervalHours;
                    document.getElementById('autosnap-keep').value = d.config.keep;
                }
                statusEl.textContent = '✅ Saved';
                statusEl.style.color = '#10b981';
                statusEl.classList.add('show');
                setTimeout(() => statusEl.classList.remove('show'), 2000);
            } catch (e) {
                statusEl.textContent = '❌ ' + e.message;
                statusEl.style.color = '#ef4444';
                statusEl.classList.add('show');
            }
        }
        window.saveAutoSnapConfig = saveAutoSnapConfig;

        // ---- Snapshot list ----
        async function loadSnapshots() {
            if (!authToken) return;
            const listEl = document.getElementById('snapshot-list');
            try {
                const res = await fetch(`${API}/admin/snapshots/list`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const d = await res.json();
                const snaps = d.snapshots || [];
                if (snaps.length === 0) {
                    listEl.innerHTML = '<span style="color:#64748b;">No snapshots yet. They are created automatically on schedule, or use “Snapshot now”.</span>';
                    return;
                }
                listEl.innerHTML = snaps.map(s => `
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;padding:0.5rem 0;border-bottom:1px solid #1e293b;">
                        <div style="min-width:0;">
                            <div style="font-family:monospace;color:#e2e8f0;font-size:0.75rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.name)}</div>
                            <div style="font-size:0.68rem;color:#64748b;">${fmtBytes(s.sizeBytes)} · ${relativeTime(s.createdAt)}</div>
                        </div>
                        <div style="display:flex;gap:0.3rem;flex:0 0 auto;">
                            <button class="btn btn-outline" style="padding:0.25rem 0.5rem;font-size:0.7rem;" onclick="downloadSnapshot('${esc(s.name)}')">⬇️</button>
                            <button class="btn btn-danger" style="padding:0.25rem 0.5rem;font-size:0.7rem;" onclick="deleteSnapshot('${esc(s.name)}')">🗑️</button>
                        </div>
                    </div>
                `).join('');
            } catch (e) {
                listEl.innerHTML = `<span style="color:#ef4444;">Failed to load: ${esc(e.message)}</span>`;
            }
        }
        window.loadSnapshots = loadSnapshots;

        async function createSnapshotNow() {
            if (!authToken) return;
            const statusEl = document.getElementById('autosnap-status');
            statusEl.textContent = '⏳ Creating snapshot…';
            statusEl.style.color = '#94a3b8';
            statusEl.classList.add('show');
            try {
                const res = await fetch(`${API}/admin/snapshots/create`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }
                statusEl.textContent = '✅ Snapshot created';
                statusEl.style.color = '#10b981';
                setTimeout(() => statusEl.classList.remove('show'), 2000);
                loadSnapshots();
            } catch (e) {
                statusEl.textContent = '❌ ' + e.message;
                statusEl.style.color = '#ef4444';
            }
        }
        window.createSnapshotNow = createSnapshotNow;

        async function downloadSnapshot(name) {
            if (!authToken) return;
            try {
                const res = await fetch(`${API}/admin/snapshots/download?name=${encodeURIComponent(name)}`, {
                    method: 'GET',
                    headers: { 'X-Admin-Password': authToken }
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (e) {
                alert('Download failed: ' + e.message);
            }
        }
        window.downloadSnapshot = downloadSnapshot;

        async function deleteSnapshot(name) {
            if (!authToken) return;
            if (!confirm(`Delete snapshot ${name}? This cannot be undone.`)) return;
            try {
                const res = await fetch(`${API}/admin/snapshots/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken, name })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }
                loadSnapshots();
            } catch (e) {
                alert('Delete failed: ' + e.message);
            }
        }
        window.deleteSnapshot = deleteSnapshot;

        // ======================== CONNECTION MONITOR ========================
        let activeConnectionsMap = new Map();
        let connTrafficPaused = false;
        let totalTrafficPackets = 0;
        let connTimerInterval = null;

        function updateConnectionTimers() {
            const now = Date.now();
            for (const [id, conn] of activeConnectionsMap.entries()) {
                const el = document.getElementById(`duration-${id}`);
                if (el) {
                    const elapsedMs = now - conn.connectedAt;
                    el.textContent = formatDuration(elapsedMs);
                }
            }
        }

        function formatDuration(ms) {
            const sec = Math.floor(ms / 1000);
            if (sec < 60) return `${sec}s`;
            const min = Math.floor(sec / 60);
            const remainingSec = sec % 60;
            if (min < 60) return `${min}m ${remainingSec}s`;
            const hrs = Math.floor(min / 60);
            const remainingMin = min % 60;
            return `${hrs}h ${remainingMin}m`;
        }

        async function loadInitialConnections() {
            if (!authToken) {
                const container = document.getElementById('conn-list-container');
                if (container) {
                    container.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 2.5rem; font-size: 0.85rem; border: 1px dashed #1e293b; border-radius: 12px; background: rgba(15, 23, 42, 0.4);">
                        🔒 Admin Authentication Required.<br><span style="font-size:0.75rem;color:#64748b;">Please enter the admin password in the top-right 🔒 Login box to view live connections.</span>
                    </div>`;
                }
                return;
            }
            try {
                const res = await fetch(`${API}/admin/ws-connections`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });
                if (!res.ok) return;
                const { connections, analytics } = await res.json();
                
                activeConnectionsMap.clear();
                for (const c of connections) {
                    activeConnectionsMap.set(c.id, c);
                }
                
                renderActiveConnections();
                updateConnectionAnalytics(analytics);
            } catch (err) {
                console.error('Failed to load initial connections:', err);
            }
        }

        function updateConnectionAnalytics(a) {
            if (!a) return;
            const totalEl = document.getElementById('conn-stat-total');
            const syncEl = document.getElementById('conn-stat-sync');
            const adminEl = document.getElementById('conn-stat-admin');
            const avgTimeEl = document.getElementById('conn-stat-avg-time');
            const messagesEl = document.getElementById('conn-stat-messages');

            if (totalEl) totalEl.textContent = a.totalConnected || 0;
            if (syncEl) syncEl.textContent = a.syncCount || 0;
            if (adminEl) adminEl.textContent = a.adminCount || 0;
            if (avgTimeEl) avgTimeEl.textContent = `${a.avgDurationSec || 0}s`;
            if (messagesEl) messagesEl.textContent = (a.totalMsgSent || 0) + (a.totalMsgRecv || 0);
        }

        function renderActiveConnections() {
            const container = document.getElementById('conn-list-container');
            const countEl = document.getElementById('conn-list-count');
            if (!container) return;

            const connections = Array.from(activeConnectionsMap.values());
            if (countEl) {
                countEl.textContent = `${connections.length} active`;
            }

            if (connections.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; color: #64748b; padding: 2rem; font-size: 0.85rem; border: 1px dashed #1e293b; border-radius: 12px; background: rgba(15, 23, 42, 0.2);">
                        No active connections
                    </div>
                `;
                return;
            }

            connections.sort((a, b) => b.connectedAt - a.connectedAt);

            container.innerHTML = connections.map(c => {
                const typeColor = c.type === 'sync' ? '#10b981' : '#a855f7';
                const typeLabel = c.type === 'sync' ? 'Sync Feed' : 'Admin Stream';
                const elapsedMs = Date.now() - c.connectedAt;
                
                // Determine platform info from User-Agent
                let platformName = 'Unknown Client';
                let platformEmoji = '🔌';
                if (c.type === 'admin') {
                    platformName = 'Admin Console';
                    platformEmoji = '💻';
                } else {
                    const ua = c.userAgent || '';
                    const l = ua.toLowerCase();
                    if (l.includes('okhttp')) {
                        platformName = 'Android Native';
                        platformEmoji = '🤖';
                    } else if (l.includes('cfnetwork') || l.includes('darwin')) {
                        platformName = 'iOS Native';
                        platformEmoji = '🍎';
                    } else if (l.includes('mozilla') || l.includes('safari') || l.includes('chrome') || l.includes('webkit')) {
                        const isMobile = /iphone|ipad|ipod|android|mobile/i.test(ua);
                        platformName = isMobile ? 'PWA (Mobile)' : 'PWA (Desktop)';
                        platformEmoji = isMobile ? '📱' : '🌐';
                    }
                }
                
                return `
                    <div class="metric-card glass" id="conn-card-${c.id}" style="background: rgba(15, 23, 42, 0.4); border: 1px solid #1e293b; border-radius: 12px; padding: 0.85rem; display: flex; flex-direction: column; gap: 0.4rem; position: relative;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <div>
                                <span style="font-family: monospace; font-size: 0.75rem; color: #cbd5e1; font-weight: bold;">${esc(c.ip)}</span>
                                ${c.callsign ? `<span class="badge" style="background: rgba(16, 185, 129, 0.1); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.2); font-size: 0.65rem; padding: 1px 6px; border-radius: 6px; margin-left: 0.4rem; font-family: monospace;">@${esc(c.callsign)}</span>` : ''}
                                <span style="font-size: 0.65rem; color: #64748b; font-family: monospace; margin-left: 0.4rem;">(${esc(c.id)})</span>
                            </div>
                            <span class="badge" style="background: ${typeColor}15; color: ${typeColor}; border: 1px solid ${typeColor}30; font-size: 0.6rem; padding: 1px 6px; border-radius: 6px;">
                                ${typeLabel}
                            </span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; color: #cbd5e1; font-weight: 500;">
                            <span style="font-size: 0.85rem; line-height: 1;">${platformEmoji}</span>
                            <span style="color: #cbd5e1;">${platformName}</span>
                            <span style="font-size: 0.62rem; color: #64748b; font-weight: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; margin-left: auto;" title="${esc(c.userAgent)}">
                                ${esc(c.userAgent)}
                            </span>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 0.65rem; color: #64748b; border-top: 1px solid #1e293b; padding-top: 0.4rem; margin-top: 0.2rem;">
                            <span>Duration: <span id="duration-${c.id}" style="font-family: monospace; color: #cbd5e1;">${formatDuration(elapsedMs)}</span></span>
                            <span>TX: <span id="tx-${c.id}" style="font-family: monospace; color: #cbd5e1;">${c.msgSentCount}</span> | RX: <span id="rx-${c.id}" style="font-family: monospace; color: #cbd5e1;">${c.msgRecvCount}</span></span>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function handleWsConnect(conn) {
            activeConnectionsMap.set(conn.id, conn);
            renderActiveConnections();
            
            const timeStr = new Date().toLocaleTimeString();
            let platformLabel = conn.type === 'sync' ? 'Client' : 'Admin';
            if (conn.type === 'sync') {
                const ua = conn.userAgent || '';
                const l = ua.toLowerCase();
                if (l.includes('okhttp')) platformLabel = 'Android Native';
                else if (l.includes('cfnetwork') || l.includes('darwin')) platformLabel = 'iOS Native';
                else if (l.includes('mozilla') || l.includes('safari') || l.includes('chrome') || l.includes('webkit')) {
                    const isMobile = /iphone|ipad|ipod|android|mobile/i.test(ua);
                    platformLabel = isMobile ? 'PWA (Mobile)' : 'PWA (Desktop)';
                }
            } else if (conn.type === 'admin') {
                platformLabel = 'Admin Console';
            }
            const callsignStr = conn.callsign ? ` (@${conn.callsign})` : '';
            appendTrafficLine(`[${timeStr}] 🟢 CONNECTED: ${conn.ip} (${platformLabel})${callsignStr}`, 'gold');
        }

        function handleWsDisconnect({ id }) {
            const conn = activeConnectionsMap.get(id);
            if (conn) {
                const timeStr = new Date().toLocaleTimeString();
                let platformLabel = conn.type === 'sync' ? 'Client' : 'Admin';
                if (conn.type === 'sync') {
                    const ua = conn.userAgent || '';
                    const l = ua.toLowerCase();
                    if (l.includes('okhttp')) platformLabel = 'Android Native';
                    else if (l.includes('cfnetwork') || l.includes('darwin')) platformLabel = 'iOS Native';
                    else if (l.includes('mozilla') || l.includes('safari') || l.includes('chrome') || l.includes('webkit')) {
                        const isMobile = /iphone|ipad|ipod|android|mobile/i.test(ua);
                        platformLabel = isMobile ? 'PWA (Mobile)' : 'PWA (Desktop)';
                    }
                } else if (conn.type === 'admin') {
                    platformLabel = 'Admin Console';
                }
                const callsignStr = conn.callsign ? ` (@${conn.callsign})` : '';
                appendTrafficLine(`[${timeStr}] 🔴 DISCONNECTED: ${conn.ip} (${platformLabel})${callsignStr}`, 'rose');
                activeConnectionsMap.delete(id);
                renderActiveConnections();
            }
        }

        function handleWsTraffic(traffic) {
            totalTrafficPackets++;
            const countEl = document.getElementById('conn-traffic-count');
            if (countEl) countEl.textContent = `${totalTrafficPackets} packets`;

            const conn = activeConnectionsMap.get(traffic.id);
            if (conn) {
                if (traffic.direction === 'in') {
                    conn.msgRecvCount++;
                } else {
                    conn.msgSentCount++;
                }
                
                const txEl = document.getElementById(`tx-${traffic.id}`);
                const rxEl = document.getElementById(`rx-${traffic.id}`);
                if (txEl) txEl.textContent = conn.msgSentCount;
                if (rxEl) rxEl.textContent = conn.msgRecvCount;

                if (!connTrafficPaused) {
                    const timeStr = new Date().toLocaleTimeString();
                    const dirSymbol = traffic.direction === 'in' ? '⬇️' : '⬆️';
                    const dirText = traffic.direction === 'in' ? 'RX' : 'TX';
                    const color = traffic.direction === 'in' ? 'cyan' : 'emerald';
                    appendTrafficLine(`[${timeStr}] ${dirSymbol} [${conn.ip}] ${dirText} (${traffic.size} B): ${traffic.preview}`, color);
                }
            }
        }

        function handleWsAnalytics(analytics) {
            updateConnectionAnalytics(analytics);
        }

        function appendTrafficLine(text, color) {
            const feed = document.getElementById('conn-traffic-feed');
            if (!feed) return;

            if (feed.firstElementChild && feed.firstElementChild.style.fontStyle === 'italic') {
                feed.innerHTML = '';
            }

            const div = document.createElement('div');
            div.style.marginBottom = '0.25rem';
            div.style.whiteSpace = 'pre-wrap';
            div.style.wordBreak = 'break-all';

            const colors = {
                gold: '#fbbf24',
                rose: '#f43f5e',
                cyan: '#06b6d4',
                emerald: '#10b981',
                gray: '#64748b'
            };
            div.style.color = colors[color] || '#cbd5e1';
            div.textContent = text;

            feed.appendChild(div);

            while (feed.children.length > 150) {
                feed.removeChild(feed.firstChild);
            }

            if (!connTrafficPaused) {
                feed.scrollTop = feed.scrollHeight;
            }
        }

        function initTrafficControls() {
            const btnPause = document.getElementById('btn-conn-pause');
            const btnClear = document.getElementById('btn-conn-clear');
            const feed = document.getElementById('conn-traffic-feed');

            if (btnPause) {
                const newBtnPause = btnPause.cloneNode(true);
                btnPause.parentNode.replaceChild(newBtnPause, btnPause);
                newBtnPause.addEventListener('click', () => {
                    connTrafficPaused = !connTrafficPaused;
                    newBtnPause.textContent = connTrafficPaused ? '▶️ Resume' : '⏸️ Pause';
                    newBtnPause.classList.toggle('active', connTrafficPaused);
                });
            }

            if (btnClear) {
                const newBtnClear = btnClear.cloneNode(true);
                btnClear.parentNode.replaceChild(newBtnClear, btnClear);
                newBtnClear.addEventListener('click', () => {
                    if (feed) {
                        feed.innerHTML = '<div style="color: #64748b; font-style: italic;">Listening for incoming network packets...</div>';
                    }
                    totalTrafficPackets = 0;
                    const countEl = document.getElementById('conn-traffic-count');
                    if (countEl) countEl.textContent = '0 packets';
                });
            }
        }

        // ======================== DIAGNOSTICS & LOGS ========================
        let logsWs = null;
        let isLogsPaused = false;
        let logsBuffer = [];
        let unseenWarningErrorCount = 0;
        let diagnosticsInterval = null;

        function updateDiagBadge() {
            const badge = document.getElementById('diag-badge');
            if (!badge) return;
            if (unseenWarningErrorCount > 0) {
                badge.textContent = `⚠️ ${unseenWarningErrorCount}`;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }

        function matchesFilter(log) {
            const levelFilter = document.getElementById('log-filter-level').value;
            const catFilter = document.getElementById('log-filter-category').value;
            const searchVal = document.getElementById('log-search').value.toLowerCase().trim();

            if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
            if (catFilter !== 'ALL' && log.category !== catFilter) return false;
            if (searchVal && !log.message.toLowerCase().includes(searchVal)) return false;

            return true;
        }

        function appendLogToTerminal(log) {
            const feed = document.getElementById('log-terminal-feed');
            if (!feed) return;

            const row = document.createElement('div');
            row.className = 'log-row';

            let timeStr = log.timestamp;
            try {
                const date = new Date(log.timestamp);
                const hrs = String(date.getHours()).padStart(2, '0');
                const mins = String(date.getMinutes()).padStart(2, '0');
                const secs = String(date.getSeconds()).padStart(2, '0');
                const ms = String(date.getMilliseconds()).padStart(3, '0');
                timeStr = `${hrs}:${mins}:${secs}.${ms}`;
            } catch (e) {}

            const levelClass = log.level.toLowerCase();
            
            let metadataHtml = '';
            if (log.metadata) {
                try {
                    const parsed = typeof log.metadata === 'string' ? JSON.parse(log.metadata) : log.metadata;
                    if (parsed && Object.keys(parsed).length > 0) {
                        metadataHtml = `<details><summary>View Metadata</summary><div class="log-meta">${esc(JSON.stringify(parsed, null, 2))}</div></details>`;
                    }
                } catch (err) {}
            }

            const msgClean = log.message ? log.message.trim() : '';
            row.innerHTML = `<span class="log-time">[${esc(timeStr)}]</span><span class="log-lvl ${levelClass}">${esc(log.level)}</span><span class="log-cat">${esc(log.category)}</span><div style="flex: 1;"><span class="log-msg">${esc(msgClean)}</span>${metadataHtml}</div>`;

            feed.appendChild(row);

            while (feed.childNodes.length > 1000) {
                feed.removeChild(feed.firstChild);
            }

            if (!isLogsPaused) {
                feed.scrollTop = feed.scrollHeight;
            }

            const countEl = document.getElementById('log-buffered-count');
            if (countEl) {
                countEl.textContent = `${feed.childNodes.length} logs shown`;
            }
        }

        async function loadLogsHistory() {
            if (!authToken) return;
            const level = document.getElementById('log-filter-level').value;
            const category = document.getElementById('log-filter-category').value;
            const searchQuery = document.getElementById('log-search').value.trim();

            try {
                const res = await fetch(`${API}/admin/logs`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        password: authToken,
                        level,
                        category,
                        searchQuery,
                        limit: 500
                    })
                });

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                const feed = document.getElementById('log-terminal-feed');
                if (feed) {
                    if (!authToken) {
                        feed.innerHTML = '<div style="color: #94a3b8; text-align: center; padding: 3rem;">🔒 Admin Authentication Required.<br><span style="font-size:0.75rem;color:#64748b;">Please enter the admin password in the top-right 🔒 Login box to stream system logs.</span></div>';
                        return;
                    }
                    feed.innerHTML = '';
                    if (data.logs && data.logs.length > 0) {
                        const chronological = [...data.logs].reverse();
                        chronological.forEach(log => {
                            appendLogToTerminal(log);
                        });
                    } else {
                        feed.innerHTML = '<div style="color: #475569; text-align: center; padding: 2rem;">No logs matched the filters.</div>';
                    }
                }
            } catch (err) {
                console.error('Failed to load logs history:', err);
            }
        }

        function formatUptime(seconds) {
            const d = Math.floor(seconds / (3600 * 24));
            const h = Math.floor((seconds % (3600 * 24)) / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);

            if (d > 0) return `${d}d ${h}h`;
            if (h > 0) return `${h}h ${m}m`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        }

        async function loadDiagnostics() {
            if (!authToken) return;
            try {
                const res = await fetch(`${API}/admin/diagnostics`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: authToken })
                });

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                const diag = data.diagnostics;

                if (!diag) return;

                // CPU Circular Gauge
                const cpuValEl = document.getElementById('cpu-gauge-val');
                const cpuTextEl = document.getElementById('cpu-load-text');
                const cpuCoresEl = document.getElementById('cpu-cores');
                if (cpuValEl && cpuTextEl) {
                    const percent = Math.min(Math.max(diag.cpuLoad, 0), 100);
                    cpuValEl.setAttribute('stroke-dasharray', `${percent}, 100`);
                    cpuTextEl.textContent = `${percent}%`;

                    let color = '#10b981';
                    if (percent > 80) color = '#ef4444';
                    else if (percent > 50) color = '#f59e0b';
                    cpuValEl.style.stroke = color;
                }
                if (cpuCoresEl) {
                    cpuCoresEl.textContent = `${diag.cpusCount} CPU Cores`;
                }

                // RAM Progress Bar
                const ramUsageText = document.getElementById('ram-usage-text');
                const ramBar = document.getElementById('ram-usage-bar');
                const ramPercentEl = document.getElementById('ram-used-percent');
                const ramFreeEl = document.getElementById('ram-free-gb');
                if (ramUsageText && ramBar) {
                    const usedGB = (diag.usedMem / (1024 * 1024 * 1024)).toFixed(2);
                    const totalGB = (diag.totalMem / (1024 * 1024 * 1024)).toFixed(2);
                    const freeGB = (diag.freeMem / (1024 * 1024 * 1024)).toFixed(2);
                    
                    ramUsageText.textContent = `${usedGB} / ${totalGB} GB`;
                    ramPercentEl.textContent = `${diag.ramUsage}%`;
                    ramFreeEl.textContent = `${freeGB} GB`;

                    ramBar.style.width = `${diag.ramUsage}%`;
                    
                    let color = 'linear-gradient(90deg, #3b82f6, #60a5fa)';
                    if (diag.ramUsage > 85) color = 'linear-gradient(90deg, #ef4444, #f87171)';
                    else if (diag.ramUsage > 60) color = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
                    ramBar.style.background = color;
                }

                // Database & System Metrics
                const dbTotalSizeEl = document.getElementById('db-total-size');
                const dbWalSizeEl = document.getElementById('db-wal-size');
                const sysUptimeEl = document.getElementById('sys-uptime');
                const sysOsArchEl = document.getElementById('sys-os-arch');

                if (dbTotalSizeEl) {
                    const dbMB = (diag.dbSize / (1024 * 1024)).toFixed(2);
                    dbTotalSizeEl.textContent = `${dbMB} MB`;
                }
                if (dbWalSizeEl) {
                    const walMB = (diag.walSize / (1024 * 1024)).toFixed(2);
                    dbWalSizeEl.textContent = `${walMB} MB`;
                }
                if (sysUptimeEl) {
                    sysUptimeEl.textContent = formatUptime(diag.uptime);
                }
                if (sysOsArchEl) {
                    sysOsArchEl.textContent = `${diag.platform} (${diag.arch})`;
                }

            } catch (err) {
                console.error('Failed to fetch hardware diagnostics:', err);
            }
        }

        function initLogsWs() {
            if (logsWs && (logsWs.readyState === WebSocket.CONNECTING || logsWs.readyState === WebSocket.OPEN)) {
                return;
            }

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/logs?auth=${encodeURIComponent(authToken)}`;

            logsWs = new WebSocket(wsUrl);

            logsWs.onopen = () => {
                const statusBanner = document.getElementById('log-ws-status');
                if (statusBanner) {
                    statusBanner.innerHTML = '<span>● Connected to System Events Stream</span>';
                    statusBanner.style.color = '#34d399';
                    statusBanner.style.background = 'rgba(16, 185, 129, 0.1)';
                    statusBanner.style.borderTop = '1px solid rgba(16, 185, 129, 0.2)';
                }
                const connStatusBanner = document.getElementById('conn-ws-status');
                if (connStatusBanner) {
                    connStatusBanner.innerHTML = '<span>● Connected to Connection Monitor</span><span id="conn-traffic-count" style="font-family: monospace; margin-left: auto;">' + totalTrafficPackets + ' packets</span>';
                    connStatusBanner.style.color = '#34d399';
                    connStatusBanner.style.background = 'rgba(16, 185, 129, 0.1)';
                    connStatusBanner.style.borderTop = '1px solid rgba(16, 185, 129, 0.2)';
                }
            };

            logsWs.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'log') {
                        const log = msg.data;
                        
                        const currentTab = sessionStorage.getItem('bp-settings-tab') || 'identity';
                        if (currentTab !== 'diagnostics') {
                            if (log.level === 'WARN' || log.level === 'ERROR' || log.level === 'SECURITY') {
                                unseenWarningErrorCount++;
                                updateDiagBadge();
                            }
                        }

                        logsBuffer.unshift(log);
                        if (logsBuffer.length > 2500) {
                            logsBuffer.pop();
                        }

                        if (matchesFilter(log)) {
                            appendLogToTerminal(log);
                        }
                    } else if (msg.type === 'ws_connect') {
                        handleWsConnect(msg.data);
                    } else if (msg.type === 'ws_disconnect') {
                        handleWsDisconnect(msg.data);
                    } else if (msg.type === 'ws_traffic') {
                        handleWsTraffic(msg.data);
                    } else if (msg.type === 'ws_analytics') {
                        handleWsAnalytics(msg.data);
                    }
                } catch (err) {
                    console.error('Error handling ws log message:', err);
                }
            };

            logsWs.onclose = () => {
                const statusBanner = document.getElementById('log-ws-status');
                if (statusBanner) {
                    statusBanner.innerHTML = '<span>○ Disconnected. Attempting reconnection...</span>';
                    statusBanner.style.color = '#f87171';
                    statusBanner.style.background = 'rgba(239, 68, 68, 0.1)';
                    statusBanner.style.borderTop = '1px solid rgba(239, 68, 68, 0.2)';
                }
                const connStatusBanner = document.getElementById('conn-ws-status');
                if (connStatusBanner) {
                    connStatusBanner.innerHTML = '<span>○ Disconnected. Attempting reconnection...</span>';
                    connStatusBanner.style.color = '#f87171';
                    connStatusBanner.style.background = 'rgba(239, 68, 68, 0.1)';
                    connStatusBanner.style.borderTop = '1px solid rgba(239, 68, 68, 0.2)';
                }
                if (authToken) {
                    setTimeout(initLogsWs, 3000);
                }
            };

            logsWs.onerror = (err) => {
                console.error('Logs WebSocket error:', err);
            };
        }

        async function exportLogsHistory(format) {
            if (!authToken) return;
            const level = document.getElementById('log-filter-level').value;
            const category = document.getElementById('log-filter-category').value;
            const searchQuery = document.getElementById('log-search').value.trim();

            try {
                const res = await fetch(`${API}/admin/logs`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        password: authToken,
                        level,
                        category,
                        searchQuery,
                        limit: 2500
                    })
                });

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                const logs = data.logs || [];

                let blob;
                let filename = `beanpool-logs-${new Date().toISOString().split('T')[0]}`;

                if (format === 'json') {
                    blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
                    filename += '.json';
                } else {
                    const text = logs.map(log => {
                        const time = log.timestamp;
                        const meta = log.metadata ? `\nMetadata: ${log.metadata}` : '';
                        return `[${time}] [${log.level}] [${log.category}] ${log.message}${meta}`;
                    }).join('\n');
                    blob = new Blob([text], { type: 'text/plain' });
                    filename += '.txt';
                }

                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (err) {
                alert('Export failed: ' + err.message);
            }
        }

        // Setup Diagnostics Controls
        document.getElementById('log-filter-level').addEventListener('change', loadLogsHistory);
        document.getElementById('log-filter-category').addEventListener('change', loadLogsHistory);
        
        let logSearchTimeout;
        document.getElementById('log-search').addEventListener('input', () => {
            clearTimeout(logSearchTimeout);
            logSearchTimeout = setTimeout(loadLogsHistory, 300);
        });

        document.getElementById('btn-log-pause').addEventListener('click', () => {
            isLogsPaused = !isLogsPaused;
            document.getElementById('btn-log-pause').textContent = isLogsPaused ? '▶️ Play' : '⏸️ Pause';
        });

        document.getElementById('btn-log-clear').addEventListener('click', () => {
            const feed = document.getElementById('log-terminal-feed');
            if (feed) feed.innerHTML = '';
            const countEl = document.getElementById('log-buffered-count');
            if (countEl) countEl.textContent = '0 logs shown';
        });

        document.getElementById('btn-export-txt').addEventListener('click', () => exportLogsHistory('txt'));
        document.getElementById('btn-export-json').addEventListener('click', () => exportLogsHistory('json'));

        function logout() {
            authToken = null;
            sessionStorage.removeItem('bp-admin-token');
            sessionStorage.removeItem('bp-settings-tab');

            if (logsWs) {
                try {
                    logsWs.close();
                } catch (e) {}
                logsWs = null;
            }

            // Reset fields
            document.getElementById('login-password').value = '';
            const statusEl = document.getElementById('login-status');
            if (statusEl) {
                statusEl.className = 'status-msg';
                statusEl.textContent = '';
            }

            // Show login view
            showView('login');
        }

        document.getElementById('logout-btn').addEventListener('click', logout);

        // ======================== INIT ========================
        async function init() {
            loadVersionInfo();

            const storedToken = sessionStorage.getItem('bp-admin-token');
            if (storedToken) {
                try {
                    const verifyRes = await fetch(`${API}/verify-password`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: storedToken })
                    });
                    if (verifyRes.ok) {
                        authToken = storedToken;
                        initLogsWs();
                        let dashboardData = null;
                        const dashRes = await fetch(`${API}/dashboard`);
                        if (dashRes.ok) {
                            dashboardData = await dashRes.json();
                            hydrateSettings(dashboardData);
                        }
                        showView('settings');
                        loadHealthDashboard();
                        loadThresholds();
                        loadCommunityInfo();
                        loadAdminData();
                        loadGatewayConfig();
                        const gwSaveBtn = document.getElementById('save-gateway-btn');
                        if (gwSaveBtn) gwSaveBtn.addEventListener('click', saveGatewayConfig);
                        switchTab(sessionStorage.getItem('bp-settings-tab') || 'identity');
                        setTimeout(() => {
                            initMap(
                                parseFloat(document.getElementById('cfg-lat').value) || null,
                                parseFloat(document.getElementById('cfg-lng').value) || null
                            );
                            if (dashboardData && dashboardData.connectors) plotSisterNodes(dashboardData.connectors);
                            maybeAutoCheck();
                        }, 150);
                        return; // Auto-login successful
                    }
                } catch (e) {
                    console.error('Auto-login verification failed:', e);
                }
            }

            try {
                const res = await fetch(`${API}/status`);
                const data = await res.json();
                if (data.isLocked) {
                    showView('login');
                } else {
                    // Node not locked — show message
                    showView('login');
                    showStatus('login-status', 'Node not configured. Set ADMIN_PASSWORD and restart.', 'error');
                }
            } catch (err) {
                showView('login');
                showStatus('login-status', 'Cannot reach server API', 'error');
            }
        }

        // Auto-refresh connectors every 10s while on settings view
        setInterval(() => {
            if (!document.getElementById('view-settings').classList.contains('hidden') && authToken) {
                refreshConnectors();
            }
        }, 10000);

        // Apply initial tab (default: identity)
        switchTab(sessionStorage.getItem('bp-settings-tab') || 'identity');

        init();

        // ======================== GATEWAY CONFIGURATION ========================
        async function loadGatewayConfig() {
            try {
                const res = await fetch('/api/local/admin/gateway', {
                    headers: { 'X-Admin-Password': authToken }
                });
                if (!res.ok) return;
                const config = await res.json();
                
                const originsInput = document.getElementById('gw-cors-origins');
                const adminIpsInput = document.getElementById('gw-admin-ips');
                const rateEnabledSelect = document.getElementById('gw-rate-enabled');
                const rateMaxInput = document.getElementById('gw-rate-max');
                
                if (originsInput) originsInput.value = (config.corsAllowedOrigins || []).join(', ');
                if (adminIpsInput) adminIpsInput.value = (config.adminIpAllowlist || []).join(', ');
                if (rateEnabledSelect) rateEnabledSelect.value = config.rateLimiting?.enabled ? 'true' : 'false';
                if (rateMaxInput) rateMaxInput.value = config.rateLimiting?.maxRequestsPerMinute || 600;
                
                const features = config.features || {};
                const checkMarketplace = document.getElementById('gw-feat-marketplace');
                const checkMessaging = document.getElementById('gw-feat-messaging');
                const checkFederation = document.getElementById('gw-feat-federation');
                const checkInvites = document.getElementById('gw-feat-invites');
                const checkPwa = document.getElementById('gw-feat-pwa');

                if (checkMarketplace) checkMarketplace.checked = !!features.marketplace;
                if (checkMessaging) checkMessaging.checked = !!features.messaging;
                if (checkFederation) checkFederation.checked = !!features.federation;
                if (checkInvites) checkInvites.checked = !!features.invites;
                if (checkPwa) checkPwa.checked = !!features.servePwa;
            } catch (e) {
                console.warn('Failed to load gateway config:', e);
            }
        }

        async function saveGatewayConfig() {
            const statusEl = document.getElementById('gateway-status');
            const saveBtn = document.getElementById('save-gateway-btn');
            if (saveBtn) saveBtn.disabled = true;

            try {
                const corsOriginsStr = document.getElementById('gw-cors-origins')?.value || '';
                const adminIpsStr = document.getElementById('gw-admin-ips')?.value || '';
                const rateEnabled = document.getElementById('gw-rate-enabled')?.value === 'true';
                const rateMax = parseInt(document.getElementById('gw-rate-max')?.value || '120', 10);

                const payload = {
                    corsAllowedOrigins: corsOriginsStr.split(',').map(s => s.trim()).filter(Boolean),
                    adminIpAllowlist: adminIpsStr.split(',').map(s => s.trim()).filter(Boolean),
                    rateLimiting: {
                        enabled: rateEnabled,
                        maxRequestsPerMinute: Number.isFinite(rateMax) && rateMax > 0 ? rateMax : 120,
                    },
                    features: {
                        marketplace: !!document.getElementById('gw-feat-marketplace')?.checked,
                        messaging: !!document.getElementById('gw-feat-messaging')?.checked,
                        federation: !!document.getElementById('gw-feat-federation')?.checked,
                        invites: !!document.getElementById('gw-feat-invites')?.checked,
                        servePwa: !!document.getElementById('gw-feat-pwa')?.checked,
                    }
                };

                const res = await fetch('/api/local/admin/gateway', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Password': authToken
                    },
                    body: JSON.stringify(payload)
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }

                if (statusEl) {
                    statusEl.textContent = '✅ Gateway configuration saved successfully!';
                    statusEl.className = 'status-msg show success';
                    setTimeout(() => statusEl.classList.remove('show'), 3000);
                }
            } catch (e) {
                if (statusEl) {
                    statusEl.textContent = '❌ Failed to save: ' + e.message;
                    statusEl.className = 'status-msg show error';
                }
            } finally {
                if (saveBtn) saveBtn.disabled = false;
            }
        }
