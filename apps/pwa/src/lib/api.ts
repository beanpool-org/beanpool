/**
 * API Client — Typed fetch wrappers for BeanPool Node APIs
 *
 * Base URL is same-origin (the PWA is served by the node).
 */
import { loadIdentity } from './identity';
const BASE = '';  // Same-origin — PWA is served by the node

// Helper to convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

// Helper to convert Uint8Array to base64
function bytesToBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

// PKCS8 ASN.1 prefix for an Ed25519 private key (16 bytes), followed by the 32-byte seed.
const PKCS8_ED25519_HEADER = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

// Native devices persist the raw 32-byte Ed25519 seed; WebCrypto's importKey('pkcs8')
// needs it wrapped in a PKCS8 envelope. Accept either so transfer-code imports from a
// phone can still sign here. Already-wrapped 48-byte keys pass through untouched.
function toPkcs8Ed25519(key: Uint8Array): Uint8Array {
    if (key.length !== 32) return key;
    const out = new Uint8Array(PKCS8_ED25519_HEADER.length + 32);
    out.set(PKCS8_ED25519_HEADER);
    out.set(key, PKCS8_ED25519_HEADER.length);
    return out;
}

async function signEd25519(privateKeyHex: string, message: string): Promise<string> {
    const pkcs8 = toPkcs8Ed25519(hexToBytes(privateKeyHex));
    const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8 as unknown as BufferSource,
        { name: 'Ed25519' },
        false,
        ['sign']
    );
    const signatureBytes = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(message));
    return bytesToBase64(new Uint8Array(signatureBytes));
}

/**
 * Forward-compatible WebSocket connect auth (SRV-4). Signed query params for the
 * `/ws` handshake, mirroring the replay-proof scheme (method=WS, empty body):
 * signs `WS\n${path}\n${ts}\n${nonce}\n`. The node ignores these until
 * ENFORCE_WS_AUTH is on. Returns a `&`-joinable fragment, or '' if no identity.
 */
export async function buildSignedWsParams(path: string): Promise<string> {
    const identity = await loadIdentity();
    if (!identity?.privateKey || !identity?.publicKey) return '';
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const canonical = `WS\n${path}\n${timestamp}\n${nonce}\n`;
    const sig = await signEd25519(identity.privateKey, canonical);
    return `pubkey=${encodeURIComponent(identity.publicKey)}&ts=${timestamp}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

// Base request helper with auth
export async function request<T>(method: string, path: string, body?: any): Promise<T> {
    const opts: RequestInit = {
        method,
        cache: 'no-store',
        headers: {
            'Content-Type': 'application/json',
        } as Record<string, string>,
    };

    const bodyString = body ? JSON.stringify(body) : '';
    if (body) {
        opts.body = bodyString;
    }

    // Sign every request that has an identity available. Writes need it (X-1);
    // and under the node's read-auth enforcement (SRV-2/SRV-4) gated GETs do too.
    // GETs sign over an empty body, matching the server's `rawBody ?? ''`. Extra
    // signature headers on a public read are simply ignored by the server.
    const identity = await loadIdentity();
    if (identity && identity.privateKey) {
        try {
            // Replay-proof signature over method+path+timestamp+nonce+body.
            // Path is signed without the query string to match the server's ctx.path.
            const timestamp = String(Date.now());
            const nonce = crypto.randomUUID();
            const signPath = path.split('?')[0];
            const canonical = `${method}\n${signPath}\n${timestamp}\n${nonce}\n${bodyString}`;
            const signature = await signEd25519(identity.privateKey, canonical);
            const h = opts.headers as Record<string, string>;
            h['X-Public-Key'] = identity.publicKey;
            h['X-Signature'] = signature;
            h['X-Timestamp'] = timestamp;
            h['X-Nonce'] = nonce;
        } catch (e) {
            console.warn('[API] Could not sign request:', e);
        }
    }

    const res = await fetch(`${BASE}${path}`, opts);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Request failed: ${res.status}`);
    }
    return res.json();
}

