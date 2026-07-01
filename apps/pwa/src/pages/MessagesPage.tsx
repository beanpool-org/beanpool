/**
 * MessagesPage — Conversations list + chat view
 *
 * Two modes:
 *  - List: shows all conversations with last message preview
 *  - Chat: shows messages in a conversation with send input
 */

import { useState, useEffect, useRef } from 'react';
import {
    getConversations, getConversationMessages, createConversationApi,
    sendMessageApi, getMessageAttachmentApi, getMembers, sendFederationMessage,
    markConversationReadApi, getMyMarketplaceTransactions,
    type Conversation, type ApiMessage, type Member, type MarketplaceTransaction,
} from '../lib/api';
import { encodePlaintext, decodePlaintext, encryptDM, decryptDM, isEncryptedNonce, type DMKeyContext } from '../lib/e2e-crypto';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { onSyncActivity } from '../lib/sync';

interface Props {
    identity: BeanPoolIdentity;
    openConversationId?: string | null;
    onConversationOpened?: () => void;
    onNavigate?: (tab: string, contextId?: string) => void;
}

/** Resize/compress a picked image to a JPEG data URI (keeps attachments light). */
function resizeImageToDataUri(file: File, maxW: number, quality: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new window.Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, maxW / img.width);
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const cctx = canvas.getContext('2d');
            if (!cctx) { reject(new Error('Canvas not supported')); return; }
            cctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
        img.src = url;
    });
}

function formatSystemMessage(msg: any, myPubkey: string, userTransactions: any[]) {
    let metaObj: any = null;
    try {
        if (msg.metadata) metaObj = JSON.parse(msg.metadata);
    } catch {}

    const amount = metaObj?.amount ?? '';
    const beansStr = amount ? `${amount} Beans` : 'Beans';

    if (msg.systemType === 'ESCROW_FUNDED') {
        return `${beansStr} held in trust.`;
    }

    if (msg.systemType === 'ESCROW_RELEASED') {
        // Find transaction to see who is the seller (provider)
        const sellerPubkey = metaObj?.sellerPubkey || 
            userTransactions.find(t => t.postId === metaObj?.postId)?.sellerPublicKey;
        
        const isSeller = sellerPubkey === myPubkey;
        if (isSeller) {
            return `Payment of ${beansStr} released to you.`;
        } else {
            return `Payment of ${beansStr} released to the provider.`;
        }
    }

    if (msg.systemType === 'ESCROW_CANCELLED') {
        return `Trust hold cancelled and funds refunded.`;
    }

    // Fallback: clean up Ʀ or R in the ciphertext
    let txt = msg.ciphertext || '';
    if (txt.includes('Ʀ')) {
        txt = txt.replace(/Ʀ(\d+)/g, '$1 Beans').replace(/Ʀ/g, 'Beans');
    }
    if (txt.includes('Payment of R')) {
        txt = txt.replace(/Payment of R(\d+) released to the provider\./g, (_: string, amt: string) => {
            const sellerPubkey = metaObj?.sellerPubkey || 
                userTransactions.find(t => t.postId === metaObj?.postId)?.sellerPublicKey;
            const isSeller = sellerPubkey === myPubkey;
            return `Payment of ${amt} Beans released to ${isSeller ? 'you' : 'the provider'}.`;
        });
        txt = txt.replace(/R(\d+) has been placed in escrow\./g, '$1 Beans held in trust.');
    }
    return txt;
}

/** Lazily fetch + decrypt an encrypted image attachment, then render it. */
function ChatImageBubble({ messageId, conversationId, peerPubHex, myPrivHex, originalConversationId, originalConversationIds }:
    { messageId: string; conversationId: string; peerPubHex: string; myPrivHex: string; originalConversationId?: string; originalConversationIds?: string[] }) {
    const [uri, setUri] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const att = await getMessageAttachmentApi(messageId);
                let dataUri: string | null = null;
                try {
                    dataUri = decryptDM(att.data, att.nonce, { myEdPrivHex: myPrivHex, peerEdPubHex: peerPubHex, conversationId });
                } catch (err) {
                    let decrypted = false;
                    if (originalConversationId) {
                        try {
                            dataUri = decryptDM(att.data, att.nonce, { myEdPrivHex: myPrivHex, peerEdPubHex: peerPubHex, conversationId: originalConversationId });
                            decrypted = true;
                        } catch (e) {}
                    } else if (Array.isArray(originalConversationIds)) {
                        for (const legacyId of originalConversationIds) {
                            try {
                                dataUri = decryptDM(att.data, att.nonce, { myEdPrivHex: myPrivHex, peerEdPubHex: peerPubHex, conversationId: legacyId });
                                decrypted = true;
                                break;
                            } catch (e) {}
                        }
                    }
                    if (!decrypted) throw err;
                }
                if (active) setUri(dataUri);
            } catch { if (active) setFailed(true); }
        })();
        return () => { active = false; };
    }, [messageId, conversationId, peerPubHex, myPrivHex, originalConversationId, originalConversationIds]);
    if (failed) return <span style={{ fontStyle: 'italic', opacity: 0.7 }}>🔒 Image unavailable</span>;
    if (!uri) return <span style={{ opacity: 0.6 }}>Loading image…</span>;
    return <img src={uri} alt="" style={{ maxWidth: '220px', borderRadius: '12px', display: 'block' }} />;
}

