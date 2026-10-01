// scripts/server-suites.mjs — every run of an apps/server/src/test-*.ts suite that test-all makes, in one place.
//
// These suites are script-style checks, not vitest, so `turbo run test` does not see them: this list is the only
// thing that runs them. scripts/run-server-suites.mjs runs every entry below, each in a process of its own with its
// own data dir and temp dir, several at a time; scripts/check-suite-registration.sh fails when a suite on disk is
// missing from here, or a name here has no file.
//
// Each run gets a FRESH data dir: the suites share the module-level sqlite singleton, so a reused dir would let one
// suite's rows leak into the next. ENABLE_PEER_CONNECTORS=true (DEFAULT_ENV) because connector reads short-circuit
// without it, which would make the federation checks pass vacuously rather than fail.
//
// A suite that starts a server binds port 0 and reads the port back, so suites running side by side never collide,
// here or with a run in another worktree. Never give a suite a fixed port.

/** Set for every run unless the entry overrides it; an override of null removes the variable. */
export const DEFAULT_ENV = {
    ENABLE_PEER_CONNECTORS: 'true',
};

/**
 * The plain runs: each suite once, with DEFAULT_ENV.
 *
 * ONE SUITE PER LINE. Add a new suite as its own line beside a related one rather than at the bottom: two PRs that
 * each append after the same last line conflict, while insertions at different points merge cleanly. Order does not
 * matter: the runner orders by the last recorded durations, longest first.
 */