// ===================== COMMUNITY =====================

export interface CommunityInfo {
    memberCount: number;
    postCount: number;
    transactionCount: number;
    commonsBalance: number;
}

export interface Member {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    invitedBy: string;
    inviteCode: string;
    homeNodeUrl?: string;   // for federation visitors: their home node URL
    avatarUrl?: string | null;
    profileUpdatedAt?: string | null;
    elderVouchedBy?: string | null;
}

export async function getCommunityInfo(): Promise<CommunityInfo> {
    return request('GET', '/api/community/info');
}

export async function getMembers(): Promise<Member[]> {
    return request('GET', `/api/community/members?_t=${Date.now()}`);
}

export async function registerMember(publicKey: string, callsign: string): Promise<{ success: boolean; member: Member }> {
    return request('POST', '/api/community/register', { publicKey, callsign });
}

// ===================== INVITES =====================

export interface InviteCode {
    code: string;
    createdBy: string;
    createdAt: string;
    usedBy: string | null;
    usedAt: string | null;
    intendedFor?: string;
}

export async function generateInvite(publicKey: string, intendedFor?: string): Promise<{ success: boolean; invite: InviteCode }> {
    return request('POST', '/api/invite/generate', { publicKey, intendedFor });
}

export async function redeemInvite(code: string, publicKey: string, callsign: string): Promise<{ success: boolean; member: Member }> {
    return request('POST', '/api/invite/redeem', { code, publicKey, callsign });
}

export async function redeemOfflineTicket(ticketB64: string, publicKey: string, callsign: string): Promise<{ success: boolean; member: Member }> {
    return request('POST', '/api/invite/redeem-offline', { ticketB64, publicKey, callsign });
}

export async function getInviteTree(root?: string): Promise<any[]> {
    return request('GET', root ? `/api/invite/tree?root=${encodeURIComponent(root)}` : '/api/invite/tree');
}

export async function getCommunityHealth(): Promise<any> {
    return request('GET', '/api/community/health');
}

export async function checkMembership(publicKey: string): Promise<{ isMember: boolean; callsign: string | null }> {
    return request('GET', `/api/community/membership/${encodeURIComponent(publicKey)}?_t=${Date.now()}`);
}

export async function getMyInvites(publicKey: string): Promise<{ invites: InviteCode[] }> {
    return request('GET', `/api/invite/mine/${encodeURIComponent(publicKey)}`);
}

// ===================== PROFILES =====================

export interface MemberProfile {
    publicKey: string;
    avatar: string | null;
    bio: string;
    contact: {
        value: string;
        visibility: 'hidden' | 'trade_partners' | 'community' | 'friends';
    } | null;
    callsign?: string;
    joinedAt?: string;
    elderVouchedBy?: string | null;
    elderVouchedByCallsign?: string | null;
}

export async function updateMemberProfile(publicKey: string, update: {
    avatar?: string | null;
    bio?: string;
    contact?: { value: string; visibility: 'hidden' | 'trade_partners' | 'community' | 'friends' } | null;
}): Promise<{ success: boolean; profile: MemberProfile }> {
    return request('POST', '/api/profile/update', { publicKey, ...update });
}

/** Vouch for a member — hands out the -20 credit floor. Signed POST; server verifies the
 *  actor holds the vouch capability (an admin-appointed voucher). */
export async function vouchMemberApi(targetPubkey: string, level: 1 | 2 | 3 = 1): Promise<{ success: boolean; level: number }> {
    return request('POST', '/api/profile/vouch', { targetPubkey, level });
}

/** Withdraw a vouch. The original voucher (or an admin) only; blocked while the target is negative. */
export async function unvouchMemberApi(targetPubkey: string): Promise<{ success: boolean }> {
    return request('POST', '/api/profile/unvouch', { targetPubkey });
}

