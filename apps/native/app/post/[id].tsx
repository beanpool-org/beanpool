import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Image, Pressable, ScrollView, TextInput, Alert, Keyboard } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Picker } from '@react-native-picker/picker';
import * as Crypto from 'expo-crypto';
import { 
    getPost, updatePost, deletePost, 
    requestMarketplacePost, approveMarketplaceRequest, rejectMarketplaceRequest, cancelMarketplaceRequest,
    acceptMarketplacePost, completeMarketplaceTransaction, cancelMarketplaceTransaction,
    submitRating, reportAbuse, getDb, getMemberRatings, createConversationApi, getUnreadCountForPost, getBalance
} from '../../utils/db';
import { useIdentity } from '../IdentityContext';
import { loadIdentity } from '../../utils/identity';
import { ReviewModal } from '../../components/ReviewModal';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { MemberAvatar } from '../../components/MemberAvatar';
import { PhotoCarousel } from '../../components/PhotoCarousel';
import { POST_CATEGORIES, categoryEmoji, categoryLabel } from '../../constants/categories';
import { hapticSuccess, hapticWarning, hapticTick } from '../../utils/haptics';
import { colors, palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';

// Turn a server trade-gate rejection into a friendly title + message. The covenant / contribution
// / holiday gates carry a stable "PREFIX: <human text>" so we can give them a helpful heading.
function explainTradeError(e: any): { title: string; message: string } {
    const raw = String(e?.message || e || 'Something went wrong');
    if (raw.startsWith('COVENANT_REQUIRED')) {
        return { title: '🎣 Post an Offer first', message: 'To spend on community credit (take your balance negative) you need at least one active Offer posted — a line in the water so others can trade with you in return. Post an Offer, then try again.' };
    }
    if (raw.startsWith('CONTRIBUTION_REQUIRED')) {
        return { title: 'List an Offer first', message: 'List at least one Offer of your own before you can request or accept from others.' };
    }
    if (raw.startsWith('HOLIDAY_MODE')) {
        return { title: '🌴 Holiday mode is on', message: 'Turn off holiday mode in Settings before trading.' };
    }
    return { title: 'Error', message: raw.replace(/^[A-Z_]+:\s*/, '') };
}

export default function PostDetailModal() {
    const insets = useSafeAreaInsets();
    const { theme, colors } = useTheme();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: colors.surface.app },
        errorText: { color: colors.text.secondary, fontSize: 16, textAlign: 'center', marginBottom: 24, lineHeight: 24 },
        closeBtn: { backgroundColor: palette.orangeAlt500, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12 },
        closeBtnText: { color: colors.text.inverse, fontWeight: 'bold' },

        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle },
        backButton: { flexDirection: 'row', width: 68, height: 40, alignItems: 'center' },
        backText: { color: colors.text.body, fontSize: 24, marginTop: -2 },
        headerTitle: { fontSize: 18, fontWeight: 'bold', color: colors.text.body, letterSpacing: 1, textTransform: 'uppercase' },

        scroll: { paddingBottom: 60 },

        // Type Badge
        typeBadgeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 4 },
        catBadge: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
        catEmoji: { fontSize: 20 },
        catLabel: { flexShrink: 1, fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },
        timeAgo: { color: colors.text.muted, fontSize: 12, fontWeight: '600', flexShrink: 0, marginLeft: 8 },

        // Title & Description
        postTitle: { color: colors.text.body, fontSize: 24, fontWeight: '800', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
        description: { color: colors.text.secondary, fontSize: 15, lineHeight: 22, paddingHorizontal: 20, paddingBottom: 16 },

        // Photos
        carouselWrap: { marginHorizontal: 20, marginBottom: 16 },

        // Price Card
        priceCard: { marginHorizontal: 20, backgroundColor: colors.surface.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default, paddingVertical: 20, alignItems: 'center', marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
        priceLabel: { color: colors.text.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
        priceValue: { color: colors.text.body, fontSize: 36, fontWeight: '800' },
        priceCurrency: { fontSize: 20, fontWeight: '500', color: colors.text.secondary },

        // Author Card
        authorCard: { marginHorizontal: 20, backgroundColor: colors.surface.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default, padding: 16, marginBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
        authorCardLabel: { color: colors.text.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 12 },
        authorRow: { flexDirection: 'row', alignItems: 'center' },
        avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme === 'dark' ? 'rgba(217,119,87,0.2)' : 'rgba(217,119,87,0.1)', justifyContent: 'center', alignItems: 'center' },
        avatarLetter: { color: palette.orangeAlt500, fontSize: 20, fontWeight: 'bold' },
        authorInfo: { marginLeft: 12 },
        authorName: { color: colors.text.body, fontSize: 16, fontWeight: '700' },
        authorRating: { color: colors.text.secondary, fontSize: 12, marginTop: 2 },

        // Own Post Actions
        ownPostActions: { paddingHorizontal: 20, gap: 10 },
        editPostBtn: { backgroundColor: palette.orangeAlt500, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
        editPostBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800' },
        deletePostBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 2, borderColor: colors.feedback.danger.border },
        deletePostBtnText: { color: colors.feedback.danger.solid, fontSize: 14, fontWeight: '700' },

        // Other's Post Actions
        otherPostActions: { paddingHorizontal: 20, gap: 10 },
        messageBtn: { backgroundColor: colors.surface.card, borderRadius: 14, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: colors.border.default },
        messageBtnText: { color: colors.text.body, fontSize: 16, fontWeight: '700' },
        acceptBtn: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
        acceptBtnOffer: { backgroundColor: colors.brand.primary },
        acceptBtnNeed: { backgroundColor: palette.orange600 },
        acceptBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800' },

        // Edit Section
        editSection: { marginHorizontal: 20, backgroundColor: colors.surface.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default, padding: 16 },
        editSectionTitle: { color: colors.text.body, fontSize: 18, fontWeight: '800', marginBottom: 16 },
        editTypeRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        editTypeBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app, alignItems: 'center' },
        editTypeBtnOffer: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
        editTypeBtnNeed: { backgroundColor: palette.orange600, borderColor: palette.orange600 },
        editTypeBtnText: { fontSize: 14, fontWeight: '800', color: colors.text.muted },
        editTypeBtnTextActive: { color: colors.text.inverse },
        editPickerWrap: { backgroundColor: colors.surface.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 10, overflow: 'hidden' },
        editPicker: { color: colors.text.body, height: 50 },
        editInput: { backgroundColor: colors.surface.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 14, paddingVertical: 12, color: colors.text.body, fontSize: 15, marginBottom: 10 },
        editPhotoLabel: { color: colors.text.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
        editPhotosRow: { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
        editPhotoThumb: { width: 60, height: 60, borderRadius: 12, overflow: 'hidden', position: 'relative' },
        editPhotoImg: { width: 60, height: 60, borderRadius: 12 },
        editPhotoRemove: { position: 'absolute', top: -2, right: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.feedback.danger.solid, justifyContent: 'center', alignItems: 'center' },
        editPhotoRemoveText: { color: colors.text.inverse, fontSize: 10, fontWeight: '800' },
        editPhotoAdd: { width: 60, height: 60, borderRadius: 12, borderWidth: 2, borderStyle: 'dashed', borderColor: colors.border.strong, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.app },
        editPhotoAddIcon: { color: colors.text.muted, fontSize: 26 },
        editBtnRow: { flexDirection: 'row', gap: 10 },
        editCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center' },
        editCancelBtnText: { color: colors.text.secondary, fontSize: 15, fontWeight: '700' },
        editSaveBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: palette.orangeAlt500, alignItems: 'center' },
        editSaveBtnDisabled: { backgroundColor: colors.border.strong },
        editSaveBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800' },

        // Transaction Logic Components
        confirmBox: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, marginTop: 8, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
        confirmBoxTitle: { color: colors.text.body, fontSize: 15, fontWeight: '800', textAlign: 'center', marginBottom: 12 },
        confirmBoxLabel: { color: colors.text.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 6 },
        confirmBoxInput: { backgroundColor: colors.surface.app, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 16, paddingVertical: 14, color: colors.text.body, fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
        cancelActionBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        cancelActionBtnText: { color: colors.text.secondary, fontSize: 14, fontWeight: '700' },
        confirmActionBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
        confirmActionBtnGreen: { backgroundColor: colors.brand.primary },
        confirmActionBtnText: { color: colors.text.inverse, fontSize: 14, fontWeight: '800' },
        cancelTxBtn: { marginTop: 12, borderWidth: 1, borderColor: colors.feedback.danger.border, backgroundColor: colors.surface.card, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
        cancelTxBtnText: { color: colors.feedback.danger.solid, fontSize: 14, fontWeight: '700' },
        requestsContainer: {
            marginTop: 20,
            backgroundColor: colors.surface.card,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: colors.border.default
        },
        requestsTitle: {
            color: colors.text.body,
            fontSize: 16,
            fontWeight: 'bold',
            marginBottom: 12
        },
        requestCard: {
            flexDirection: 'column',
            backgroundColor: colors.surface.app,
            borderWidth: 1,
            borderColor: colors.surface.subtle,
            borderRadius: 8,
            padding: 12,
            marginBottom: 8
        },
        requestName: {
            color: colors.text.body,
            fontWeight: '600',
            fontSize: 14,
            marginBottom: 4
        },
        requestAmt: {
            color: colors.brand.primary,
            fontSize: 12,
            fontWeight: '700'
        },
        approveBtn: {
            backgroundColor: colors.brand.primary,
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderRadius: 6
        },
        approveBtnText: {
            color: colors.text.inverse,
            fontSize: 13,
            fontWeight: 'bold'
        },
        rejectBtn: {
            backgroundColor: colors.surface.card,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: colors.feedback.danger.border
        },
        rejectBtnText: {
            color: colors.feedback.danger.solid,
            fontSize: 13,
            fontWeight: 'bold'
        },
        reqMessageBtn: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.strong,
            borderRadius: 16,
            paddingHorizontal: 12,
            paddingVertical: 6,
        },
        reqMessageBtnText: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: '700',
        },
        modalOverlay: {
            flex: 1,
            backgroundColor: colors.overlay.imageViewerCloseBg,
            justifyContent: 'center',
            padding: 20,
        },
        modalContent: {
            backgroundColor: colors.surface.card,
            borderRadius: 20,
            padding: 24,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 10 },
            shadowOpacity: 0.15,
            shadowRadius: 20,
            elevation: 10,
        },
        modalTitle: {
            fontSize: 20,
            fontWeight: '900',
            color: colors.text.body,
            marginBottom: 8,
            textAlign: 'center',
        },
        modalSubtext: {
            fontSize: 14,
            color: colors.text.secondary,
            marginBottom: 20,
            textAlign: 'center',
        },
        unreadBadge: {
            backgroundColor: colors.feedback.danger.solid,
            borderRadius: 12,
            paddingHorizontal: 8,
            paddingVertical: 2,
            marginLeft: 8,
            justifyContent: 'center',
            alignItems: 'center',
        },
        unreadBadgeText: {
            color: colors.text.inverse,
            fontSize: 12,
            fontWeight: 'bold',
        },
        unreadBadgeSmall: {
            backgroundColor: colors.feedback.danger.solid,
            borderRadius: 10,
            width: 18,
            height: 18,
            position: 'absolute',
            top: -6,
            right: -6,
            justifyContent: 'center',
            alignItems: 'center',
        },
        unreadBadgeTextSmall: {
            color: colors.text.inverse,
            fontSize: 10,
            fontWeight: 'bold',
        }
    }));

    const { id, txId } = useLocalSearchParams();
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    useEffect(() => {
        const showSub = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
        const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
        return () => { showSub.remove(); hideSub.remove(); };
    }, []);
    const { identity } = useIdentity();
    const [activeTx, setActiveTx] = useState<any>(null);
    const [post, setPost] = useState<any>(null);
    const [editMode, setEditMode] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Edit form state
    const [editType, setEditType] = useState<'offer' | 'need'>('offer');
    const [editCategory, setEditCategory] = useState('general');
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editCredits, setEditCredits] = useState('');
    const [editPriceType, setEditPriceType] = useState<string>('fixed');
    const [editRepeatable, setEditRepeatable] = useState(false);
    const [editPhotos, setEditPhotos] = useState<string[]>([]);

    // Transactions / Reporting state
    const [accepting, setAccepting] = useState(false);
    const [showAcceptConfirm, setShowAcceptConfirm] = useState(false);
    // Contribution-first gate: accepting an Offer requires having listed one.
    const [blockedFromTrading, setBlockedFromTrading] = useState(false);
    const [showContributionRequired, setShowContributionRequired] = useState(false);
    const [acceptHours, setAcceptHours] = useState('1');
    const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
    const [completeHours, setCompleteHours] = useState('');
    const [showRatingForm, setShowRatingForm] = useState(false);
    const [myRating, setMyRating] = useState(0);
    const [ratingComment, setRatingComment] = useState('');
    const [submittingRating, setSubmittingRating] = useState(false);
    const [hasExistingRating, setHasExistingRating] = useState(false);
    const [showReportForm, setShowReportForm] = useState(false);
    const [reportReason, setReportReason] = useState('');
    const [submittingReport, setSubmittingReport] = useState(false);
    const [promptReviewForTx, setPromptReviewForTx] = useState<{ txId: string; targetPubkey: string; targetCallsign: string } | null>(null);

    // Request Rejection Modal State
    const [rejectModalTxId, setRejectModalTxId] = useState<string | null>(null);
    const [rejectMessage, setRejectMessage] = useState('');

    const [requests, setRequests] = useState<any[]>([]);

    const [authorAvgRating, setAuthorAvgRating] = useState<number | null>(null);
    const [authorRatingCount, setAuthorRatingCount] = useState<number>(0);

    const [targetPeerAvgRating, setTargetPeerAvgRating] = useState<number | null>(null);
    const [targetPeerRatingCount, setTargetPeerRatingCount] = useState<number>(0);

    const [unreadCount, setUnreadCount] = useState<number>(0);
    const [reqUnreadCounts, setReqUnreadCounts] = useState<Record<string, number>>({});

    useFocusEffect(
        useCallback(() => {
            if (id) { 
                const singleId = Array.isArray(id) ? id[0] : id;
                const singleTxId = Array.isArray(txId) ? txId[0] : txId;
                const reload = async () => {
                    getPost(singleId).then(setPost);
                    
                    let activeIdentity = identity;
                    if (!activeIdentity) {
                        try {
                            const idData = await loadIdentity();
                            if (idData) activeIdentity = idData;
                        } catch (e) {
                            console.warn('[Post Detail] Failed to preload identity from Secure Store:', e);
                        }
                    }

                    const database = await getDb();
                    const updateActiveTx = async (tx: any) => {
                        setActiveTx(tx);
                        // Ensure unread badge instantly updates when sync_data_updated triggers reload
                        if (tx && activeIdentity?.publicKey) {
                            const postRow = await getPost(singleId);
                            const isPayerLocal = tx.buyer_pubkey === activeIdentity.publicKey;
                            const isOwn = activeIdentity.publicKey === postRow?.author_pubkey;
                            const tPubkey = isPayerLocal ? tx.seller_pubkey : tx.buyer_pubkey;
                            
                            getUnreadCountForPost(singleId, activeIdentity.publicKey, tPubkey)
                                .then(setUnreadCount)
                                .catch(console.error);
                        }
                    };

                    if (singleTxId) {
                        database.getFirstAsync(`
                            SELECT t.*, m.callsign as buyer_callsign, m.avatar_url as buyer_avatar, s.callsign as seller_callsign, s.avatar_url as seller_avatar 
                            FROM marketplace_transactions t 
                            LEFT JOIN members m ON t.buyer_pubkey = m.public_key 
                            LEFT JOIN members s ON t.seller_pubkey = s.public_key 
                            WHERE t.id = ?
                        `, [singleTxId]).then(updateActiveTx);
                    } else if (activeIdentity) {
                        database.getFirstAsync(`
                            SELECT t.*, m.callsign as buyer_callsign, m.avatar_url as buyer_avatar, s.callsign as seller_callsign, s.avatar_url as seller_avatar 
                            FROM marketplace_transactions t 
                            LEFT JOIN members m ON t.buyer_pubkey = m.public_key 
                            LEFT JOIN members s ON t.seller_pubkey = s.public_key 
                            WHERE t.post_id=? AND t.status='pending' AND (t.buyer_pubkey=? OR t.seller_pubkey=?) ORDER BY t.created_at DESC LIMIT 1
                        `, [singleId, activeIdentity.publicKey, activeIdentity.publicKey]).then(updateActiveTx);
                    }

                    database.getAllAsync(`
                        SELECT t.*, m.callsign as buyer_callsign, m.avatar_url as buyer_avatar, s.callsign as seller_callsign, s.avatar_url as seller_avatar 
                        FROM marketplace_transactions t 
                        LEFT JOIN members m ON t.buyer_pubkey = m.public_key LEFT JOIN members s ON t.seller_pubkey = s.public_key 
                        WHERE t.post_id=? AND t.status='requested'
                    `, [singleId])
                        .then(async (res: any[]) => {
                            const currentPost = await getPost(singleId);
                            const postType = currentPost?.type || 'offer';
                            // Some older local rows might have null seller_pubkey even for needs. Fallback to buyer_pubkey.
                            const resolved = res.map(req => ({
                                req,
                                reqPubkey: (postType === 'need' && req.seller_pubkey) ? req.seller_pubkey : req.buyer_pubkey,
                            }));
                            // ⚡ One grouped read of the locally-synced ratings table instead of a
                            // per-request getMemberRatings() network call (that was an N+1 that
                            // stampeded the node + DB lock on every sync tick).
                            const ratingByPubkey = new Map<string, { average: number; count: number }>();
                            const distinctPubkeys = [...new Set(resolved.map(r => r.reqPubkey).filter(Boolean))];
                            if (distinctPubkeys.length > 0) {
                                const placeholders = distinctPubkeys.map(() => '?').join(',');
                                const ratingRows = await database.getAllAsync<any>(
                                    `SELECT target_pubkey, COUNT(*) as count, AVG(stars) as average FROM ratings WHERE target_pubkey IN (${placeholders}) GROUP BY target_pubkey`,
                                    distinctPubkeys
                                );
                                for (const rr of ratingRows) ratingByPubkey.set(rr.target_pubkey, { average: rr.average || 0, count: rr.count || 0 });
                            }
                            const enriched = resolved.map(({ req, reqPubkey }) => {
                                const r = ratingByPubkey.get(reqPubkey) || { average: 0, count: 0 };
                                return { ...req, avgRating: r.average, count: r.count, resolvedReqPubkey: reqPubkey };
                            });
                            setRequests(enriched);
                            
                            // Fetch unread counts for requests
                            if (activeIdentity) {
                                const counts: Record<string, number> = {};
                                for (const req of enriched) {
                                    if (req.resolvedReqPubkey) {
                                        counts[req.id] = await getUnreadCountForPost(singleId, activeIdentity.publicKey, req.resolvedReqPubkey);
                                    }
                                }
                                setReqUnreadCounts(counts);
                            }
                        });
                };
                reload();
                
                const { DeviceEventEmitter } = require('react-native');
                const sub = DeviceEventEmitter.addListener('sync_data_updated', reload);
                return () => sub.remove();
            }
        }, [id, txId, identity])
    );

    useEffect(() => {
        if (post?.author_pubkey) {
            getMemberRatings(post.author_pubkey).then(res => {
                setAuthorAvgRating(res.average);
                setAuthorRatingCount(res.count);
            }).catch(console.error);
        }
    }, [post?.author_pubkey]);

    useEffect(() => {
        if (!post) return;
        const isOwn = identity?.publicKey === post?.author_pubkey;
        const isPayerLocal = activeTx ? activeTx.buyer_pubkey === identity?.publicKey : ((post?.type === 'offer' && !isOwn) || (post?.type === 'need' && isOwn));
        const tPubkey = activeTx ? (isPayerLocal ? activeTx.seller_pubkey : activeTx.buyer_pubkey) : (isOwn ? post?.accepted_by : post?.author_pubkey);

        if (tPubkey) {
            getMemberRatings(tPubkey).then(res => {
                setTargetPeerAvgRating(res.average);
                setTargetPeerRatingCount(res.count);
            }).catch(console.error);
        }
    }, [post, activeTx, identity?.publicKey]);

    useEffect(() => {
        const targetPeer = activeTx 
            ? (activeTx.buyer_pubkey === identity?.publicKey ? activeTx.seller_pubkey : activeTx.buyer_pubkey)
            : (identity?.publicKey === post?.author_pubkey ? post?.accepted_by : post?.author_pubkey);
            
        if (identity?.publicKey && post?.id && targetPeer) {
            getUnreadCountForPost(post.id, identity.publicKey, targetPeer)
                .then(setUnreadCount)
                .catch(console.error);
        }
    }, [identity?.publicKey, post?.id, activeTx]);

    useEffect(() => {
        const txToRate = activeTx?.id || post?.pending_transaction_id;
        if (txToRate && identity?.publicKey) {
            (async () => {
                try {
                    const db = await getDb();
                    const existing = await db.getFirstAsync<any>(
                        "SELECT stars, comment FROM ratings WHERE transaction_id=? AND rater_pubkey=?",
                        [txToRate, identity.publicKey]
                    );
                    if (existing) {
                        setMyRating(existing.stars);
                        setRatingComment(existing.comment || '');
                        setHasExistingRating(true);
                    } else {
                        setMyRating(0);
                        setRatingComment('');
                        setHasExistingRating(false);
                    }
                } catch (e) {
                    console.error("[PostDetails] Failed to load existing rating:", e);
                }
            })();
        }
    }, [activeTx?.id, post?.pending_transaction_id, identity?.publicKey]);

    // Track whether the viewer still needs to list an Offer (Gate 1).
    useEffect(() => {
        if (!identity?.publicKey) return;
        let cancelled = false;
        getBalance(identity.publicKey)
            .then(b => { if (!cancelled) setBlockedFromTrading(!!(b as any).isBlockedFromTrading); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [identity?.publicKey]);

    if (!post) {
        return (
            <View style={[styles.errorContainer, { paddingTop: insets.top }]}>
                <Text style={styles.errorText}>Post not found. It may have been expired by the Network.</Text>
                <Pressable accessibilityRole="button" onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); }} style={styles.closeBtn}>
                    <Text style={styles.closeBtnText}>Return to Market</Text>
                </Pressable>
            </View>
        );
    }

    const isOwnPost = identity?.publicKey === post.author_pubkey;
    
    // --- Escrow Roles ---
    const isAcceptedByMe = activeTx 
        ? (activeTx.buyer_pubkey === identity?.publicKey || activeTx.seller_pubkey === identity?.publicKey) && !isOwnPost
        : (identity?.publicKey === post.accepted_by);
    const isPayer = activeTx
        ? activeTx.buyer_pubkey === identity?.publicKey
        : ((post.type === 'offer' && isAcceptedByMe) || (post.type === 'need' && isOwnPost));
    const isPayee = activeTx
        ? activeTx.seller_pubkey === identity?.publicKey
        : ((post.type === 'offer' && isOwnPost) || (post.type === 'need' && isAcceptedByMe));
    const targetPeerCallsign = activeTx 
        ? (isPayer ? activeTx.seller_callsign || 'Peer' : activeTx.buyer_callsign || 'Peer')
        : (isOwnPost ? (post.accepted_by_callsign || 'Peer') : (post.author_callsign || post.author_pubkey?.slice(0, 6) || 'Unknown'));
    const targetPeerPubkey = activeTx
        ? (isPayer ? activeTx.seller_pubkey : activeTx.buyer_pubkey)
        : (isOwnPost ? post.accepted_by : post.author_pubkey);
    const targetPeerAvatar = activeTx 
        ? (isPayer ? activeTx.seller_avatar : activeTx.buyer_avatar)
        : (isOwnPost ? post.accepted_by_avatar : post.author_avatar);

    const isOffer = post.type === 'offer';
    const emoji = categoryEmoji(post.category);
    const cardAuthor = post.author_callsign || post.author_pubkey?.slice(0, 6) || 'Unknown';
    const priceLabel = isOffer ? 'ASKING PRICE' : 'WILLING TO PAY';

    let photos: string[] = [];
    if (post.photos) {
        try {
            const parsed = Array.isArray(post.photos) ? post.photos : JSON.parse(post.photos);
            photos = parsed.filter((p: any) => typeof p === 'string' && p.length > 0);
        } catch {}
    }

    const startEdit = () => {
        setEditType(post.type);
        setEditCategory(post.category);
        setEditTitle(post.title);
        setEditDescription(post.description || '');
        setEditCredits(String(post.credits));
        setEditPriceType(post.price_type || 'fixed');
        setEditRepeatable(!!post.repeatable);
        setEditPhotos(photos);
        setEditMode(true);
    };

    const handleSave = async () => {
        if (!editTitle.trim()) { Alert.alert('Error', 'Title is required'); return; }
        setSaving(true);
        try {
            await updatePost(post.id, {
                type: editType,
                category: editCategory,
                title: editTitle.trim(),
                description: editDescription.trim(),
                credits: Number(editCredits) || 0,
                price_type: editPriceType,
                repeatable: editRepeatable,
                photos: editPhotos.length > 0 ? JSON.stringify(editPhotos) : null,
            });
            // Refresh the post
            const updated = await getPost(post.id);
            setPost(updated);
            setEditMode(false);
        } catch (e) {
            Alert.alert('Error', 'Failed to save changes');
        }
        setSaving(false);
    };

    const handleDelete = () => {
        Alert.alert('Delete Post', 'Are you sure you want to delete this post?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: async () => {
                setDeleting(true);
                try {
                    await deletePost(post.id);
                    if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                } catch (e) {
                    Alert.alert('Error', 'Failed to delete post');
                    setDeleting(false);
                }
            }},
        ]);
    };

    const myRequest = requests.find(r => r.buyer_pubkey === identity?.publicKey || r.seller_pubkey === identity?.publicKey);

    const handleApprove = async (transactionId: string) => {
        if (!identity) return;
        setAccepting(true);
        try {
            await approveMarketplaceRequest(transactionId, identity.publicKey);
            const updated = await getPost(post.id);
            setPost(updated);
            hapticSuccess();
            Alert.alert('Approved', 'Funds locked in trust successfully.');
            
            // Route to chat with requester
            const req = requests.find(r => r.id === transactionId);
            const peerPubkey = req ? (post.type === 'need' ? req.seller_pubkey : req.buyer_pubkey) : null;
            if (peerPubkey) {
                try {
                    const conv = await createConversationApi('dm', [peerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                    if (conv) router.replace(`/chat/${conv.id}`);
                } catch (e) {
                    // Chat failed, fallback is normal UI refresh
                    console.error('Failed to create chat on approve', e);
                }
            }
        } catch (e: any) { hapticWarning(); Alert.alert('Error', e.message); }
        setAccepting(false);
    };

    const handleReject = (transactionId: string) => {
        setRejectMessage('');
        setRejectModalTxId(transactionId);
    };
    
    const confirmReject = async () => {
        if (!identity || !rejectModalTxId) return;
        setAccepting(true);
        try {
            const req = requests.find(r => r.id === rejectModalTxId);
            const peerPubkey = req ? (post.type === 'need' ? req.seller_pubkey : req.buyer_pubkey) : null;
            
            await rejectMarketplaceRequest(rejectModalTxId, identity.publicKey);
            
            // Optionally send the reject message if provided
            if (rejectMessage.trim() && peerPubkey) {
                try {
                    await createConversationApi('dm', [peerPubkey, identity.publicKey], identity.publicKey, rejectMessage.trim(), post.id);
                } catch (e) {
                    console.error('Failed to send rejection message', e);
                }
            }
            
            setRequests(prev => prev.filter(r => r.id !== rejectModalTxId));
            setRejectModalTxId(null);
            hapticSuccess();
        } catch (e: any) { Alert.alert('Error', e.message); }
        setAccepting(false);
    };

    const handleWithdraw = async () => {
        if (!identity || !myRequest) return;
        setAccepting(true);
        try {
            await cancelMarketplaceRequest(myRequest.id, identity.publicKey);
            setRequests(prev => prev.filter(r => r.id !== myRequest.id));
        } catch (e: any) { Alert.alert('Error', e.message); }
        setAccepting(false);
    };

    const pickEditPhoto = async () => {
        if (editPhotos.length >= 5) return;
        Alert.alert('Add Photo', 'Choose a source', [
            { text: 'Camera', onPress: async () => {
                try {
                    const perm = await ImagePicker.requestCameraPermissionsAsync();
                    if (!perm.granted) return;
                    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7, base64: false });
                    if (!result.canceled && result.assets[0].uri) {
                        const manipResult = await ImageManipulator.manipulateAsync(
                            result.assets[0].uri,
                            [{ resize: { width: 800 } }],
                            { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
                        );
                        if (manipResult.base64) {
                            setEditPhotos(prev => [...prev, `data:image/jpeg;base64,${manipResult.base64}`]);
                        }
                    }
                } catch (e: any) {
                    Alert.alert('Camera Unavailable', e?.message || 'Could not launch camera.');
                }
            }},
            { text: 'Gallery', onPress: async () => {
                const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, base64: false });
                if (!result.canceled && result.assets[0].uri) {
                    const manipResult = await ImageManipulator.manipulateAsync(
                        result.assets[0].uri,
                        [{ resize: { width: 800 } }],
                        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
                    );
                    if (manipResult.base64) {
                        setEditPhotos(prev => [...prev, `data:image/jpeg;base64,${manipResult.base64}`]);
                    }
                }
            }},
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={styles.header}>
                <Pressable accessibilityRole="button" onPress={goBack} style={styles.backButton}>
                    <Text style={styles.backText}>←</Text>
                    <Text style={{ color: colors.text.body, fontSize: 16, fontWeight: 'bold', marginLeft: 4 }}>Back</Text>
                </Pressable>
                <Text style={[styles.headerTitle, { flex: 1, textAlign: 'center' }]}>{isOffer ? 'Offer' : 'Need'}</Text>
                <View style={{ width: 68 }} />
            </View>

            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={64}>
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 60 : 60 }]} keyboardShouldPersistTaps="handled">
                {/* Type + Category Badge */}
                <View style={styles.typeBadgeRow}>
                    <View style={styles.catBadge}>
                        <Text style={styles.catEmoji}>{emoji}</Text>
                        <Text style={[styles.catLabel, { color: isOffer ? colors.brand.primary : palette.orange600 }]} numberOfLines={1}>
                            {isOffer ? '● ' : '● '}{post.type.toUpperCase()} · {categoryLabel(post.category).toUpperCase()}
                            {post.repeatable ? ' · RECURRING' : ''}
                        </Text>
                    </View>
                    <Text style={styles.timeAgo} numberOfLines={1}>{getTimeAgo(post.created_at)}</Text>
                </View>

                {/* Title */}
                <Text style={styles.postTitle}>{post.title}</Text>

                {/* Description */}
                <Text style={styles.description}>{post.description || 'No description provided.'}</Text>

                {/* Photos */}
                {photos.length > 0 && (
                    <View style={styles.carouselWrap}>
                        <PhotoCarousel photos={photos} />
                    </View>
                )}

                {/* Price Card */}
                <View style={styles.priceCard}>
                    <Text style={styles.priceLabel}>{priceLabel}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                        <CurrencyDisplay amount={post.credits} style={styles.priceValue} asView={true} />
                        <Text style={[styles.priceCurrency, { marginLeft: 2 }]}>{
                            { fixed: '', hourly: ' / Hr', daily: ' / Dy', weekly: ' / Wk', monthly: ' / Mo' }[post.price_type as string] || ''
                        }</Text>
                    </View>
                </View>

                {/* Author / Counterparty Card */}
                {isOwnPost && targetPeerPubkey ? (
                    <Pressable accessibilityRole="button" style={styles.authorCard} onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: targetPeerPubkey, callsign: targetPeerCallsign } })}>
                        <Text style={styles.authorCardLabel}>{isOffer ? 'ACCEPTED BY' : 'PROVIDER'}</Text>
                        <View style={styles.authorRow}>
                            <View style={styles.avatar}>
                                <MemberAvatar avatarUrl={targetPeerAvatar} pubkey={targetPeerPubkey} callsign={targetPeerCallsign} size={48} borderRadius={24} />
                            </View>
                            <View style={styles.authorInfo}>
                                <Text style={styles.authorName}>🤝 {targetPeerCallsign}</Text>
                                <Text style={styles.authorRating}>
                                    {targetPeerAvgRating !== null && targetPeerRatingCount > 0 ? (
                                        <>
                                            <Text style={{ color: palette.amber400, letterSpacing: -1 }}>{renderBeans(targetPeerAvgRating)}</Text>
                                            <Text> {`(${targetPeerAvgRating.toFixed(1)}) • ${targetPeerRatingCount} Reviews`}</Text>
                                        </>
                                    ) : (
                                        <Text>☆☆☆☆☆ No ratings yet</Text>
                                    )}
                                </Text>
                            </View>
                        </View>
                    </Pressable>
                ) : (
                    <Pressable accessibilityRole="button" style={styles.authorCard} onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: post.author_pubkey, callsign: cardAuthor } })}>
                        <Text style={styles.authorCardLabel}>POSTED BY</Text>
                        <View style={styles.authorRow}>
                            <View style={styles.avatar}>
                                <MemberAvatar avatarUrl={post.author_avatar} pubkey={post.author_pubkey} callsign={cardAuthor} size={48} borderRadius={24} />
                            </View>
                            <View style={styles.authorInfo}>
                                <Text style={styles.authorName}>🤝 {cardAuthor}</Text>
                                <Text style={styles.authorRating}>
                                    {authorAvgRating !== null && authorRatingCount > 0 ? (
                                        <>
                                            <Text style={{ color: palette.amber400, letterSpacing: -1 }}>{renderBeans(authorAvgRating)}</Text>
                                            <Text> {`(${authorAvgRating.toFixed(1)}) • ${authorRatingCount} Reviews`}</Text>
                                        </>
                                    ) : (
                                        <Text>☆☆☆☆☆ No ratings yet</Text>
                                    )}
                                </Text>
                            </View>
                        </View>
                    </Pressable>
                )}

                {/* Action Buttons */}

                {/* 1. Pending Escrow State (Applies to both Payer and Payee) */}
                {(post.status === 'pending' || activeTx?.status === 'pending') && (isPayer || isPayee) && (
                    <View style={styles.ownPostActions}>
                        {isPayer ? (
                            <>
                                <Text style={{ color: colors.brand.primary, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4 }}>
                                    ✅ Action Required: Release Credits
                                </Text>
                                <Text style={{ color: colors.text.secondary, fontSize: 11, textAlign: 'center', marginBottom: 12, paddingHorizontal: 16 }}>
                                    You are the Payer. Once {targetPeerCallsign} has fulfilled the terms, release the funds to complete the transaction.
                                </Text>
                                
                                {showCompleteConfirm ? (
                                    <View style={styles.confirmBox}>
                                        <Text style={styles.confirmBoxTitle}>Finalize Transaction</Text>
                                        {post.price_type !== 'fixed' && (
                                            <View style={{ marginBottom: 16 }}>
                                                <Text style={styles.confirmBoxLabel}>CONFIRM ACTUAL {
                                                    { hourly: 'HOURS', daily: 'DAYS', weekly: 'WEEKS', monthly: 'MONTHS' }[post.price_type as string] || 'UNITS'
                                                } WORKED</Text>
                                                <TextInput accessibilityLabel="Actual time worked" style={styles.confirmBoxInput} value={completeHours} onChangeText={setCompleteHours} keyboardType="numeric" placeholder="e.g. 2.5" placeholderTextColor={colors.text.muted} />
                                                <Text style={{ color: colors.text.secondary, fontSize: 12, textAlign: 'center', marginTop: 4, paddingHorizontal: 12 }}>
                                                    Adjust the final time up or down if the scope changed. The final credits released will be calculated automatically.
                                                </Text>
                                            </View>
                                        )}
                                        <View style={{ flexDirection: 'row', gap: 10 }}>
                                            <Pressable accessibilityRole="button" style={styles.cancelActionBtn} onPress={() => setShowCompleteConfirm(false)} disabled={accepting}>
                                                <Text style={styles.cancelActionBtnText} numberOfLines={1}>Cancel</Text>
                                            </Pressable>
                                            <Pressable accessibilityRole="button" style={[styles.confirmActionBtn, styles.confirmActionBtnGreen]} disabled={accepting || (post.price_type !== 'fixed' && !completeHours)} onPress={async () => {
                                                const txToComplete = activeTx?.id || post.pending_transaction_id;
                                                if (!txToComplete) {
                                                    Alert.alert("Loading", "Trust transaction details are still loading. Please wait a moment and try again.");
                                                    return;
                                                }
                                                if (!identity) return;
                                                setAccepting(true);
                                                try {
                                                    await completeMarketplaceTransaction(txToComplete, identity.publicKey, post.price_type !== 'fixed' ? Number(completeHours) : undefined);
                                                    setShowCompleteConfirm(false);
                                                    
                                                    const targetPubkey = isPayer ? (activeTx?.seller_pubkey || post.accepted_by) : (activeTx?.buyer_pubkey || post.author_pubkey);
                                                    setPromptReviewForTx({ 
                                                        txId: txToComplete, 
                                                        targetPubkey, 
                                                        targetCallsign: targetPeerCallsign 
                                                    });
                                                    hapticSuccess();
                                                } catch(e: any) { hapticWarning(); Alert.alert('Error', e.message); } finally { setAccepting(false); }
                                            }}>
                                                <Text style={styles.confirmActionBtnText}>{accepting ? 'Processing...' : 'Release Credits'}</Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                ) : (
                                    <Pressable accessibilityRole="button" style={[styles.acceptBtn, styles.acceptBtnOffer]} onPress={() => { setShowCompleteConfirm(true); if(post.price_type !== 'fixed' && !completeHours) setCompleteHours(activeTx?.hours ? String(activeTx.hours) : '1'); }}>
                                        <Text style={styles.acceptBtnText}>✅ Release Credits</Text>
                                    </Pressable>
                                )}
                            </>
                        ) : (
                            <>
                                <Text style={{ color: palette.amber500, fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: 8, marginBottom: 8 }}>
                                    ⏳ Pending Release by {targetPeerCallsign}
                                </Text>
                                <View style={{ paddingHorizontal: 16, marginBottom: 16, gap: 8 }}>
                                    <Text style={{ color: colors.text.body, fontSize: 14, textAlign: 'center', fontWeight: '600', lineHeight: 20 }}>
                                        You are the Payee. Fulfill the terms exactly as agreed, then ask the Payer to release your credits. You will receive the net amount minus 1.5% transaction fee<Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}> (100% community owned)</Text> (retained to balance the pool).
                                    </Text>
                                    <View style={{ backgroundColor: colors.feedback.danger.bg, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.feedback.danger.border }}>
                                        <Text style={{ color: palette.red700, fontSize: 13, textAlign: 'center', fontWeight: '700' }}>
                                            Note: If this post is still visible here, you have not yet received your credits.
                                        </Text>
                                    </View>
                                </View>
                            </>
                        )}
                        
                        {/* Escrow Communication and Cancellation Actions */}
                        <View style={{ marginTop: 16, borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 16, gap: 12 }}>
                            {targetPeerPubkey && (
                                <Pressable accessibilityRole="button" style={styles.messageBtn} onPress={async () => {
                                    if (!identity) return;
                                    try {
                                        const conv = await createConversationApi('dm', [targetPeerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                                        if (conv) router.push(`/chat/${conv.id}`);
                                    } catch (e: any) {
                                        Alert.alert("Error", e.message || "Failed to start chat.");
                                    }
                                }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                                        <Text style={styles.messageBtnText}>💬 Message {targetPeerCallsign}</Text>
                                        {unreadCount > 0 && (
                                            <View style={styles.unreadBadge}>
                                                <Text style={styles.unreadBadgeText}>{unreadCount}</Text>
                                            </View>
                                        )}
                                    </View>
                                </Pressable>
                            )}

                            <Pressable accessibilityRole="button" accessibilityHint="Cancels the transaction and returns the post to the market" style={styles.cancelTxBtn} disabled={accepting} onPress={() => {
                                const txToCancel = activeTx?.id || post.pending_transaction_id;
                                if (!txToCancel) {
                                    Alert.alert("Loading", "Trust transaction details are still loading. Please wait a moment and try again.");
                                    return;
                                }
                                Alert.alert('Cancel Transaction', 'Return post to the market?', [
                                    { text: 'No', style: 'cancel' },
                                    { text: 'Yes, Cancel', style: 'destructive', onPress: async () => {
                                        if(!identity) return;
                                        setAccepting(true);
                                        try {
                                            await cancelMarketplaceTransaction(txToCancel, identity.publicKey);
                                            if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                                        } catch(e:any) { 
                                            if (e.message?.includes('not found') || e.message?.includes('not authorized')) {
                                                Alert.alert('Already Updated', 'This transaction was already cancelled or completed on another device. Your feed will automatically refresh.');
                                                const { requestSync } = require('../../services/pillar-sync');
                                                requestSync().catch(console.error);
                                                if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                                            } else {
                                                Alert.alert('Error', e.message); 
                                            }
                                        } finally { setAccepting(false); }
                                    }}
                                ]);
                            }}>
                                <Text style={styles.cancelTxBtnText}>❌ Cancel Trust Hold</Text>
                            </Pressable>
                        </View>
                    </View>
                )}

                {/* 2. Own Completed Posts (Badge) */}
                {isOwnPost && (post.status === 'completed' || activeTx?.status === 'completed') && (
                    <View style={styles.confirmBox}>
                        <Text style={[styles.confirmBoxTitle, { color: colors.brand.primary }]}>✅ Deal Completed</Text>
                        <Text style={{ color: palette.gray600, fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
                            This deal has concluded successfully and credits have been processed on the Ledger.
                        </Text>
                    </View>
                )}

                {/* 3. Own Active Posts (Edit / Delete) */}
                {isOwnPost && post.status === 'active' && (!activeTx || activeTx.status !== 'pending') && (
                    editMode ? (
                        <View style={styles.editSection}>
                            <Text style={styles.editSectionTitle}>✏️ Edit Post</Text>

                            {/* Type Toggle */}
                            <View style={styles.editTypeRow}>
                                <Pressable accessibilityRole="button" accessibilityState={{ selected: editType === 'offer' }} style={[styles.editTypeBtn, editType === 'offer' && styles.editTypeBtnOffer]} onPress={() => setEditType('offer')}>
                                    <Text style={[styles.editTypeBtnText, editType === 'offer' && styles.editTypeBtnTextActive]}>🔵 Offer</Text>
                                </Pressable>
                                <Pressable accessibilityRole="button" accessibilityState={{ selected: editType === 'need' }} style={[styles.editTypeBtn, editType === 'need' && styles.editTypeBtnNeed]} onPress={() => setEditType('need')}>
                                    <Text style={[styles.editTypeBtnText, editType === 'need' && styles.editTypeBtnTextActive]}>🟠 Need</Text>
                                </Pressable>
                            </View>

                            {/* Category */}
                            <View style={styles.editPickerWrap}>
                                <Picker selectedValue={editCategory} onValueChange={v => setEditCategory(v)} style={styles.editPicker} dropdownIconColor={colors.text.secondary}>
                                    {POST_CATEGORIES.map(c => <Picker.Item key={c.id} label={`${c.emoji} ${c.label}`} value={c.id} />)}
                                </Picker>
                            </View>

                            {/* Title */}
                            <TextInput accessibilityLabel="Title" style={styles.editInput} value={editTitle} onChangeText={setEditTitle} placeholder="Title" placeholderTextColor={colors.text.muted} />

                            {/* Description */}
                            <TextInput accessibilityLabel="Description" style={[styles.editInput, { minHeight: 80 }]} value={editDescription} onChangeText={setEditDescription} placeholder="Description" placeholderTextColor={colors.text.muted} multiline textAlignVertical="top" />

                            {/* Credits + Price Type */}
                            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                                <TextInput accessibilityLabel="Credits" style={[styles.editInput, { flex: 1, marginBottom: 0 }]} value={editCredits} onChangeText={setEditCredits} placeholder="Credits (B)" placeholderTextColor={colors.text.muted} keyboardType="numeric" />
                                <Pressable accessibilityRole="button" onPress={() => {
                                    const types = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'];
                                    setEditPriceType(types[(types.indexOf(editPriceType) + 1) % types.length]);
                                }} style={{ backgroundColor: colors.surface.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 16, justifyContent: 'center' }}>
                                    <Text style={{ color: colors.text.body, fontSize: 13, fontWeight: '700' }}>{
                                        { fixed: 'Total', hourly: '/ Hr', daily: '/ Dy', weekly: '/ Wk', monthly: '/ Mo' }[editPriceType] || 'Total'
                                    }</Text>
                                </Pressable>
                            </View>

                            {/* Repeatable Toggle */}
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: editRepeatable }}
                                onPress={() => setEditRepeatable(!editRepeatable)}
                                style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.app, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 15 }}
                            >
                                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: editRepeatable ? palette.orange500 : colors.border.strong, backgroundColor: editRepeatable ? palette.orange500 : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                    {editRepeatable && <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 14 }}>✓</Text>}
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ color: colors.text.heading, fontSize: 14, fontWeight: '700' }}>Recurring Need / Offer</Text>
                                    <Text style={{ color: colors.text.secondary, fontSize: 12, marginTop: 2 }}>Post remains active after completion.</Text>
                                </View>
                            </Pressable>

                            {/* Photos */}
                            <Text style={styles.editPhotoLabel}>PHOTOS ({editPhotos.length}/5)</Text>
                            <View style={styles.editPhotosRow}>
                                {editPhotos.map((uri, i) => (
                                    uri && typeof uri === 'string' && uri.trim() !== '' && uri !== 'null' && uri !== 'undefined' ? (
                                        <View key={i} style={styles.editPhotoThumb}>
                                            <Image accessibilityLabel="Post photo" source={{ uri }} style={styles.editPhotoImg} />
                                            <Pressable accessibilityRole="button" accessibilityLabel="Remove photo" accessibilityHint="Removes this photo from the post" style={styles.editPhotoRemove} onPress={() => setEditPhotos(prev => prev.filter((_, j) => j !== i))}>
                                                <Text style={styles.editPhotoRemoveText}>✕</Text>
                                            </Pressable>
                                        </View>
                                    ) : null
                                ))}
                                {editPhotos.length < 5 && (
                                    <Pressable accessibilityRole="button" accessibilityLabel="Add photo" style={styles.editPhotoAdd} onPress={pickEditPhoto}>
                                        <Text style={styles.editPhotoAddIcon}>+</Text>
                                    </Pressable>
                                )}
                            </View>

                            {/* Save / Cancel */}
                            <View style={styles.editBtnRow}>
                                <Pressable accessibilityRole="button" style={styles.editCancelBtn} onPress={() => setEditMode(false)}>
                                    <Text style={styles.editCancelBtnText}>Cancel</Text>
                                </Pressable>
                                <Pressable accessibilityRole="button" style={[styles.editSaveBtn, (saving || !editTitle.trim()) && styles.editSaveBtnDisabled]} onPress={handleSave} disabled={saving || !editTitle.trim()}>
                                    <Text style={styles.editSaveBtnText}>{saving ? 'Saving...' : '💾 Save'}</Text>
                                </Pressable>
                            </View>
                        </View>
                    ) : (
                        <View style={styles.ownPostActions}>
                            <Pressable accessibilityRole="button" style={styles.editPostBtn} onPress={startEdit}>
                                <Text style={styles.editPostBtnText}>✏️ Edit Post</Text>
                            </Pressable>
                            <Pressable accessibilityRole="button" accessibilityHint="Permanently deletes this post" style={styles.deletePostBtn} onPress={handleDelete} disabled={deleting}>
                                <Text style={styles.deletePostBtnText}>{deleting ? 'Deleting...' : '🗑️ Delete Post'}</Text>
                            </Pressable>
                        </View>
                    )
                )}

                {/* 3. Unaccepted Posts Displayed to Browsers */}
                {!isOwnPost && post.status === 'active' && !isAcceptedByMe && (
                    <View style={styles.otherPostActions}>
                        {myRequest ? (
                            <View style={styles.confirmBox}>
                                <Text style={[styles.confirmBoxTitle, { color: colors.brand.primary }]}>Deal Established</Text>
                                <Text style={{ color: palette.gray600, fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
                                    {isOffer ? (
                                        `You have committed ${myRequest.credits} credits ${myRequest.hours ? `(${myRequest.hours} hours)` : ''} to a Trust Wallet for this offer.`
                                    ) : (
                                        <>
                                            {`You have requested to earn ${myRequest.credits} credits ${myRequest.hours ? `(${myRequest.hours} hours)` : ''} (${(myRequest.credits * 0.985).toFixed(2)} net after 1.5% transaction fee)`}
                                            <Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}> (100% community owned)</Text>
                                            {` for fulfilling this need.`}
                                        </>
                                    )}
                                </Text>
                                <Pressable accessibilityRole="button" style={[styles.cancelActionBtn, { width: '100%' }]} onPress={handleWithdraw} disabled={accepting}>
                                    <Text style={styles.cancelActionBtnText}>{accepting ? 'Withdrawing...' : 'Withdraw Request'}</Text>
                                </Pressable>
                            </View>
                        ) : showAcceptConfirm ? (
                            <View style={styles.confirmBox}>
                                <Text style={styles.confirmBoxTitle}>{isOffer ? 'Accept this Offer?' : 'Offer to Fulfill?'}</Text>
                                
                                <View style={{ backgroundColor: colors.feedback.warning.bg, padding: 12, borderRadius: 8, borderColor: colors.feedback.warning.border, borderWidth: 1, marginBottom: 16 }}>
                                    <Text style={{ color: palette.orange700, fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>🔒 Trust Wallet Protocol</Text>
                                    <Text style={{ color: palette.gray600, fontSize: 12, lineHeight: 18 }}>
                                        {isOffer ? (
                                            <>
                                                {`By proceeding, you commit ${post.price_type === 'fixed' ? post.credits : `your authorized`} credits to a temporary Trust Wallet. Upon completion, the provider receives the credits net of 1.5% transaction fee`}
                                                <Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}> (100% community owned)</Text>
                                                {` to fund the Commons Pool.`}
                                            </>
                                        ) : (
                                            <>
                                                {`This transaction is protected and held in trust. The payer has already committed the credits. Upon completion, you will receive the credits net of 1.5% transaction fee`}
                                                <Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}> (100% community owned)</Text>
                                                {` to fund the Commons Pool.`}
                                            </>
                                        )}
                                    </Text>
                                </View>
                                {post.price_type !== 'fixed' && (
                                    <View style={{ marginBottom: 12 }}>
                                        <Text style={styles.confirmBoxLabel}>TRUST COMMITMENT (HOURS)</Text>
                                        <TextInput accessibilityLabel="Trust commitment in hours" style={styles.confirmBoxInput} value={acceptHours} onChangeText={setAcceptHours} placeholder="Hours" placeholderTextColor={colors.text.muted} keyboardType="numeric" editable={post.price_type !== 'fixed'} />
                                        <Text style={{ color: colors.text.muted, fontSize: 10, textAlign: 'center', marginTop: 4 }}>Credits will be required upon approval.</Text>
                                    </View>
                                )}
                                <View style={{ flexDirection: 'row', gap: 10 }}>
                                    <Pressable accessibilityRole="button" style={styles.cancelActionBtn} onPress={() => setShowAcceptConfirm(false)} disabled={accepting}>
                                        <Text style={styles.cancelActionBtnText}>Cancel</Text>
                                    </Pressable>
                                    <Pressable accessibilityRole="button" style={[styles.confirmActionBtn, styles.confirmActionBtnGreen]} disabled={accepting || (post.price_type !== 'fixed' && !acceptHours)} onPress={async () => {
                                        if (accepting) return;
                                        if (!identity || !post.id) return;
                                        setAccepting(true);
                                        try {
                                            const estimatedHrs = post.price_type !== 'fixed' ? Number(acceptHours) : undefined;
                                            if (isOffer) {
                                                await acceptMarketplacePost(post.id, identity.publicKey, estimatedHrs);
                                            } else {
                                                await requestMarketplacePost(post.id, identity.publicKey, estimatedHrs);
                                                // Optimistically add to local state
                                                setRequests(prev => [...prev, {
                                                    id: Crypto.randomUUID(), post_id: post.id, buyer_pubkey: post.author_pubkey, seller_pubkey: identity.publicKey,
                                                    credits: post.price_type === 'fixed' ? post.credits : post.credits * Number(acceptHours),
                                                    hours: post.price_type === 'fixed' ? null : Number(acceptHours), status: 'requested'
                                                }]);
                                            }
                                            setShowAcceptConfirm(false);
                                            
                                            // Navigation Flow Improvement: Directly create conversation and jump to chat
                                            try {
                                                const conv = await createConversationApi('dm', [post.author_pubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                                                if (conv) {
                                                    router.replace(`/chat/${conv.id}`);
                                                    return;
                                                }
                                            } catch (chatError) {
                                                console.error("Failed to start chat during post acceptance", chatError);
                                            }
                                            
                                            // Fallback if chat fails
                                            router.replace({ pathname: '/(tabs)', params: { tab: 'deals', dealsTab: 'pending' } });
                                        } catch (e: any) {
                                            if (e.message?.includes('not found') || e.message?.includes('not active')) {
                                                Alert.alert('Already Updated', 'This post was already accepted or modified elsewhere. Refreshing your screen...');
                                                const { requestSync } = require('../../services/pillar-sync');
                                                requestSync().catch(console.error);
                                                setShowAcceptConfirm(false);
                                            } else {
                                                const x = explainTradeError(e);
                                                Alert.alert(x.title, x.message);
                                            }
                                        } finally {
                                            setAccepting(false); 
                                        }
                                    }}>
                                        <Text style={styles.confirmActionBtnText}>{accepting ? 'Processing...' : 'Confirm'}</Text>
                                    </Pressable>
                                </View>
                            </View>
                        ) : (
                            <Pressable accessibilityRole="button" style={[styles.acceptBtn, isOffer ? styles.acceptBtnOffer : styles.acceptBtnNeed, (accepting || post.status === 'pending') && { opacity: 0.6 }]} disabled={accepting || post.status === 'pending'} onPress={() => {
                                // Accepting an Offer extracts value → gated. Fulfilling a Need is a contribution → allowed.
                                if (isOffer && blockedFromTrading) { setShowContributionRequired(true); } else { setShowAcceptConfirm(true); }
                            }}>
                                <Text style={styles.acceptBtnText}>
                                    {accepting ? 'Processing...' : (post.status === 'pending' ? '⏳ Pending Confirmation' : (isOffer ? '🤝 Accept Offer' : '✋ Offer to Fulfill'))}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {/* 3.5 Author Requests Display */}
                {isOwnPost && post.status === 'active' && requests.length > 0 && (
                    <View style={styles.requestsContainer}>
                        <Text style={styles.requestsTitle}>✋ Fulfillment Requests ({requests.length})</Text>
                        {requests.map(req => {
                            const reqPubkey = req.resolvedReqPubkey || ((post.type === 'need' && req.seller_pubkey) ? req.seller_pubkey : req.buyer_pubkey);
                            // Fallback gracefully if pubkey is somehow still empty
                            const safePubkeyStr = reqPubkey ? reqPubkey.slice(0, 8) : "Unknown";
                            
                            let reqCallsign = safePubkeyStr;
                            if (post.type === 'need' && req.seller_pubkey) {
                                reqCallsign = req.seller_callsign || safePubkeyStr;
                            } else {
                                reqCallsign = req.buyer_callsign || safePubkeyStr;
                            }
                            
                            return (
                                <View key={req.id} style={styles.requestCard}>
                                    <View style={{ flex: 1, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                        <View style={{ flex: 1, paddingRight: 8 }}>
                                            <Pressable accessibilityRole="button" onPress={() => {
                                                if (reqPubkey) router.push({ pathname: '/public-profile', params: { publicKey: reqPubkey, callsign: reqCallsign } });
                                            }}>
                                                <Text style={[styles.requestName, { textDecorationLine: 'underline', color: palette.amber400 }]} numberOfLines={1}>
                                                    🤝 {reqCallsign}
                                                </Text>
                                            </Pressable>
                                            <Text style={{ fontSize: 12, color: palette.amber400, marginTop: 2, fontWeight: '600' }}>
                                                {req.count > 0 ? `★ ${req.avgRating.toFixed(1)} (${req.count} reviews)` : '☆☆☆☆☆ No ratings yet'}
                                            </Text>
                                            <Text style={styles.requestAmt}>{req.hours ? `${req.hours} hours estimated` : 'Offered to fulfill'}</Text>
                                        </View>
                                        <Pressable
                                            accessibilityRole="button"
                                            style={styles.reqMessageBtn}
                                            onPress={async () => {
                                                if (!identity || !reqPubkey) return;
                                                try {
                                                    const conv = await createConversationApi('dm', [reqPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                                                    if (conv) router.push(`/chat/${conv.id}`);
                                                } catch (e: any) { Alert.alert("Error", e.message); }
                                            }}
                                        >
                                            <Text style={styles.reqMessageBtnText}>💬 Message</Text>
                                            {(reqUnreadCounts[req.id] || 0) > 0 && (
                                                <View style={styles.unreadBadgeSmall}>
                                                    <Text style={styles.unreadBadgeTextSmall}>{reqUnreadCounts[req.id]}</Text>
                                                </View>
                                            )}
                                        </Pressable>
                                    </View>
                                    <View style={{flexDirection: 'row', gap: 8}}>
                                        <Pressable accessibilityRole="button" style={[styles.rejectBtn, accepting && {opacity: 0.5}, { flex: 1, alignItems: 'center' }]} disabled={accepting} onPress={() => handleReject(req.id)}>
                                            <Text style={styles.rejectBtnText} numberOfLines={1}>Deny</Text>
                                        </Pressable>
                                        <Pressable accessibilityRole="button" style={[styles.approveBtn, accepting && {opacity: 0.5}, { flex: 2, alignItems: 'center' }]} disabled={accepting} onPress={() => handleApprove(req.id)}>
                                            <Text style={styles.approveBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>Approve & Commit</Text>
                                        </Pressable>
                                    </View>
                                </View>
                            );
                        })}
                    </View>
                )}

                {/* 4. Universal Actions for Peer (Message, Rate, Report) */}
                {(!isOwnPost || post.status === 'pending' || post.status === 'completed' || activeTx) && (
                    <View style={[styles.otherPostActions, { marginTop: post.status === 'pending' || post.status === 'active' ? 10 : 0 }]}>
                        {targetPeerPubkey && !((post.status === 'pending' || activeTx?.status === 'pending') && (isPayer || isPayee)) && (
                            <Pressable accessibilityRole="button" style={styles.messageBtn} onPress={async () => {
                                if (!identity) return;
                                try {
                                    const conv = await createConversationApi('dm', [targetPeerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                                    if (conv) router.push(`/chat/${conv.id}`);
                                } catch (e: any) {
                                    Alert.alert("Error", e.message || "Failed to start chat.");
                                }
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                                    <Text style={styles.messageBtnText}>💬 Message {!isOwnPost ? targetPeerCallsign : ''}</Text>
                                    {unreadCount > 0 && (
                                        <View style={styles.unreadBadge}>
                                            <Text style={styles.unreadBadgeText}>{unreadCount}</Text>
                                        </View>
                                    )}
                                </View>
                            </Pressable>
                        )}
                        {identity && (post.status === 'completed' || activeTx?.status === 'completed') && (activeTx?.id || post.pending_transaction_id) && targetPeerPubkey && (
                            <View style={{ marginTop: 16 }}>
                                <Pressable accessibilityRole="button" style={[styles.messageBtn, { borderColor: hasExistingRating ? colors.brand.primary : colors.feedback.warning.border, backgroundColor: hasExistingRating ? colors.feedback.success.bg : colors.feedback.warning.bg }]} onPress={() => setShowRatingForm(!showRatingForm)}>
                                    <Text style={[styles.messageBtnText, { color: hasExistingRating ? colors.brand.primary : palette.amber500 }]}>
                                        {hasExistingRating ? `★ Edit rating for ${targetPeerCallsign}` : `★ Rate ${targetPeerCallsign}`}
                                    </Text>
                                </Pressable>
                                {showRatingForm && (
                                    <View style={[styles.confirmBox, { marginTop: 8 }]}>
                                        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
                                            {[1,2,3,4,5].map(star => (
                                                <Pressable key={star} accessibilityRole="button" accessibilityLabel={`Rate ${star} star${star === 1 ? '' : 's'}`} accessibilityState={{ selected: star <= myRating }} onPress={() => { setMyRating(star); hapticTick(); }}>
                                                    <Text style={{ fontSize: 32, color: star <= myRating ? palette.amber400 : colors.border.strong }}>{star <= myRating ? '★' : '☆'}</Text>
                                                </Pressable>
                                            ))}
                                        </View>
                                        <TextInput accessibilityLabel="Rating comment" style={[styles.editInput, { minHeight: 60, marginBottom: 12 }]} value={ratingComment} onChangeText={setRatingComment} placeholder="Leave an optional comment..." placeholderTextColor={colors.text.muted} multiline />
                                        <Pressable accessibilityRole="button" style={[styles.confirmActionBtn, { backgroundColor: myRating >= 1 ? (hasExistingRating ? colors.brand.primary : palette.amber500) : colors.border.default }]} disabled={myRating < 1 || submittingRating} onPress={async () => {
                                            const txToRate = activeTx?.id || post.pending_transaction_id;
                                            if(!identity || !txToRate) return;
                                            try {
                                                setSubmittingRating(true);
                                                await submitRating(identity.publicKey, targetPeerPubkey, myRating, ratingComment, txToRate);
                                                setShowRatingForm(false);
                                                setHasExistingRating(true);
                                                hapticSuccess();
                                                Alert.alert('Success', hasExistingRating ? 'Rating updated!' : 'Rating submitted!');
                                            } catch(e:any) { hapticWarning(); Alert.alert('Error', e.message); } finally { setSubmittingRating(false); }
                                        }}>
                                            <Text style={styles.confirmActionBtnText}>
                                                {submittingRating ? 'Submitting...' : hasExistingRating ? 'Update Rating' : 'Submit Rating'}
                                            </Text>
                                        </Pressable>
                                    </View>
                                )}
                            </View>
                        )}

                        <Pressable accessibilityRole="button" style={[styles.messageBtn, { marginTop: 12, borderColor: 'transparent', backgroundColor: 'transparent' }]} onPress={() => setShowReportForm(!showReportForm)}>
                            <Text style={[styles.messageBtnText, { color: colors.feedback.danger.solid, fontSize: 13 }]}>🚩 Report Post</Text>
                        </Pressable>
                        {showReportForm && (
                            <View style={[styles.confirmBox, { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border }]}>
                                <Text style={styles.confirmBoxLabel}>REPORT REASON</Text>
                                <View style={styles.editPickerWrap}>
                                    <Picker selectedValue={reportReason} onValueChange={v => setReportReason(v)} style={styles.editPicker} dropdownIconColor={colors.feedback.danger.solid}>
                                        <Picker.Item label="Select a reason..." value="" />
                                        <Picker.Item label="Spam or scam" value="Spam or scam" />
                                        <Picker.Item label="Offensive content" value="Offensive content" />
                                        <Picker.Item label="Misleading post" value="Misleading post" />
                                        <Picker.Item label="Other" value="Other" />
                                    </Picker>
                                </View>
                                <Pressable accessibilityRole="button" style={[styles.confirmActionBtn, { backgroundColor: reportReason ? colors.feedback.danger.solid : colors.border.default }]} disabled={!reportReason || submittingReport} onPress={async () => {
                                    if(!identity || !post.id) return;
                                    try {
                                        setSubmittingReport(true);
                                        await reportAbuse(identity.publicKey, post.author_pubkey, reportReason, post.id);
                                        setShowReportForm(false);
                                        Alert.alert('Reported', 'Post was flagged for review.');
                                    } catch(e:any) { Alert.alert('Error', e.message); } finally { setSubmittingReport(false); }
                                }}>
                                    <Text style={styles.confirmActionBtnText}>{submittingReport ? 'Sending...' : 'Submit Report'}</Text>
                                </Pressable>
                            </View>
                        )}
                    </View>
                )}
            </ScrollView>
            </KeyboardAvoidingView>
            {promptReviewForTx && (
                <ReviewModal 
                    visible={!!promptReviewForTx}
                    txId={promptReviewForTx.txId}
                    targetPubkey={promptReviewForTx.targetPubkey}
                    targetCallsign={promptReviewForTx.targetCallsign}
                    onClose={() => {
                        setPromptReviewForTx(null);
                        if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                    }}
                    onSuccess={() => {
                        setPromptReviewForTx(null);
                        if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                    }}
                />
            )}
            
            {/* Reject Request Modal */}
            {rejectModalTxId && (
                <View style={StyleSheet.absoluteFill}>
                    <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.modalOverlay} onPress={() => setRejectModalTxId(null)}>
                        <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={64} style={{ width: '100%' }}>
                            <Pressable style={styles.modalContent} onPress={e => e.stopPropagation()}>
                                <Text style={styles.modalTitle}>Decline Offer</Text>
                                <Text style={styles.modalSubtext}>Are you sure you want to decline this offer?</Text>
                                <TextInput
                                    accessibilityLabel="Decline message"
                                    style={[styles.editInput, { minHeight: 80, marginBottom: 16 }]}
                                    value={rejectMessage}
                                    onChangeText={setRejectMessage}
                                    placeholder="Add a brief message (optional)..."
                                    placeholderTextColor={colors.text.muted}
                                    multiline
                                    textAlignVertical="top"
                                />
                                <View style={{ flexDirection: 'row', gap: 12 }}>
                                    <Pressable accessibilityRole="button" style={[styles.editCancelBtn, { flex: 1 }]} onPress={() => setRejectModalTxId(null)}>
                                        <Text style={styles.editCancelBtnText}>Cancel</Text>
                                    </Pressable>
                                    <Pressable accessibilityRole="button" style={[styles.deletePostBtn, { flex: 1, marginVertical: 0 }]} disabled={accepting} onPress={confirmReject}>
                                        <Text style={styles.deletePostBtnText}>{accepting ? '...' : 'Decline'}</Text>
                                    </Pressable>
                                </View>
                            </Pressable>
                        </KeyboardAvoidingView>
                    </Pressable>
                </View>
            )}

            {/* Contribution-first gate: blocks accepting an Offer until the member lists one. */}
            {showContributionRequired && (
                <View style={StyleSheet.absoluteFill}>
                    <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.modalOverlay} onPress={() => setShowContributionRequired(false)}>
                        <Pressable style={styles.modalContent} onPress={e => e.stopPropagation()}>
                            <Text style={[styles.modalTitle, { textAlign: 'center' }]}>🔒 Contribution Required</Text>
                            <Text style={[styles.modalSubtext, { textAlign: 'center' }]}>
                                To accept Offers or post Needs, first list at least one Offer detailing what you can contribute to the community. (Or ask an Elder to vouch for you.)
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                style={{ marginTop: 8, paddingVertical: 14, borderRadius: 12, backgroundColor: palette.emerald600 || '#059669', alignItems: 'center' }}
                                onPress={() => { setShowContributionRequired(false); router.push({ pathname: '/(tabs)/map', params: { newPost: 'true' } }); }}
                            >
                                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>➕ Create an Offer</Text>
                            </Pressable>
                            <Pressable accessibilityRole="button" style={[styles.editCancelBtn, { marginTop: 10 }]} onPress={() => setShowContributionRequired(false)}>
                                <Text style={styles.editCancelBtnText}>Not now</Text>
                            </Pressable>
                        </Pressable>
                    </Pressable>
                </View>
            )}
        </View>
    );
}

function renderBeans(rating: number): string {
    const r = Math.round(rating) || 0;
    return '★'.repeat(Math.min(r, 5)) + '☆'.repeat(Math.max(0, 5 - r));
}

function getTimeAgo(dateStr: string): string {
    try {
        const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
        if (secs < 60) return 'just now';
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        return `${days}d ago`;
    } catch { return ''; }
}