export const SUITES = [
    'test-schema-upgrade',
    'test-creator-channels',
    'test-pulse-resolver',
    'test-ssrf-fetch-timeout',
    'test-pulse-submit',
    'test-pulse-oauth',
    'test-oauth-ingest-bounds',
    'test-pulse-curated',
    'test-pulse-admin-channels',
    'test-pulse-report-takedown',
    'test-pulse-thumbnail',
    'test-pulse-thumbnail-recovery',
    'test-pulse-cache-eviction',
    'test-callsign-predicates',
    'test-message-tombstone',
    'test-recovery-shares',
    'test-sso',
    'test-sso-unavailable',
    'test-daily-pulse',
    'test-pairing-relay',
    'test-pairing-routes',
    'test-pricing-guide',
    'test-pricing-aggregator-lifecycle',
    'test-activity-feed',
    'test-member-purge',
    'test-purge-during-rekey',
    'test-removed-member-delete',
    'test-keeper-deposit',
    'test-keeper-routes',
    'test-keeper-release',
    'test-recovery-collect',
    'test-sso-recovery-roundtrip',
    'test-recovery-seal',
    'test-recovery-seal-rollback',
    'test-recovery-seal-removed',
    'test-keeper-http',
    'test-open-join',
    'test-open-join-vault-ticket',
    'test-open-door-counters',
    'test-web-door',
    'test-web-visits',
    'test-global-moderation',
    'test-community-me',
    'test-distance-search',
    'test-distance-query-parsing',
    'test-guest-view',
    'test-distance-search-perf',
    'test-global-directory',
    'test-knock',
    'test-commons-conservation',
    'test-ledger-rollback',
    'test-treasury-keepership',
    'test-treasury-eggs',
    'test-enterprise-credit-rules',
    'test-derived-enterprise-floor',
    'test-demurrage-window',
    'test-crowdfund-delete-refund',
    'test-money-pledge-and-hourly-price',
    'test-admin-password-query',
    'test-cors-policy',
    'test-gateway-config',
    'test-gateway-real-client',
    'test-dos-hardening',
    'test-limiter-ipv6-and-password-brake',
    'test-password-brake-no-lockout',
    'test-password-brake-fairness',
    'test-csrf-protection',
    'test-totp-admin-2fa',
    'test-2fa-covers-admin-routes',
    'test-2fa-reenrol-needs-code',
    'test-totp-helpers',
    'test-moderation-admin',
    'test-report-dedup-and-sync',
    'test-ledger-export',
    'test-ledger-audit-startup',
    'test-mirror-sync-audit-log',
    'test-federation-bridge',
    'test-connector-credit-cap',
    'test-connector-handshake-errors',
    'test-connector-public-url',
    'test-federation-link',
    'test-listing-reach',
    'test-listing-pull',
    'test-settlement-state',
    'test-settlement-exchange',
    'test-settlement-orchestration',
    'test-federation-purchase-route',
    'test-federation-commission',
    'test-federation-settlement-key',
    'test-p2p-announce',
    'test-federation-settlement',
    'test-admin-actor-name',
    'test-chat-mutes',
    'test-admin-queue',
    'test-admin-auth',
    'test-first-admin-password',
    'test-config-write-races',
    'test-admin-key-auth',
    'test-app-admin-handoff',
    'test-settings-qr-signin',
    'test-challenge-token-leak',
    'test-moderator-routes',
    'test-backend-monitors',
    'test-backup-hardening',
    'test-request-binding-ledger',
    'test-backup-identity-bundle',
    'test-backup-owner-gate',
    'test-sealed-backups',
    'test-takeover-envelope',
    'test-owner-words-check',
    'test-backup-topology',
    'test-standby-token-only',
    'test-standby-envelopes',
    'test-takeover-by-code',
    'test-takeover-crash-resume',
    'test-takeover-by-phone',
    'test-takeover-keeps-app-addresses',
    'test-takeover-split-brain',
    'test-sync-reads-carry-epoch',
    'test-takeover-keeps-listing-times',
    'test-profile-takeover',
    'test-open-join-failover',
    'test-open-join-key-file',
    'test-standby-visitor-marks',
    'test-standby-owner-deleted',
    'test-delete-scrubs-posts',
    'test-delete-blanks-chat',
    'test-standby-board-standing',
    'test-place-watch-failover',
    'test-standby-rekey',
    'test-takeover-parity',
    'test-replication-manifest',
    'test-standby-ledger-copy',
    'test-standby-ledger-gate',
    'test-standby-community-settings',
    'test-standby-listings-verbatim',
    'test-standby-standing',
    'test-standby-health',
    'test-address-retention',
    'test-standby-in-flight',
    'test-standby-devices',
    'test-standby-refusal-keeps-copy',
    'test-tombstone-retention',
    'test-sync-copy-pages',
    'test-standby-paged-copies',
    'test-standby-swap-at-boot',
    'test-standby-paged-copies-pacing',
    'test-standby-photos-by-reference',
    'test-recovery-tombstones',
    'test-github-sign-in-removed',
    'test-unlock-cancel',
    'test-cash-also-needed',
    'test-posts-ignore-archetypes',
    'test-crowdfund-ledger-sync',
    'test-detached-pwa',
    'test-dos-caps',
    'test-writer-bounds',
    'test-money-limits',
    'test-economic-hardening',
    'test-federation-api',
    'test-federation-receipt',
    'test-genesis',
    'test-hardening',
    'test-logger-sanitization',
    'test-codes-out-of-logs',
    'test-manager-build',
    'test-onboarding-funnel',
    'test-funnel-cohort',
    'test-request-auth',
    'test-api-path-auth',
    'test-request-binding',
    'test-loopback-audience',
    'test-address-offers',
    'test-staff-seen-prune',
    'test-never-forget-registrar-name',
    'test-former-address',
    'test-registrar-names-record',
    'test-registrar-name-watch',
    'test-public-url-callers',
    'test-read-auth-default',
    'test-privacy-defaults',
    'test-activity-feed-members-only',
    'test-members-contact-visibility',
    'test-contact-trade-partners',
    'test-sync-signature',
    'test-trust-value-curve',
    'test-trust-tiers-one-source',
    'test-vouch-covenant',
    'test-wash-sybil-defense',
    'test-apple-probe',
    'test-apple-return',
    'test-recovery-backup-durability',
    'test-public-address',
    'test-tunnel-connector',
    'test-no-docker-socket',
    'test-node-config-public',
    'test-registrar-contract',
    'test-invite-trampoline',
    'test-ticket-redeem-fault',
    'test-offline-ticket-check',
    'test-request-body',
    'test-admin-thresholds',
    'test-manager-backups',
    'test-push-preferences',
    'test-push-token-own-rows',
    'test-push-leave-statement',
    'test-push-access-token',
    'test-push-notices',
    'test-push-tokens-at-rest',
    'test-settings',
    'test-srv20-ledger-reset',
    'test-harvester',
    'test-membership-probe',
    'test-friends-routes',
    'test-message-attachment',
    'test-social-ratings',
    'test-app-store-versions',
    'test-node-profile',
    'test-profile-feature-gate',
    'test-global-no-beans',
    'test-open-door-hardening',
    'test-funnel-event',
    'test-handshake',
    'test-post-pause-resume',
    'test-cancel-post-request',
    'test-non-members-cant-act',
    'test-marketplace-auth',
    'test-listing-edit-numbers',
    'test-sync-author-off-board',
    'test-sync-board-standing-upgrade',
    'test-escrow-fail-closed',
    'test-escrow-floor',
    'test-escrow-write-off',
    'test-version-resolution',
    'test-avatar-endpoint',
    'test-avatar-keys',
    'test-etag-short-circuit',
    'test-photo-keys-resync',
    'test-photo-keys-audience',
    'test-photo-key-collision',
    'test-api-headers-and-feed-etag',
    'test-directory-publisher',
    'test-website-directory-map',
    'test-members-holiday',
    'test-admin-seed-invite',
    'test-admin-genesis-pubkey',
    'test-admin-empty-sentinel',
    'test-node-roles',
    'test-suspended-owner-bootstrap',
    'test-federation-link-binding',
    'test-ws-pong-watchdog',
    'test-ws-http-port',
    'test-ws-auth-default',
    'test-visitor-doorbells',
    'test-ws-feed-parties',
    'test-live-post-payloads',
    'test-moderation-notifications',
    'test-moderation-notices-kept',
    'test-member-blocks',
    'test-member-blocks-standby',
    'test-polls',
    'test-poll-voters-members-only',
    'test-suspended-and-visitor-reads',
    'test-visitors-cant-act',
    'test-doors-key-case',
    'test-events',
    'test-enterprise-event-http',
    'test-event-chat',
    'test-event-notify',
    'test-event-reminders',
    'test-event-reminders-http',
    'test-posts-fts-same-ms',
    'test-event-scrub',
    'test-migration-projects-enterprises',
    'test-commons-reject-project',
    'test-commons-projects-update-delete',
    'test-decisions-engine',
    'test-decisions-client-api',
    'test-decisions-voting-answers',
    'test-decisions-tick-route-gone',
    'test-decisions-funding-queue',
    'test-decisions-grant-cap',
    'test-decisions-off',
    'test-invites-off',
    'test-rip-out-legacy-voting',
    'test-escrow-disputes',
    'test-process-handlers',
    'test-shutdown-recovery',
    'test-storage-health',
    'test-image-store',
    'test-image-store-s3',
    'test-image-store-s3-http',
    'test-image-evacuation',
    'test-photo-metadata',
    'test-snapshot-completeness',
    'test-groups-isolation',
    'test-groups-routes',
    'test-groups-invite-only-hidden',
    'test-group-existence-leaks',
    'test-group-existence-leaks-http',
    'test-groups-patch-http',
    'test-groups-sync-and-removal',
    'test-groups-chat',
    'test-chat-parity',
    'test-dm-never-plaintext',
    'test-keeper-read-cursor',
    'test-groups-chat-sync',
    'test-groups-succession',
    'test-groups-succession-electorate',
    'test-groups-lead-convenor',
    'test-groups-suspended-convenor',
    'test-member-wizards',
    'test-enterprise-pause',
    'test-enterprise-season-lifecycle',
    'test-enterprise-keepers-slice6',
    'test-enterprise-keeper-answers',
    'test-succession-broadcast-after-commit',
    'test-enterprise-location',
    'test-enterprise-thread',
    'test-enterprise-closed-states',
    'test-slice6-review-findings',
    'test-security-followups-0919',
    'test-security-followups-1001',
];