/** Read a member's preference flags (holiday_mode, notify_*). Unset keys are absent. */
export async function getMemberPreferences(publicKey: string): Promise<Record<string, string>> {
    return request('GET', `/api/members/preferences?publicKey=${encodeURIComponent(publicKey)}`);
}

/** Toggle holiday mode. Turning it ON throws (with the open-trade count in the message) when the
 *  member still has in-flight trades. Signed POST — the actor is taken from the signature. */
export async function setHolidayModeApi(enabled: boolean): Promise<{ success: boolean; enabled: boolean; openTrades: number }> {
    return request('POST', '/api/members/holiday', { enabled });
}

export async function getMemberProfile(publicKey: string, requester?: string): Promise<MemberProfile> {
    const params = new URLSearchParams();
    if (requester) params.set('requester', requester);
    params.set('_t', Date.now().toString());
    return request('GET', `/api/profile/${encodeURIComponent(publicKey)}?${params}`);
}

// ===================== MESSAGING =====================

export interface Conversation {
    id: string;
    type: 'dm' | 'group';
    name: string | null;
    participants: string[];
    createdBy: string;
    createdAt: string;
    postId?: string;
    postTitle?: string;
    postStatus?: string;
    postPhoto?: string | null;
    lastMsgType?: string;
    lastSysType?: string;
    unreadCount?: number;
    peerCallsign?: string;
    peerAvatar?: string | null;
    peerLastReadAt?: string | null;
}

export enum SystemMessageType {
    ESCROW_CREATED = 'ESCROW_CREATED',
    ESCROW_FUNDED = 'ESCROW_FUNDED',
    ESCROW_RELEASED = 'ESCROW_RELEASED',
    ESCROW_CANCELLED = 'ESCROW_CANCELLED',
    DISPUTE_OPENED = 'DISPUTE_OPENED',
    REVIEW_LEFT = 'REVIEW_LEFT'
}

export interface SystemMessageMetadata {
    amount?: number;        // The Beans involved
    postId: string;         // Link back to the original post
    actorPubkey: string;    // Who triggered the event (Buyer/Seller)
    txHash?: string;        // The ledger transaction ID for verification
    buyerPubkey?: string;
    sellerPubkey?: string;
}

export interface ApiMessage {
    id: string;
    conversationId: string;
    authorPubkey: string;
    ciphertext: string;
    nonce: string;
    type?: 'text' | 'system' | 'image';
    systemType?: SystemMessageType;
    metadata?: string;
    timestamp: string;
}

export interface MessageAttachment {
    data: string;
    nonce: string;
    mime?: string;
}

export async function createConversationApi(
    type: 'dm' | 'group',
    participants: string[],
    createdBy: string,
    name?: string,
    postId?: string,
): Promise<{ success: boolean; conversation: Conversation }> {
    return request('POST', '/api/messages/conversation', { type, participants, createdBy, name, postId });
}

export async function sendMessageApi(
    conversationId: string,
    authorPubkey: string,
    ciphertext: string,
    nonce: string,
    type?: 'text' | 'image',
    attachment?: MessageAttachment,
    metadata?: string,
): Promise<{ success: boolean; message: ApiMessage }> {
    return request('POST', '/api/messages/send', { conversationId, authorPubkey, ciphertext, nonce, type, attachment, metadata });
}

export async function getConversations(publicKey: string): Promise<{ conversations: Conversation[]; totalUnread: number }> {
    return request('GET', `/api/messages/conversations/${encodeURIComponent(publicKey)}`);
}

export async function markConversationReadApi(pubkey: string, conversationId: string): Promise<void> {
    return request('POST', '/api/messages/mark-read', { pubkey, conversationId });
}

export async function getMessageAttachmentApi(messageId: string): Promise<MessageAttachment> {
    return request('GET', `/api/messages/${encodeURIComponent(messageId)}/attachment`);
}