export function MessagesPage({ identity, openConversationId, onConversationOpened, onNavigate }: Props) {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [userTransactions, setUserTransactions] = useState<MarketplaceTransaction[]>([]);
    const [activeTab, setActiveTab] = useState<'all' | 'transactions' | 'direct'>('all');
    const [activeConv, setActiveConv] = useState<Conversation | null>(null);
    const [messages, setMessages] = useState<ApiMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [showNewDm, setShowNewDm] = useState(false);
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [members, setMembers] = useState<Member[]>([]);
    const [groupName, setGroupName] = useState('');
    const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const pollRef = useRef<number | null>(null);
    const [replyToMessage, setReplyToMessage] = useState<ApiMessage | null>(null);

    useEffect(() => {
        loadConversations();
        loadMembers();
        const unsubscribe = onSyncActivity(() => {
            loadConversations();
        });
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        if (activeConv) {
            setReplyToMessage(null);
            loadMessages(activeConv.id);
            // Mark conversation as read when opened
            markConversationReadApi(identity.publicKey, activeConv.id).catch(() => {});
            // Poll for new messages every 3 seconds (backstop)
            pollRef.current = window.setInterval(() => loadMessages(activeConv.id), 3000);
            // Fast path: the WebSocket doorbell refreshes this conversation
            // immediately, instead of waiting for the next poll tick.
            const unsubscribe = onSyncActivity(() => loadMessages(activeConv.id));
            return () => {
                if (pollRef.current) clearInterval(pollRef.current);
                unsubscribe();
            };
        }
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [activeConv?.id]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    async function loadConversations() {
        try {
            const result = await getConversations(identity.publicKey);
            setConversations(result.conversations);
            const txs = await getMyMarketplaceTransactions(identity.publicKey);
            setUserTransactions(txs);
        } catch { /* offline */ }
    }

    // Auto-open conversation when navigating from Market "Message" button
    useEffect(() => {
        if (!openConversationId) return;
        loadConversations().then(() => {
            // Find the conversation and open it
            getConversations(identity.publicKey).then(result => {
                const conv = result.conversations.find((c: Conversation) => c.id === openConversationId);
                if (conv) {
                    setActiveConv(conv);
                }
                onConversationOpened?.();
            });
        });
    }, [openConversationId]);

    async function loadMessages(convId: string) {
        try {
            const result = await getConversationMessages(convId);
            setMessages(result.messages);
        } catch { /* offline */ }
    }

    async function loadMembers() {
        try {
            const result = await getMembers();
            setMembers(result.filter((m: Member) => m.publicKey !== identity.publicKey));
        } catch { /* offline */ }
    }

    async function handleStartDm(memberPubkey: string) {
        try {
            const result = await createConversationApi(
                'dm',
                [identity.publicKey, memberPubkey],
                identity.publicKey,
            );
            setActiveConv(result.conversation);
            setShowNewDm(false);
            await loadConversations();
        } catch (err: any) {
            alert(err.message || 'Failed to start conversation');
        }
    }

    async function handleCreateGroup() {
        if (selectedMembers.length < 1 || !groupName.trim()) return;
        try {
            const result = await createConversationApi(
                'group',
                [identity.publicKey, ...selectedMembers],
                identity.publicKey,
                groupName.trim(),
            );
            setActiveConv(result.conversation);
            setShowNewGroup(false);
            setGroupName('');
            setSelectedMembers([]);
            await loadConversations();
        } catch (err: any) {
            alert(err.message || 'Failed to create group');
        }
    }

    // E2E key context for a 2-party DM, or null for groups/unknown peer (NAT-1).
    function dmCtxFor(conv: Conversation | null): DMKeyContext | null {
        if (!conv || conv.type !== 'dm') return null;
        const peer = (conv.participants || []).find(p => p && p !== identity.publicKey);
        if (!peer) return null;
        return { myEdPrivHex: identity.privateKey, peerEdPubHex: peer, conversationId: conv.id };
    }

    async function handleSend() {
        if (!draft.trim() || !activeConv) return;
        setSending(true);
        try {
            const ctx = dmCtxFor(activeConv);
            const { ciphertext, nonce } = ctx ? encryptDM(draft.trim(), ctx) : encodePlaintext(draft.trim());
            let metadata: string | undefined = undefined;
            if (replyToMessage) {
                metadata = JSON.stringify({ replyToId: replyToMessage.id });
            }
            // 1. Store locally (Server will handle Libp2p federation relay automatically)
            await sendMessageApi(activeConv.id, identity.publicKey, ciphertext, nonce, undefined, undefined, metadata);

            setDraft('');
            setReplyToMessage(null);
            await loadMessages(activeConv.id);
        } catch (err: any) {
            alert(err.message || 'Failed to send message');
        } finally {
            setSending(false);
        }
    }

    async function handleSendImage(file: File) {
        if (!activeConv) return;
        const ctx = dmCtxFor(activeConv);
        if (!ctx) { alert('Photos can only be sent in direct messages.'); return; }
        setSending(true);
        try {
            const dataUri = await resizeImageToDataUri(file, 1000, 0.7);
            const encImg = encryptDM(dataUri, ctx);   // big blob -> lazy attachment
            const encCap = encryptDM('', ctx);          // empty caption -> message body
            let metadata: string | undefined = undefined;
            if (replyToMessage) {
                metadata = JSON.stringify({ replyToId: replyToMessage.id });
            }
            await sendMessageApi(activeConv.id, identity.publicKey, encCap.ciphertext, encCap.nonce, 'image',
                { data: encImg.ciphertext, nonce: encImg.nonce, mime: 'image/jpeg' }, metadata);
            setReplyToMessage(null);
            await loadMessages(activeConv.id);
        } catch (err: any) {
            alert(err.message || 'Failed to send image');
        } finally {
            setSending(false);
        }
    }

    function decryptMessage(msg: ApiMessage): string {
        try {
            if (msg.nonce === '00000') return msg.ciphertext;
            if (isEncryptedNonce(msg.nonce)) {
                const ctx = dmCtxFor(activeConv);
                if (!ctx) return '[Encrypted — update your app to read]';
                try {
                    return decryptDM(msg.ciphertext, msg.nonce, ctx);
                } catch (err) {
                    if (msg.metadata) {
                        try {
                            const meta = JSON.parse(msg.metadata);
                            if (meta) {
                                if (meta.originalConversationId) {
                                    const legacyCtx = { ...ctx, conversationId: meta.originalConversationId };
                                    return decryptDM(msg.ciphertext, msg.nonce, legacyCtx);
                                } else if (Array.isArray(meta.originalConversationIds)) {
                                    for (const legacyId of meta.originalConversationIds) {
                                        try {
                                            const legacyCtx = { ...ctx, conversationId: legacyId };
                                            return decryptDM(msg.ciphertext, msg.nonce, legacyCtx);
                                        } catch (e) {}
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                    throw err;
                }
            }
            return decodePlaintext(msg.ciphertext, msg.nonce);
        } catch {
            return '[Unable to decrypt this message]';
        }
    }

    function getConversationTitle(conv: Conversation): string {
        if (conv.type === 'group') return conv.name || 'Group';
        // Prefer server-provided peerCallsign, fall back to member lookup
        if (conv.peerCallsign) return conv.peerCallsign;
        const otherPubkey = conv.participants.find(p => p !== identity.publicKey) || '';
        const member = members.find(m => m.publicKey === otherPubkey);
        return member?.callsign || otherPubkey.substring(0, 12) + '…';
    }

    /** Render an avatar circle — shows image if avatarUrl present, letter fallback otherwise */
    function renderAvatar(avatarUrl: string | null | undefined, fallbackChar: string, size = 40, style?: React.CSSProperties) {
        const resolved = resolveAvatarUrl(avatarUrl);
        if (resolved) {
            return (
                <img
                    src={resolved}
                    alt=""
                    style={{
                        width: `${size}px`, height: `${size}px`, borderRadius: '50%',
                        objectFit: 'cover', flexShrink: 0, ...style,
                    }}
                />
            );
        }
        return (
            <div style={{
                width: `${size}px`, height: `${size}px`, borderRadius: '50%',
                background: 'var(--bg-hover)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: `${size * 0.45}px`, fontWeight: 700,
                color: 'var(--text-muted)', flexShrink: 0, ...style,
            }}>
                {fallbackChar.charAt(0).toUpperCase()}
            </div>
        );
    }

    function toggleMemberSelection(pubkey: string) {
        setSelectedMembers(prev =>
            prev.includes(pubkey)
                ? prev.filter(p => p !== pubkey)
                : [...prev, pubkey]
        );
    }

    // ===================== RENDER =====================

    const cardStyle: React.CSSProperties = {
        background: 'var(--bg-card)',
        border: '1px solid var(--border-primary)',
        borderRadius: '12px',
        padding: '0.75rem 1rem',
        marginBottom: '0.5rem',
        cursor: 'pointer',
        transition: 'border-color 0.2s',
    };

    const inputStyle: React.CSSProperties = {
        flex: 1,
        padding: '0.5rem 1rem',
        borderRadius: '20px',
        border: '1px solid var(--border-input)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontSize: '0.95rem',
        fontFamily: 'inherit',
        outline: 'none',
        height: '40px',
        boxSizing: 'border-box',
    };

    // New DM / Group overlays
    if (showNewDm || showNewGroup) {
        return (
            <div style={{ padding: '1rem', maxWidth: '500px', margin: '0 auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                    <button
                        onClick={() => { setShowNewDm(false); setShowNewGroup(false); }}
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '1rem', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                        ← Back
                    </button>
                    <h2 style={{ fontSize: '1.2rem', margin: 0 }}>
                        {showNewGroup ? 'New Group' : 'New Message'}
                    </h2>
                </div>

                {showNewGroup && (
                    <input
                        type="text"
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        placeholder="Group name"
                        style={{ ...inputStyle, width: '100%', marginBottom: '1rem', borderRadius: '10px' }}
                    />
                )}

                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                    {showNewGroup ? 'Select members to add:' : 'Choose someone to message:'}
                </p>
                {members.map(m => (
                    <div
                        key={m.publicKey}
                        onClick={() => showNewGroup ? toggleMemberSelection(m.publicKey) : handleStartDm(m.publicKey)}
                        style={{
                            ...cardStyle,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            borderColor: selectedMembers.includes(m.publicKey) ? 'var(--accent)' : 'var(--border-primary)',
                        }}
                    >
                        <div style={{
                            width: '36px', height: '36px', borderRadius: '50%',
                            overflow: 'hidden', flexShrink: 0,
                        }}>
                            {renderAvatar(m.avatarUrl, m.callsign, 36)}
                        </div>
                        <span style={{ fontWeight: 600 }}>{m.callsign}</span>
                        {showNewGroup && selectedMembers.includes(m.publicKey) && (
                            <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>✓</span>
                        )}
                    </div>
                ))}

                {showNewGroup && selectedMembers.length > 0 && (
                    <button
                        onClick={handleCreateGroup}
                        disabled={!groupName.trim()}
                        style={{
                            width: '100%', padding: '0.85rem', borderRadius: '10px',
                            border: 'none', background: groupName.trim() ? 'var(--accent)' : 'var(--bg-hover)',
                            color: groupName.trim() ? '#fff' : 'var(--text-muted)', fontSize: '1rem', fontWeight: 600,
                            cursor: groupName.trim() ? 'pointer' : 'not-allowed',
                            fontFamily: 'inherit', marginTop: '1rem',
                        }}
                    >
                        Create Group ({selectedMembers.length + 1} members)
                    </button>
                )}
            </div>
        );
    }

    // Chat view
    if (activeConv) {
        return (
            <div style={{
                display: 'flex', flexDirection: 'column',
                height: '100%', maxWidth: '500px', margin: '0 auto',
            }}>
                {/* Chat header */}
                <div style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                    padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-primary)',
                }}>
                    <button
                        onClick={() => { setActiveConv(null); loadConversations(); }}
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '1rem', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                        ←
                    </button>
                    {renderAvatar(activeConv.peerAvatar, getConversationTitle(activeConv), 32)}
                    <div>
                        <div style={{ fontWeight: 600, fontSize: '1rem' }}>
                            {getConversationTitle(activeConv)}
                        </div>
                        {activeConv.type === 'group' && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                {activeConv.participants.length} members
                            </div>
                        )}
                    </div>
                </div>

                {/* Sticky Marketplace Header */}
                {activeConv.postId && (
                    <div style={{
                        background: '#ecfdf5', padding: '0.75rem 1rem', borderBottom: '1px solid #d1fae5',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer',
                    }} onClick={() => {}}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <span style={{ fontSize: '1.2rem' }}>🛍️</span>
                            <div>
                                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#065f46' }}>View Attached Listing</div>
                                <div style={{ fontSize: '0.75rem', color: '#059669' }}>Marketplace Transaction Thread</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Messages */}
                <div style={{
                    flex: 1, overflowY: 'auto', padding: '1rem',
                    display: 'flex', flexDirection: 'column', gap: '0.3rem',
                }}>
                    {messages.length === 0 && (
                        <p style={{ textAlign: 'center', color: 'var(--text-faint)', marginTop: '2rem' }}>
                            No messages yet. Say hello! 👋
                        </p>
                    )}
                    {messages.map(msg => {
                        const isSystem = msg.type === 'system' || msg.authorPubkey === 'SYSTEM';
                        
                        if (isSystem) {
                            let icon = 'ℹ️';
                            let bgColor = 'var(--bg-hover)';
                            let textColor = 'var(--text-secondary)';
                            let borderColor = 'transparent';
                            let metaObj: any;
                            
                            try {
                                if (msg.metadata) metaObj = JSON.parse(msg.metadata);
                            } catch {}

                            if (msg.systemType === 'ESCROW_FUNDED') {
                                icon = '🔐';
                                bgColor = 'rgba(209, 250, 229, 0.4)';
                                textColor = '#065f46';
                                borderColor = '#10b981';
                            }
                            if (msg.systemType === 'ESCROW_RELEASED') {
                                icon = '✅';
                                bgColor = 'rgba(167, 243, 208, 0.4)';
                                textColor = '#065f46';
                                borderColor = '#059669';
                            }
                            if (msg.systemType === 'ESCROW_CANCELLED') {
                                icon = '🚫';
                                bgColor = 'rgba(254, 226, 226, 0.4)';
                                textColor = '#991b1b';
                                borderColor = '#ef4444';
                            }

                            return (
                                <div key={msg.id} style={{
                                    alignSelf: 'center',
                                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                                    margin: '0.5rem 0'
                                }}>
                                    <div style={{
                                        background: bgColor, color: textColor,
                                        border: `1px solid ${borderColor}`,
                                        borderRadius: '16px', padding: '0.4rem 0.8rem',
                                        fontSize: '0.8rem', fontWeight: 600
                                    }}>
                                        {icon} {formatSystemMessage(msg, identity.publicKey, userTransactions)}
                                    </div>
                                    
                                    {msg.systemType === 'ESCROW_FUNDED' && metaObj?.postId && (
                                        <button
                                            onClick={() => onNavigate?.('marketplace', metaObj.postId)}
                                            style={{
                                                marginTop: '0.5rem', background: '#fff', color: '#10b981', border: '1px solid #10b981',
                                                padding: '4px 12px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer'
                                            }}
                                        >
                                            🏷️ View Post
                                        </button>
                                    )}
                                    
                                    {msg.systemType === 'ESCROW_RELEASED' && metaObj?.postId && (() => {
                                        const relatedTx = userTransactions.find(t => t.postId === metaObj.postId && t.status === 'completed');
                                        const isBuyer = relatedTx ? relatedTx.buyerPublicKey === identity.publicKey : false;
                                        const hasRated = relatedTx ? (isBuyer ? relatedTx.ratedByBuyer : relatedTx.ratedBySeller) : false;
                                        return (
                                            <button
                                                onClick={() => onNavigate?.('marketplace', metaObj.postId)}
                                                style={{
                                                    marginTop: '0.5rem', background: '#fff',
                                                    color: hasRated ? '#10b981' : '#f59e0b',
                                                    border: `1px solid ${hasRated ? '#10b981' : '#f59e0b'}`,
                                                    padding: '4px 12px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                                                    display: 'flex', alignItems: 'center', gap: '4px'
                                                }}
                                            >
                                                {hasRated ? '✓ Rating Submitted' : '⭐ Rate your partner'}
                                            </button>
                                        );
                                    })()}
                                </div>
                            );
                        }

                        const isMe = msg.authorPubkey === identity.publicKey;
                        const readByPeer = isMe && !!activeConv?.peerLastReadAt &&
                            new Date(msg.timestamp).getTime() <= new Date(activeConv.peerLastReadAt).getTime();
                        return (
                            <div
                                key={msg.id}
                                id={`msg-${msg.id}`}
                                style={{
                                    alignSelf: isMe ? 'flex-end' : 'flex-start',
                                    maxWidth: '80%',
                                }}
                            >
                                {!isMe && activeConv.type === 'group' && (
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>
                                        {members.find(m => m.publicKey === msg.authorPubkey)?.callsign
                                            || msg.authorPubkey.substring(0, 8)}
                                    </div>
                                )}
                                <div style={{
                                    background: isMe ? 'var(--accent)' : 'var(--bg-card)',
                                    color: isMe ? '#fff' : 'var(--text-primary)',
                                    borderRadius: isMe
                                        ? '12px 12px 4px 12px'
                                        : '12px 12px 12px 4px',
                                    padding: '0.35rem 0.6rem',
                                    fontSize: '0.95rem',
                                    lineHeight: 1.3,
                                    border: isMe ? 'none' : '1px solid var(--border-primary)',
                                    wordBreak: 'break-word',
                                }}>
                                    {(() => {
                                        let metaObj: any = null;
                                        try {
                                            if (msg.metadata) metaObj = JSON.parse(msg.metadata);
                                        } catch {}
                                        
                                        if (metaObj && metaObj.replyToId) {
                                            const parentMsg = messages.find(m => m.id === metaObj.replyToId);
                                            const parentText = parentMsg ? (parentMsg.type === 'image' ? '🔒 Photo' : decryptMessage(parentMsg)) : 'Message not found';
                                            const parentAuthor = parentMsg 
                                                ? (members.find(m => m.publicKey === parentMsg.authorPubkey)?.callsign 
                                                   || (parentMsg.authorPubkey === identity.publicKey ? 'You' : parentMsg.authorPubkey.substring(0, 8))) 
                                                : 'Someone';
                                            return (
                                                <div 
                                                    style={{
                                                        background: isMe ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.04)',
                                                        borderLeft: `3px solid ${isMe ? '#fff' : 'var(--accent)'}`,
                                                        padding: '4px 8px',
                                                        borderRadius: '4px',
                                                        marginBottom: '6px',
                                                        fontSize: '0.8rem',
                                                        opacity: 0.85,
                                                        cursor: 'pointer',
                                                    }} 
                                                    onClick={() => {
                                                        const el = document.getElementById(`msg-${metaObj.replyToId}`);
                                                        if (el) {
                                                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                                            el.style.transition = 'background-color 0.5s';
                                                            const origBg = el.style.backgroundColor;
                                                            el.style.backgroundColor = 'var(--bg-hover)';
                                                            setTimeout(() => { el.style.backgroundColor = origBg; }, 1500);
                                                        }
                                                    }}
                                                >
                                                    <div style={{ fontWeight: 700, fontSize: '0.75rem', color: isMe ? '#fff' : 'var(--accent)', marginBottom: '2px' }}>
                                                        {parentAuthor}
                                                    </div>
                                                    <div style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '280px' }}>
                                                        {parentText}
                                                    </div>
                                                </div>
                                            );
                                        }
                                        return null;
                                    })()}
                                    <div style={{ display: 'inline' }}>
                                        {msg.type === 'image' ? (() => {
                                            const ctx = dmCtxFor(activeConv);
                                            if (!ctx) return <span style={{ fontStyle: 'italic', opacity: 0.7 }}>🔒 Image</span>;
                                            let originalConversationId: string | undefined = undefined;
                                            let originalConversationIds: string[] | undefined = undefined;
                                            if (msg.metadata) {
                                                try {
                                                    const meta = JSON.parse(msg.metadata);
                                                    if (meta) {
                                                        if (meta.originalConversationId) {
                                                            originalConversationId = meta.originalConversationId;
                                                        }
                                                        if (Array.isArray(meta.originalConversationIds)) {
                                                            originalConversationIds = meta.originalConversationIds;
                                                        }
                                                    }
                                                } catch (e) {}
                                            }
                                            return <ChatImageBubble 
                                                messageId={msg.id} 
                                                conversationId={ctx.conversationId} 
                                                peerPubHex={ctx.peerEdPubHex} 
                                                myPrivHex={ctx.myEdPrivHex} 
                                                originalConversationId={originalConversationId}
                                                originalConversationIds={originalConversationIds}
                                            />;
                                        })() : decryptMessage(msg)}
                                    </div>
                                    <span style={{
                                        float: 'right',
                                        fontSize: '0.65rem',
                                        color: isMe ? 'rgba(255, 255, 255, 0.7)' : 'var(--text-faint)',
                                        marginLeft: '8px',
                                        marginTop: '4px',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '2px',
                                        userSelect: 'none',
                                        verticalAlign: 'bottom',
                                    }}>
                                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        {isMe && (
                                            <span style={{ marginLeft: '2px', color: readByPeer ? '#38bdf8' : 'rgba(255, 255, 255, 0.5)' }}>
                                                {readByPeer ? '✓✓' : '✓'}
                                            </span>
                                        )}
                                        <span
                                            onClick={(e) => { e.stopPropagation(); setReplyToMessage(msg); }}
                                            style={{
                                                marginLeft: '6px',
                                                cursor: 'pointer',
                                                color: isMe ? '#a5f3fc' : 'var(--accent)',
                                                fontWeight: 600
                                            }}
                                        >
                                            Reply
                                        </span>
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                    <div ref={messagesEndRef} />
                </div>

                {/* Reply Preview */}
                {replyToMessage && (
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.5rem 1rem', background: 'var(--bg-secondary)',
                        borderTop: '1px solid var(--border-primary)',
                        fontSize: '0.85rem', color: 'var(--text-secondary)'
                    }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', borderLeft: '3px solid var(--accent)', paddingLeft: '8px' }}>
                            <div style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--accent)' }}>
                                Replying to {replyToMessage.authorPubkey === identity.publicKey ? 'You' : (members.find(m => m.publicKey === replyToMessage.authorPubkey)?.callsign || 'Someone')}
                            </div>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '300px' }}>
                                {replyToMessage.type === 'image' ? '🔒 Photo' : decryptMessage(replyToMessage)}
                            </div>
                        </div>
                        <button
                            onClick={() => setReplyToMessage(null)}
                            aria-label="Cancel reply"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', padding: '4px' }}
                        >
                            ✕
                        </button>
                    </div>
                )}

                {/* Send bar */}
                <div style={{
                    display: 'flex', gap: '0.5rem',
                    padding: '0.5rem 1rem',
                    alignItems: 'center',
                    borderTop: '1px solid var(--border-primary)',
                    background: 'var(--bg-secondary)',
                }}>
                    {activeConv.type === 'dm' && (
                        <label title="Send photo" style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: '40px', height: '40px', borderRadius: '50%',
                            fontSize: '1.2rem',
                            cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.5 : 1,
                            flexShrink: 0,
                            background: 'transparent',
                        }}>
                            📎
                            <input
                                type="file"
                                accept="image/*"
                                disabled={sending}
                                style={{ display: 'none' }}
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSendImage(f); e.target.value = ''; }}
                            />
                        </label>
                    )}
                    <input
                        type="text"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                        placeholder="Message..."
                        disabled={sending}
                        style={inputStyle}
                    />
                    <button
                        onClick={handleSend}
                        disabled={sending || !draft.trim()}
                        style={{
                            height: '40px',
                            width: '40px',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: 'none',
                            background: draft.trim() ? 'var(--accent)' : 'var(--bg-hover)',
                            color: draft.trim() ? '#fff' : 'var(--text-muted)',
                            fontSize: '1.2rem',
                            cursor: draft.trim() ? 'pointer' : 'default',
                            fontFamily: 'inherit',
                            flexShrink: 0,
                            padding: 0,
                        }}
                    >
                        {sending ? '…' : '↑'}
                    </button>
                </div>
            </div>
        );
    }

    // Conversations list
    return (
        <div style={{ padding: '1rem', maxWidth: '500px', margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 style={{ fontSize: '1.3rem', margin: 0 }}>💬 Messages</h2>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                        onClick={() => { setShowNewDm(true); loadMembers(); }}
                        style={{
                            padding: '0.4rem 0.75rem', borderRadius: '8px',
                            border: '1px solid var(--border-input)', background: 'var(--bg-hover)',
                            color: 'var(--text-primary)', fontSize: '0.8rem', cursor: 'pointer',
                            fontFamily: 'inherit',
                        }}
                    >
                        ✉️ New DM
                    </button>
                    <button
                        onClick={() => { setShowNewGroup(true); loadMembers(); }}
                        style={{
                            padding: '0.4rem 0.75rem', borderRadius: '8px',
                            border: '1px solid var(--border-input)', background: 'var(--bg-hover)',
                            color: 'var(--text-primary)', fontSize: '0.8rem', cursor: 'pointer',
                            fontFamily: 'inherit',
                        }}
                    >
                        👥 Group
                    </button>
                </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid var(--border-primary)', paddingBottom: '1rem', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <button
                    onClick={() => setActiveTab('all')}
                    style={{ whiteSpace: 'nowrap', background: activeTab === 'all' ? 'var(--text-primary)' : 'var(--bg-hover)', color: activeTab === 'all' ? 'var(--bg-primary)' : 'var(--text-primary)', border: 'none', padding: '0.5rem 1.25rem', borderRadius: '20px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                >All</button>
                <button
                    onClick={() => setActiveTab('transactions')}
                    style={{ whiteSpace: 'nowrap', background: activeTab === 'transactions' ? 'var(--text-primary)' : 'var(--bg-hover)', color: activeTab === 'transactions' ? 'var(--bg-primary)' : 'var(--text-primary)', border: 'none', padding: '0.5rem 1.25rem', borderRadius: '20px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                >Transactions</button>
                <button
                    onClick={() => setActiveTab('direct')}
                    style={{ whiteSpace: 'nowrap', background: activeTab === 'direct' ? 'var(--text-primary)' : 'var(--bg-hover)', color: activeTab === 'direct' ? 'var(--bg-primary)' : 'var(--text-primary)', border: 'none', padding: '0.5rem 1.25rem', borderRadius: '20px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                >Direct</button>
            </div>

            {conversations.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-faint)' }}>
                    <p style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>💬</p>
                    <p>No conversations yet.</p>
                    <p style={{ fontSize: '0.85rem' }}>Start by sending a DM or creating a group.</p>
                </div>
            ) : (
                <div className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden">
                    {conversations
                        .filter(c => (c.unreadCount || 0) > 0 || c.createdAt) // show all (filtering empty convs happens server-side)
                        .filter(c => {
                            if (activeTab === 'transactions') return !!c.postId;
                            if (activeTab === 'direct') return !c.postId;
                            return true;
                        })
                        .sort((a, b) => {
                            // Transactions Tab sorting priority
                            if (activeTab === 'transactions') {
                                const isAActive = ['active', 'pending'].includes(a.postStatus || '');
                                const isBActive = ['active', 'pending'].includes(b.postStatus || '');
                                if (isAActive && !isBActive) return -1;
                                if (!isAActive && isBActive) return 1;
                            }
                            
                            // Default Unread & Date sorting priority
                            const aUnread = a.unreadCount || 0;
                            const bUnread = b.unreadCount || 0;
                            if (aUnread > 0 && bUnread === 0) return -1;
                            if (bUnread > 0 && aUnread === 0) return 1;
                            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                        })
                        .map(conv => {
                            const relatedTx = userTransactions.find(t => t.postId === conv.postId && t.status === 'completed');
                            const isBuyer = relatedTx ? relatedTx.buyerPublicKey === identity.publicKey : false;
                            const hasRated = relatedTx ? (isBuyer ? relatedTx.ratedByBuyer : relatedTx.ratedBySeller) : false;
                            const needsReview = conv.lastMsgType === 'system' && conv.lastSysType === 'ESCROW_RELEASED' && !hasRated;
                            
                            return (
                            <div
                                key={conv.id}
                                onClick={() => { setActiveConv(conv); loadMembers(); }}
                                className={`p-3 px-4 flex items-center gap-3 cursor-pointer transition-colors hover:bg-oat-50/50 dark:hover:bg-nature-800/30 ${
                                    needsReview ? 'bg-amber-50/40 dark:bg-amber-950/10 border-l-4 border-amber-500 pl-3' : ''
                                }`}
                            >
                                {conv.postId ? (
                                    <div style={{
                                        width: '44px', height: '44px', borderRadius: '12px',
                                        overflow: 'hidden', flexShrink: 0, position: 'relative',
                                        background: '#d1fae5', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    }}>
                                        {conv.postPhoto ? (
                                            <img src={conv.postPhoto} alt="" style={{
                                                width: '44px', height: '44px', objectFit: 'cover', borderRadius: '12px',
                                            }} />
                                        ) : (
                                            <span style={{ fontSize: '1.3rem' }}>🛍️</span>
                                        )}
                                        {/* Peer profile overlay */}
                                        <div style={{
                                            position: 'absolute', bottom: '-3px', right: '-3px',
                                            width: '22px', height: '22px', borderRadius: '50%',
                                            border: '2px solid var(--bg-primary)', overflow: 'hidden',
                                        }}>
                                            {renderAvatar(conv.peerAvatar, getConversationTitle(conv), 22)}
                                        </div>
                                        {(conv.unreadCount || 0) > 0 && (
                                            <span style={{
                                                position: 'absolute', top: '-4px', left: '-4px',
                                                background: 'var(--danger)', color: '#fff', fontSize: '0.6rem', fontWeight: 700,
                                                minWidth: '16px', height: '16px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                padding: '0 3px', lineHeight: 1, boxShadow: '0 0 6px var(--danger)',
                                            }}>{conv.unreadCount! > 99 ? '99+' : conv.unreadCount}</span>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ position: 'relative', flexShrink: 0 }}>
                                        {conv.type === 'group' ? (
                                            <div style={{
                                                width: '44px', height: '44px', borderRadius: '50%',
                                                background: 'var(--bg-card)', border: '1px solid var(--border-primary)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: '1.1rem',
                                            }}>
                                                👥
                                            </div>
                                        ) : (
                                            renderAvatar(conv.peerAvatar, getConversationTitle(conv), 44)
                                        )}
                                        {(conv.unreadCount || 0) > 0 && (
                                            <span style={{
                                                position: 'absolute', top: '-4px', right: '-4px',
                                                background: 'var(--danger)', color: '#fff', fontSize: '0.6rem', fontWeight: 700,
                                                minWidth: '16px', height: '16px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                padding: '0 3px', lineHeight: 1, boxShadow: '0 0 6px var(--danger)',
                                            }}>{conv.unreadCount! > 99 ? '99+' : conv.unreadCount}</span>
                                        )}
                                    </div>
                                )}
    
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: (conv.unreadCount || 0) > 0 ? 700 : 600, fontSize: '0.95rem' }}>
                                        {getConversationTitle(conv)}
                                    </div>
                                    {conv.postTitle && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.15rem' }}>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {conv.postTitle}
                                            </div>
                                            {conv.postStatus && (
                                                <div style={{
                                                    padding: '2px 6px', borderRadius: '4px', fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.5px',
                                                    background: conv.postStatus === 'active' ? '#dbeafe' : conv.postStatus === 'pending' ? '#d1fae5' : '#f3f4f6',
                                                    color: conv.postStatus === 'active' ? '#1d4ed8' : conv.postStatus === 'pending' ? '#047857' : '#4b5563',
                                                }}>
                                                    {conv.postStatus === 'pending' ? 'HELD IN TRUST' : conv.postStatus.toUpperCase()}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {!conv.postTitle && (
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {conv.type === 'group' ? `${conv.participants.length} members` : new Date(conv.createdAt).toLocaleDateString()}
                                        </div>
                                    )}
                                    
                                    {needsReview && (
                                        <div style={{ fontSize: '0.75rem', color: '#d97706', fontWeight: 700, marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                            <span style={{ fontSize: '0.8rem' }}>⭐</span> Action Needed: Review Partner
                                        </div>
                                    )}
                                </div>
                            </div>
                            );
                        })}
                </div>
            )}
        </div>
    );
}