/**
 * The same suites again under another environment. Every flag here is a module const read once at import, so a
 * single process only ever sees one value and the second value needs a second run.
 *
 * `tag` is the run's short name in the failure roll-up (`test-x(on)`), `label` the longer one on its log header.
 * A variant with no tag is a suite that ONLY runs here, because it refuses to run without its flag.
 */
export const VARIANTS = [
    // The two settlement ROUTES with settlement ENABLED. The plain run covers the shipped state (off, the kill switch
    // refusing everything) and this covers the full matrix behind it. Running either one once would leave half the
    // route untested, and it is the half that moves value: the purchase route can debit a member, and the commission
    // route can draw on the Commons pot.
    { name: 'test-federation-purchase-route', tag: 'on', label: 'settlement ON', env: { FEDERATION_SETTLEMENT: 'true' } },
    { name: 'test-federation-commission', tag: 'on', label: 'settlement ON', env: { FEDERATION_SETTLEMENT: 'true' } },

    // The keeper HTTP reachability suite with read enforcement switched OFF by the operator opt-out. Read auth is ON by
    // default, so the plain run is the pass that matters (the public-read allowlist under enforcement); this covers a
    // node whose operator set ENFORCE_READ_AUTH=false.
    { name: 'test-keeper-http', tag: 'readauth-off', label: 'read auth opted out', env: { ENFORCE_READ_AUTH: 'false' } },

    // Messaging IDOR (A2-2/A2-3/A2-15): one member cannot read another member's conversations. Refuses to run without
    // ENFORCE_READ_AUTH rather than passing vacuously, which is why it sat unregistered.
    { name: 'test-messaging-idor', label: 'read auth ON', env: { ENFORCE_READ_AUTH: 'true' } },

    // Member-read IDOR (A2-16 family): one member cannot read another member's invites or notification preferences.
    // The plain run makes those 403 assertions; this covers the operator opt-out, where they are skipped and the
    // push-token and preference round-trips must still work.
    { name: 'test-push-preferences', tag: 'readauth-off', label: 'read auth opted out', env: { ENFORCE_READ_AUTH: 'false' } },

    // Distance search (G4) with read enforcement opted out. Nothing stands in front of the People list, so its own
    // refusal of a distance to an unsigned caller or a key that is not a member is what holds.
    { name: 'test-distance-search', tag: 'readauth-off', label: 'read auth opted out', env: { ENFORCE_READ_AUTH: 'false' } },

    // Consolidated/legacy conversation-id resolution: a send to a legacy id remaps to the active DM, preserves
    // metadata.originalConversationId (the E2EE AAD fallback), and survives a malformed-metadata row. Always run
    // without peer connectors.
    { name: 'test-messaging-consolidation', env: { ENABLE_PEER_CONNECTORS: null } },

    // WebSocket upgrades on the plain HTTP port (the Cloudflare tunnel origin) with ws auth ON (strict). The plain run
    // proves the default (strangers get public doorbells); this proves an unsigned /ws is refused on the tunnel port
    // exactly as on the HTTPS one.
    { name: 'test-ws-http-port', tag: 'wsauth', label: 'ws auth ON', env: { ENFORCE_WS_AUTH: 'true' } },
    // ...and with the operator escape hatch: an unsigned /ws on the tunnel port gets the old open feed.
    { name: 'test-ws-http-port', tag: 'open', label: 'ws auth OFF, open feed', env: { ENFORCE_WS_AUTH: 'false' } },

    // The /ws feed with the operator escape hatch: the old open feed, where an unsigned socket gets every
    // community-wide event but still never a scoped one. The plain run covers the default.
    { name: 'test-ws-auth-default', tag: 'open', label: 'ws auth OFF, open feed', env: { ENFORCE_WS_AUTH: 'false' } },

    // The recovery WebSocket suite, which asserts the ws path REFUSES an unauthenticated subscriber. Both flags are
    // mandatory: the suite exits nonzero without them rather than passing vacuously.
    { name: 'test-recovery-ws', label: 'read + ws auth ON', env: { ENFORCE_READ_AUTH: 'true', ENFORCE_WS_AUTH: 'true' } },
];