export async function getConversationMessages(conversationId: string, limit = 50): Promise<{
    conversation: Conversation;
    messages: ApiMessage[];
}> {
    return request('GET', `/api/messages/${encodeURIComponent(conversationId)}?limit=${limit}`);
}

// ===================== LEDGER =====================

export interface TierInfo {
    name: string;
    emoji: string;
    canGift: boolean;
    canInvite: boolean;
}

export interface BalanceInfo {
    balance: number;
    floor: number;

    tier: TierInfo;
    earnedCredit?: number;
    grantedCredit?: number;   // vouch/genesis/admin grants (separate lane, no vote weight)
    qualifiedValue?: number;  // diversity-capped trade value behind the earned score
    avgRating?: number;       // reputation multiplier inputs
    reviewCount?: number;
    commonsBalance: number;
    callsign: string;
    trustStats?: {
        tradeCount: number;
        uniquePartners: number;
        ageDays: number;
    };
    /** Elder who vouched for this member, if any. */
    elderVouchedBy?: string | null;
    /** True once the member has ever listed an Offer (Gate 1 cleared). */
    hasListedOffer?: boolean;
    /** True while the member still needs to list an Offer before posting Needs / accepting Offers. */
    isBlockedFromTrading?: boolean;
    /** True once the member has a credit line at all (vouched or granted). Un-vouched → false. */
    activated?: boolean;
    /** True if this member holds the appointed-voucher capability (can hand out the vouch floor). */
    canVouch?: boolean;
    /** True if the member has ≥1 live Offer posted (offer covenant, Gate 2). */
    hasLiveOffer?: boolean;
    /** Trust Model v3 — the floor you may actually reach now = shallower of earned limit & what your live Offers unlock. */
    usableFloor?: number;
    /** Trust Model v3 — count of currently-live Offers (drives the offer-band credit ladder). */
    liveOffers?: number;
    /** Trust Model v3 — true when your debt is below your usable floor (spending is frozen until you recover or post Offers). */
    frozen?: boolean;
}

export interface Transaction {
    id: string;
    from: string;
    to: string;
    amount: number;
    taxFee?: number;
    memo: string;
    timestamp: string;
}

export async function getBalance(publicKey: string): Promise<BalanceInfo> {
    return request('GET', `/api/ledger/balance/${encodeURIComponent(publicKey)}`);
}

export async function sendTransfer(from: string, to: string, amount: number, memo: string): Promise<{ success: boolean; transaction: Transaction }> {
    return request('POST', '/api/ledger/transfer', { from, to, amount, memo });
}

export async function getTransactions(publicKey?: string, limit = 50): Promise<Transaction[]> {
    const params = new URLSearchParams();
    if (publicKey) params.set('publicKey', publicKey);
    params.set('limit', String(limit));
    return request('GET', `/api/ledger/transactions?${params}`);
}

// ===================== MARKETPLACE =====================

export interface MarketplacePost {
    id: string;
    type: 'offer' | 'need';
    category: string;
    title: string;
    description: string;
    credits: number;
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly';
    authorPublicKey: string;
    authorCallsign: string;
    createdAt: string;
    active: boolean;
    status: 'active' | 'pending' | 'paused' | 'completed' | 'cancelled';
    repeatable: boolean;
    acceptedBy?: string;
    acceptedByCallsign?: string;
    acceptedAt?: string;
    pendingTransactionId?: string;
    completedAt?: string;
    lat?: number;
    lng?: number;
    photos?: string[];
    authorEnergyCycled?: number;
    authorFoundingNeeded?: boolean; // author has no completed trades yet — their first trade unlocks their floor
}

export interface MarketplaceTransaction {
    id: string;
    postId: string;
    postTitle: string;
    buyerPublicKey: string;
    buyerCallsign: string;
    sellerPublicKey: string;
    sellerCallsign: string;
    credits: number;
    hours?: number;
    status: 'requested' | 'rejected' | 'pending' | 'completed' | 'cancelled';
    createdAt: string;
    completedAt?: string;
    ratedByBuyer?: boolean;
    ratedBySeller?: boolean;
}

export async function getMarketplacePosts(filter?: { id?: string; type?: string; category?: string; author?: string }): Promise<MarketplacePost[]> {
    const params = new URLSearchParams();
    if (filter?.id) params.set('id', filter.id);
    if (filter?.type) params.set('type', filter.type);
    if (filter?.category) params.set('category', filter.category);
    if (filter?.author) params.set('author', filter.author);
    return request('GET', `/api/marketplace/posts?${params}`);
}

export async function createMarketplacePost(post: {
    type: 'offer' | 'need';
    category: string;
    title: string;
    description: string;
    credits: number;
    priceType?: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly';
    authorPublicKey: string;
    lat?: number;
    lng?: number;
    photos?: string[];
    repeatable?: boolean;
}): Promise<{ success: boolean; post: MarketplacePost }> {
    return request('POST', '/api/marketplace/posts', post);
}

export async function removeMarketplacePost(id: string, authorPublicKey: string): Promise<{ success: boolean }> {
    return request('POST', '/api/marketplace/posts/remove', { id, authorPublicKey });
}

export async function updateMarketplacePost(
    id: string,
    authorPublicKey: string,
    updates: {
        type?: 'offer' | 'need';
        category?: string;
        title?: string;
        description?: string;
        credits?: number;
        priceType?: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly';
        lat?: number;
        lng?: number;
        repeatable?: boolean;
        photos?: string[];
    },
): Promise<{ success: boolean; post: MarketplacePost }> {
    return request('POST', '/api/marketplace/posts/update', { id, authorPublicKey, ...updates });
}

// ===================== MARKETPLACE TRANSACTIONS =====================

export async function acceptMarketplacePost(
    postId: string, buyerPublicKey: string, hours?: number
): Promise<{ success: boolean; transaction: MarketplaceTransaction }> {
    return request('POST', '/api/marketplace/posts/accept', { postId, buyerPublicKey, hours });
}

export async function requestMarketplacePost(
    postId: string, buyerPublicKey: string, hours?: number
): Promise<{ success: boolean; transaction: MarketplaceTransaction }> {
    return request('POST', '/api/marketplace/posts/request', { postId, buyerPublicKey, hours });
}

export async function approveMarketplaceRequest(
    transactionId: string, authorPublicKey: string
): Promise<{ success: boolean; transaction: MarketplaceTransaction }> {
    return request('POST', '/api/marketplace/transactions/approve', { transactionId, authorPublicKey });
}

export async function rejectMarketplaceRequest(
    transactionId: string, authorPublicKey: string
): Promise<{ success: boolean }> {
    return request('POST', '/api/marketplace/transactions/reject', { transactionId, authorPublicKey });
}

export async function cancelMarketplaceRequest(
    transactionId: string, cancellerPublicKey: string
): Promise<{ success: boolean }> {
    return request('POST', '/api/marketplace/transactions/cancel-request', { transactionId, cancellerPublicKey });
}

export async function completeMarketplaceTransaction(
    transactionId: string, confirmerPublicKey: string, finalHours?: number
): Promise<{ success: boolean; transaction: MarketplaceTransaction }> {
    return request('POST', '/api/marketplace/transactions/complete', { transactionId, confirmerPublicKey, finalHours });
}

export async function cancelMarketplaceTransaction(
    transactionId: string, cancellerPublicKey: string
): Promise<{ success: boolean; transaction: MarketplaceTransaction }> {
    return request('POST', '/api/marketplace/transactions/cancel', { transactionId, cancellerPublicKey });
}

export async function pauseMarketplacePost(
    postId: string, authorPublicKey: string
): Promise<{ success: boolean }> {
    return request('POST', '/api/marketplace/posts/pause', { postId, authorPublicKey });
}