/**
 * Runs that go one at a time AFTER the pool, with no other server suite beside them: suites whose checks time
 * something, so a neighbour's burst of CPU can fail them. (Inside test-all the other checks, settings_phone above
 * all, may still be running.) Keyed by run id (`test-x` or `test-x(tag)`), with the reason. Keep it short: every
 * entry is serial wall-clock added to every run. A suite belongs here when a check of it compares a wall-clock time
 * with a bound a busy machine can cross; generous bounds (test-schema-upgrade's 5 s for a rebuild measured in tens of
 * ms) stay in the pool.
 */
export const SERIAL = {
    // Times each read against the version before it in the same process and fails past 2x: a neighbour's burst of CPU
    // during one of the pair and not the other is a failure that says nothing about the code.
    'test-distance-search-perf': 'relative timings, 2x slack',
    // Times adding a source to a full map against adding one with room (5x slack), the #944 regression it guards.
    'test-password-brake-fairness': 'relative timings, 5x slack',
    // Waits a fixed 100-150 ms for each pong (or its absence) on a live socket; a loaded machine answers later.
    'test-ws-pong-watchdog': 'fixed 100-150 ms waits for a reply',
    // Asserts no page of a copy blocks M's event loop for 1 s (1.5 s for the reclaim routes), measured with
    // monitorEventLoopDelay, and that a copy closes within 1-4 s of a 2 s timer. Failed in the pool on a slow CI
    // runner (CI run 36634378823: worst 1475 ms), passing alone.
    'test-sync-copy-pages': 'event-loop hold under 1 s; failed in the CI pool',
    // Asserts the orphan sweep never holds the event loop 250 ms (a 2 ms interval that must keep ticking).
    'test-storage-health': 'event-loop hold under 250 ms',
    // Its unpaced copy must make 300 requests inside a scaled 20 s limiter window (11.6 s alone, 15 s with all 12 cores
    // busy): a loaded neighbour can push it past the window, and the check then says nothing about the code (#1334).
    'test-standby-paged-copies-pacing': 'request rate inside a scaled 20 s window',
    // Its stager boots in ~8 s under load against M's copy idle time scaled to 3 s: M closes the copy (404) and the steps
    // after it cascade (48/77 in the pool, 93/93 alone, #1334).
    'test-standby-paged-copies': 'stager boot against a scaled 3 s copy idle time',
    // Steps 17-25 of the suite above, split from it to keep each well inside the runner's 300 s (255 s on CI run
    // 36747148280): the same pair, the same stager boot against the same 3 s copy idle time.
    'test-standby-swap-at-boot': 'stager boot against a scaled 3 s copy idle time',
};