export async function resumeMarketplacePost(
    postId: string, authorPublicKey: string
): Promise<{ success: boolean }> {
    return request('POST', '/api/marketplace/posts/resume', { postId, authorPublicKey });
}

export async function getMyMarketplaceTransactions(
    publicKey: string, status?: string
): Promise<MarketplaceTransaction[]> {
    const params = new URLSearchParams({ publicKey });
    if (status) params.set('status', status);
    return request('GET', `/api/marketplace/transactions?${params}`);
}

// ===================== RATINGS =====================

export interface Rating {
    id: string;
    targetPubkey: string;
    raterPubkey: string;
    stars: number;
    comment: string;
    role: 'provider' | 'receiver';
    transactionId: string;
    createdAt: string;
    // Present on "reviews given" results (who the review was about) — populated server-side
    target_callsign?: string;
    target_avatar?: string | null;
}

export async function submitRating(raterPubkey: string, targetPubkey: string, stars: number, comment: string, transactionId: string): Promise<{ success: boolean; rating: Rating }> {
    return request('POST', '/api/ratings', { raterPubkey, targetPubkey, stars, comment, transactionId });
}

export async function getMemberRatings(publicKey: string): Promise<{ ratings: Rating[]; average: number; count: number; asProvider: { average: number; count: number }; asReceiver: { average: number; count: number } }> {
    return request('GET', `/api/ratings/${publicKey}`);
}

export async function getRatingsGiven(publicKey: string): Promise<{ ratings: Rating[] }> {
    return request('GET', `/api/ratings/${publicKey}?direction=given`);
}

// ===================== REPORTS =====================

export async function reportAbuse(reporterPubkey: string, targetPubkey: string, reason: string, targetPostId?: string): Promise<{ success: boolean }> {
    return request('POST', '/api/reports', { reporterPubkey, targetPubkey, reason, targetPostId });
}

// ===================== FRIENDS =====================

export interface FriendEntry {
    publicKey: string;
    callsign: string;
    addedAt: string;
    isGuardian: boolean;
}

export async function getFriends(publicKey: string): Promise<FriendEntry[]> {
    return request('GET', `/api/friends/${publicKey}`);
}

export async function addFriendApi(ownerPubkey: string, friendPubkey: string): Promise<{ success: boolean; friend: FriendEntry }> {
    return request('POST', '/api/friends/add', { ownerPubkey, friendPubkey });
}

export async function removeFriendApi(ownerPubkey: string, friendPubkey: string): Promise<{ success: boolean }> {
    return request('POST', '/api/friends/remove', { ownerPubkey, friendPubkey });
}

export async function setGuardianApi(ownerPubkey: string, friendPubkey: string, isGuardian: boolean): Promise<{ success: boolean }> {
    return request('POST', '/api/friends/guardian', { ownerPubkey, friendPubkey, isGuardian });
}

// ===================== MEMBERS =====================

export interface MemberSummary {
    publicKey: string;
    callsign: string;
    joinedAt: string;
}

export async function getAllMembers(): Promise<MemberSummary[]> {
    return request('GET', `/api/members?_t=${Date.now()}`);
}

// ===================== FEDERATION =====================

export interface NodeInfo {
    name: string;
    memberCount: number;
    postCount: number;
    peerNodes: { callsign: string; publicUrl: string | null }[];
}

/** Fetch node info from a remote node */
export async function getNodeInfo(baseUrl: string): Promise<NodeInfo> {
    const res = await fetch(`${baseUrl}/api/node/info`);
    if (!res.ok) throw new Error(`Failed to fetch node info from ${baseUrl}`);
    return res.json();
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Fetch marketplace posts from a remote node (cached in sessionStorage for 5 min) */
export async function getRemotePosts(baseUrl: string, filters?: { type?: string; category?: string }): Promise<MarketplacePost[]> {
    const cacheKey = `bp_remote_posts_${baseUrl}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < CACHE_TTL_MS) return data;
    }

    const params = new URLSearchParams();
    if (filters?.type) params.set('type', filters.type);
    if (filters?.category) params.set('category', filters.category);
    const qs = params.toString() ? `?${params}` : '';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let res;
    try {
        res = await fetch(`${baseUrl}/api/marketplace/posts${qs}`, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
    
    if (!res.ok) throw new Error(`Failed to fetch posts from ${baseUrl}`);
    const data = await res.json();

    try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
    } catch { /* sessionStorage might be full */ }

    return data;
}

/** Send a credit transfer to a remote node's ledger */
// A2-7 (PWA-3): remote peer URLs come from the server-supplied federation peer
// list, so a malicious node could point a money/message call at an arbitrary
// endpoint. Require https:// before sending anything sensitive there. (Full
// hardening — routing these through the signed request() path + a peer allowlist —
// is tracked; this closes the cleartext/arbitrary-scheme redirect.)
function assertHttpsPeerUrl(url: string): void {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error('Invalid peer node URL'); }
    if (u.protocol !== 'https:') throw new Error('Refusing to contact a non-HTTPS peer node');
}

export async function sendRemoteTransfer(
    baseUrl: string, from: string, to: string, amount: number, memo: string
): Promise<{ success: boolean; transaction: Transaction }> {
    assertHttpsPeerUrl(baseUrl);
    const res = await fetch(`${baseUrl}/api/ledger/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, amount, memo }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Transfer failed' }));
        throw new Error(err.error || 'Remote transfer failed');
    }
    return res.json();
}

/** Send a federation relay message — delivers to remote node AND stores locally */
export async function sendFederationMessage(
    targetNodeUrl: string,
    senderPublicKey: string,
    senderCallsign: string,
    recipientPublicKey: string,
    ciphertext: string,
    nonce: string,
): Promise<{ conversationId: string }> {
    assertHttpsPeerUrl(targetNodeUrl); // A2-7: never relay to a non-HTTPS peer
    const homeNodeUrl = window.location.origin;
    const payload = {
        senderPublicKey,
        senderCallsign,
        senderNodeUrl: homeNodeUrl,
        recipientPublicKey,
        ciphertext,
        nonce,
    };

    // 1. Deliver to the remote node
    const remoteRes = await fetch(`${targetNodeUrl}/api/federation/relay-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!remoteRes.ok) {
        const err = await remoteRes.json().catch(() => ({ error: 'Relay failed' }));
        throw new Error(err.error || 'Failed to relay message to remote node');
    }

    // 2. Store locally so the sender can see the conversation in their Chat tab
    const localRes = await fetch(`/api/federation/relay-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...payload,
            // Swap perspective: on our node, the "sender" is us (already a member),
            // the "recipient" is the remote user (will be registered as visitor)
            recipientPublicKey: recipientPublicKey,
        }),
    });
    if (!localRes.ok) {
        // Remote delivery succeeded but local copy failed — still usable
        console.warn('Failed to store local copy of federation message');
        return { conversationId: '' };
    }
    const localData = await localRes.json();
    return { conversationId: localData.conversationId };
}

/** Check balance on a remote node */
export async function getRemoteBalance(baseUrl: string, publicKey: string): Promise<BalanceInfo> {
    const res = await fetch(`${baseUrl}/api/ledger/balance/${encodeURIComponent(publicKey)}`);
    if (!res.ok) throw new Error(`Failed to fetch balance from ${baseUrl}`);
    return res.json();
}

// ===================== COMMUNITY COMMONS =====================

export interface CommunityProject {
    id: string;
    title: string;
    description: string;
    proposerPubkey: string;
    proposerCallsign: string;
    requestedAmount: number;
    status: 'proposed' | 'active' | 'funded' | 'rejected' | 'completed';
    votes: { pubkey: string; weight: number; creditsUsed?: number }[];
    createdAt: string;
    fundedAt?: string;
}

export interface VotingRound {
    id: string;
    status: 'open' | 'closed';
    closesAt: string;
    projectIds: string[];
    createdBy: string;
    createdAt: string;
}

export async function getCommonsBalance(): Promise<{ balance: number }> {
    return request('GET', '/api/commons/balance');
}

export async function getCommonsProjects(): Promise<{ projects: CommunityProject[]; activeRound: VotingRound | null }> {
    return request('GET', '/api/commons/projects');
}

export async function proposeProject(proposerPubkey: string, title: string, description: string, requestedAmount: number): Promise<{ success: boolean; project: CommunityProject }> {
    return request('POST', '/api/commons/projects', { proposerPubkey, title, description, requestedAmount });
}

export async function updateCommunityProject(proposerPubkey: string, projectId: string, title: string, description: string, requestedAmount: number): Promise<{ success: boolean }> {
    return request('POST', '/api/commons/projects/update', { proposerPubkey, projectId, title, description, requestedAmount });
}

export async function deleteCommunityProject(proposerPubkey: string, projectId: string): Promise<{ success: boolean }> {
    return request('POST', '/api/commons/projects/delete', { proposerPubkey, projectId });
}

export async function voteForProject(voterPubkey: string, projectId: string, voteCount: number = 1): Promise<{ success: boolean; creditsUsed?: number }> {
    return request('POST', '/api/commons/vote', { voterPubkey, projectId, voteCount });
}

export async function getGovernanceCredits(pubkey: string): Promise<{ totalCredits: number; usedCredits: number; availableCredits: number }> {
    return request('GET', `/api/commons/my-credits/${encodeURIComponent(pubkey)}`);
}

export async function getVotingRounds(): Promise<{ rounds: VotingRound[]; activeRound: VotingRound | null }> {
    return request('GET', '/api/commons/rounds');
}

// ===================== CROWDFUNDING =====================

export interface CrowdfundProject {
    id: string;
    creator_pubkey: string;
    title: string;
    description: string;
    photos: string; // JSON string array
    goal_amount: number;
    current_amount: number;
    commons_allocation?: number; // Amount allocated from the Commons Pool (admin-triggered)
    deadline_at: string | null;
    status: string;
    created_at: string;
}

export async function getCrowdfundProjects(): Promise<{ projects: CrowdfundProject[], maxProjectExpiryDays: number }> {
    return request('GET', '/api/crowdfund/projects');
}

export async function getCrowdfundProject(id: string): Promise<{ project: CrowdfundProject }> {
    return request('GET', `/api/crowdfund/projects/${id}`);
}

export async function createCrowdfundProject(creatorPubkey: string, title: string, description: string, photos: string[], goalAmount: number, deadlineAt: string | null): Promise<{ success: boolean; project: CrowdfundProject }> {
    return request('POST', '/api/crowdfund/projects', { creatorPubkey, title, description, photos, goalAmount, deadlineAt });
}

export async function updateCrowdfundProject(id: string, creatorPubkey: string, title: string, description: string, photos: string[], goalAmount: number, deadlineAt: string | null = null): Promise<{ success: boolean; project: CrowdfundProject }> {
    return request('POST', '/api/crowdfund/projects/update', { id, creatorPubkey, title, description, photos, goalAmount, deadlineAt });
}

export async function pledgeToCrowdfundProject(projectId: string, fromPubkey: string, amount: number, memo: string): Promise<{ success: boolean; txId: string }> {
    return request('POST', `/api/crowdfund/projects/${projectId}/pledge`, { fromPubkey, amount, memo });
}

// ===================== NODE CONFIG =====================

export interface NodeConfig {
    serviceRadius?: { lat: number; lng: number; radiusKm: number };
    publishToDirectory?: boolean;
}

export async function getNodeConfig(): Promise<NodeConfig> {
    return request('GET', '/api/node/config');
}
