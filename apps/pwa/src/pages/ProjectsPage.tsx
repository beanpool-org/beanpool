import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
    getTreasuries, getBalance, type Treasury, type BalanceInfo,
    createEnterprise,
    getDecisions, type DecisionWithTally, type MyPoolVoting,
    getCommonsBalance,
    getAllMembers, type MemberSummary,
    getGroups, type Group,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { AvatarPresetPicker } from '../components/AvatarPresetPicker';
import { usePictureCrop } from '../components/PictureCropDialog';
import { DecideSection } from '../components/DecideSection';
import { ProposeDecisionModal } from '../components/ProposeDecisionModal';
import { CreateGroupModal } from '../components/CreateGroupModal';
import { GroupDetailModal } from '../components/GroupDetailModal';
import { StartSomethingDialog } from '../components/StartSomethingDialog';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { decisionsOn } from '../lib/node-decisions';
import { useMembersOnDemand } from '../lib/members-on-demand';
import { modeFor, readerFeaturesOnce, readsOwn, useReadsOwn } from '../lib/features';
import { type CommunityInfo } from '../lib/api';
import { AVATAR_PICTURE, TOOLS, TOOL_SHELVES, formatNumber, t, tn, toolsOnShelf, word, type FeatureMode, type WordKey, type StartRowKey } from '@beanpool/core';
import { TOOL_APPS } from '../tools';
import { ToolRow } from '../tools/ui';
import { CommonsPreview, sampleCommonsBalance, sampleDecisions, samplePoolVoting } from '../components/ShowcasePreviews';
import { EnterpriseCard } from '../components/EnterpriseCard';
import { LocalCommunitySheet } from '../components/LocalCommunityMark';
import { StartCommunityScreen } from '../components/StartCommunityScreen';
import { commonsHeading, findHeading, yoursEmpty, type GroupKind } from '../lib/commons-sections';

interface Props {
    identity: BeanPoolIdentity | null;
    onOpenTreasury?: (publicKey: string, tab?: 'page' | 'manage') => void;
    initialSection?: 'decide' | 'enterprises' | 'groups';
    onNavigate?: (tab: string, contextId?: string) => void;
    /**
     * Whether the viewer is a member of this node. False for a guest (a local key the node has no member
     * for), so the viewer's balance is never requested. Null while App is still checking, so the request
     * waits for the answer. Omitted means a member.
     */
    isMember?: boolean | null;
}

/** Shown when the browser cannot read, decode or draw the picked photo (the crop rejected): a word() key, put through t() where shown. */
const PHOTO_WORDS = { readError: word('That photo could not be read. Please choose another one.') } as const;

/**
 * A group's kind, join policy and the viewer's role as the node names them: word() keys (the phone's), shown through
 * t(). Any other name is shown as the node wrote it. The tables' own names only (a "constructor" is not one).
 */
const CATEGORY_WORDS: Readonly<Record<string, WordKey>> = {
    social: word('social', 'group category'), general: word('general', 'group category'), working_group: word('working group', 'group category'),
    project: word('project', 'group category'), guild: word('guild', 'group category'),
};
const JOIN_POLICY_WORDS: Readonly<Record<string, WordKey>> = {
    open: word('open', 'join policy'), request_to_join: word('request to join', 'join policy'), invite_only: word('invite only', 'join policy'),
};
const ROLE_WORDS: Readonly<Record<string, WordKey>> = {
    convenor: word('convenor', 'group role badge'), member: word('member', 'group role badge'), observer: word('observer', 'group role badge'),
};
const own = (table: object, name: string) => Object.prototype.hasOwnProperty.call(table, name);
const named = (table: Readonly<Record<string, WordKey>>, name: string, asWritten: string) => (own(table, name) ? t(table[name]) : asWritten);

/** The section tabs and the Groups list's chips: word() keys, shown through t(). */
const SECTION_TABS = [
    { key: 'decide', emoji: '🗳️', label: word('Decide') },
    { key: 'groups', emoji: '👥', label: word('Groups') },
] as const;
const GROUP_CHIPS: Array<{ key: GroupKind; label: WordKey }> = [
    { key: 'all', label: word('All') },
    { key: 'projects', label: word('🌱 Projects') },
    { key: 'enterprises', label: word('🏛️ Enterprises') },
    { key: 'chat', label: word('👥 Chat groups') },
];

/** Today in the member's own calendar, as a date field reads it (YYYY-MM-DD): a project can't end before it. */
const localToday = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function ProjectsPage({ identity, onOpenTreasury, initialSection = 'enterprises', onNavigate, isMember }: Props) {
    const canLoadBalance = !!identity?.publicKey && isMember !== false && isMember !== null;
    // The reader's balance is Beans: where they are in preview (the global node) it is never asked (lib/features readsOwn).
    const readsBalance = useReadsOwn('beans', canLoadBalance);
    const [treasuries, setTreasuries] = useState<Treasury[]>([]);
    const [balanceInfo, setBalanceInfo] = useState<BalanceInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // UI States
    // One Groups list holds projects, enterprises and chat groups (pick 7): a page asked for Enterprises opens on it.
    const [pickedSection, setActiveSection] = useState<'decide' | 'groups'>(initialSection === 'enterprises' ? 'groups' : initialSection);
    // Formal Decisions, where the node has them (lib/node-decisions.ts: off on the global node, which refuses every
    // proposal and vote, but shows Decide in preview mode). Until the node has said, on, as on every node before the switch.
    const [votes, setVotes] = useState(true);
    // Projects and enterprises hold Beans: where the node has Beans off, the Create form offers neither.
    const [beansOn, setBeansOn] = useState(true);
    // Enterprises or Decisions off here and the node shows previews: the Commons shows Example Valley's, each by its own
    // mode (lib/features.ts).
    const [enterprisesMode, setEnterprisesMode] = useState<FeatureMode>('hidden');
    const [decisionsMode, setDecisionsMode] = useState<FeatureMode>('hidden');
    // The node did not answer, so the modes never landed: 'hidden' then means "not known", not "off".
    const [modesUnknown, setModesUnknown] = useState(false);
    // Commons → Tools (DESIGN-tool-template-fable.md §1.5, the phone's row since T0.2): where a member here has any tool
    // this build has a web half for. Nothing here names a tool.
    const [communityInfo, setCommunityInfo] = useState<CommunityInfo | null>(null);
    const toolsHere = useMemo(() => {
        const facts = { profile: communityInfo?.profile ?? null, features: (communityInfo?.features ?? {}) as Record<string, unknown> };
        return TOOL_SHELVES.some((shelf) => toolsOnShelf(shelf, null, 'member', facts, TOOLS).some((m) => !!TOOL_APPS[m.id]));
    }, [communityInfo]);
    useEffect(() => {
        let cancelled = false;
        Promise.resolve()
            .then(() => communityInfoOnce())
            .then((info) => {
                if (cancelled) return;
                setCommunityInfo(info);
                // The node's info alone sets Decide and the Beans create options, as before: no wait on the reader's set.
                setVotes(decisionsOn(info));
                setBeansOn(info?.features?.beans !== false);
                // The modes wait for the reader's set too (none is read where it cannot matter): no preview flashes and goes.
                return readerFeaturesOnce(info).then((reader) => {
                    if (cancelled) return;
                    setEnterprisesMode(modeFor('enterprises', info, reader));
                    const decisions = modeFor('decisions', info, reader);
                    setDecisionsMode(decisions);
                    setVotes(decisions === 'live');
                });
            })
            .catch(() => {
                // Not answered: keep what the page shows; the node refuses a vote itself.
                if (!cancelled) setModesUnknown(true);
            });
        return () => { cancelled = true; };
    }, []);
    const hasDecide = votes || decisionsMode === 'preview';
    // The reader's own voice credits: where Decisions are live for them, or, when the node never said, wherever Decide is (as before
    // the modes). Never before the modes land on a node that answers: on the global node that card would be drawn and then go.
    const showsOwnVoiceCredits = decisionsMode === 'live' || (modesUnknown && votes);
    const activeSection = !hasDecide && pickedSection === 'decide' ? 'groups' : pickedSection;
    const [activeDecideView, setActiveDecideView] = useState<'open' | 'history'>('open');
    const [decisions, setDecisions] = useState<DecisionWithTally[]>([]);
    // The signer's voice credits for votes on community money — the number the node checks (answer H).
    const [myPoolVoting, setMyPoolVoting] = useState<MyPoolVoting | null>(null);
    const [nodeSaysCanPropose, setNodeSaysCanPropose] = useState<boolean | null>(null);
    const [commonsBalance, setCommonsBalance] = useState<number>(0);
    const effectiveDecisions = decisionsMode === 'preview' ? sampleDecisions() : decisions;
    const effectiveMyPoolVoting = decisionsMode === 'preview' ? samplePoolVoting() : myPoolVoting;
    const effectiveCommonsBalance = decisionsMode === 'preview' ? sampleCommonsBalance() : commonsBalance;
    const [showProposeDecision, setShowProposeDecision] = useState<boolean>(false);
    const [allMembersList, setAllMembersList] = useState<Array<{ publicKey: string; callsign?: string; balance?: number }>>([]);
    // The directory (only the Decision form's name preview uses it) is read whole only where the node has said it reads
    // whole: never with members on demand, the worldwide community (lib/members-on-demand; review of #1861, N1).
    const membersOnDemand = useMembersOnDemand();
    const membersOnDemandRef = useRef<boolean | null>(null);
    membersOnDemandRef.current = membersOnDemand;

    // Groups State
    const [groups, setGroups] = useState<Group[]>([]);
    const [loadingGroups, setLoadingGroups] = useState(false);
    const [pickedGroupCategory, setGroupCategoryFilter] = useState<GroupKind>('all');
    const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
    const [selectedGroupForDetail, setSelectedGroupForDetail] = useState<Group | null>(null);

    // The kind chips: projects and enterprises hold Beans; chat groups are the rest. Where enterprises
    // are in preview (the global node) no project or enterprise can exist, so those two chips would only ever be empty:
    // they are not offered, and one picked before the mode arrived reads as All.
    const enterprisesPreview = enterprisesMode === 'preview';
    const groupCategoryFilter: GroupKind = enterprisesPreview && (pickedGroupCategory === 'projects' || pickedGroupCategory === 'enterprises') ? 'all' : pickedGroupCategory;
    const filter: 'all' | 'ongoing' | 'bounded' = groupCategoryFilter === 'projects' ? 'bounded' : groupCategoryFilter === 'enterprises' ? 'ongoing' : 'all';
    const showEnterprises = groupCategoryFilter === 'all' || groupCategoryFilter === 'projects' || groupCategoryFilter === 'enterprises';
    const showChatGroups = groupCategoryFilter === 'all' || groupCategoryFilter === 'chat';

    // "＋ Start something": where focus goes back when the sheet, or a sheet it opened, closes.
    const startButtonRef = useRef<HTMLButtonElement>(null);
    // Start something dialog
    const [showStartSomething, setShowStartSomething] = useState(false);
    const [showDecisionsSheet, setShowDecisionsSheet] = useState(false);
    const [showStartCommunity, setShowStartCommunity] = useState(false);

    // Propose / New Enterprise modal
    const [showNewModal, setShowNewModal] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [newLifecycle, setNewLifecycle] = useState<'' | 'ongoing' | 'bounded'>('bounded');
    const [newGoal, setNewGoal] = useState<number | ''>('');
    const [newDeadline, setNewDeadline] = useState('');
    const [newPhotos, setNewPhotos] = useState<string[]>([]);
    // A picked photo is being read or cropped; the form waits for it (handlePhotoUpload). Only the latest pick counts.
    const [preparingPhoto, setPreparingPhoto] = useState(false);
    const photoPick = useRef(0);
    const cropper = usePictureCrop();
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    // Keyboard accessibility: Escape closes modal
    useEffect(() => {
        if (!showNewModal) return;
        const handleKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                setShowNewModal(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showNewModal]);

    const fetchEnterprises = async () => {
        try {
            setLoading(true);
            setError(null);
            // Enterprises and Decisions in preview (the global node) are Example Valley's: their lists, the reader's voice
            // credits and the pool the Decide tab spends are not asked (lib/features readsOwn). Elsewhere, as before.
            const [readsTreasuries, readsDecisions] = await Promise.all([readsOwn('enterprises'), readsOwn('decisions')]);
            const [tresData, decData, commonsData, membersData] = await Promise.all([
                readsTreasuries && getTreasuries ? getTreasuries().catch(() => ({ treasuries: [] })) : { treasuries: [] },
                readsDecisions && getDecisions ? getDecisions().catch(() => ({ decisions: [], myPoolVoting: null })) : { decisions: [], myPoolVoting: null },
                readsDecisions && getCommonsBalance ? getCommonsBalance().catch(() => ({ balance: 0 })) : { balance: 0 },
                // null, not [], when the directory couldn't be read (the node busy with heavy lists answers 503): the
                // members list below keeps who it had, and the next fetch reads them again.
                // Read only once the node has said it reads whole (the effect below reads them when it says so).
                membersOnDemandRef.current !== false ? null : getAllMembers ? getAllMembers().catch(() => null) : null,
            ]);
            setTreasuries(tresData.treasuries || []);
            setDecisions(decData.decisions || []);
            setMyPoolVoting(decData.myPoolVoting ?? null);
            setNodeSaysCanPropose((decData as { canPropose?: boolean | null }).canPropose ?? null);
            setCommonsBalance(commonsData.balance || 0);
            if (Array.isArray(membersData)) {
                setAllMembersList((membersData as MemberSummary[]).map((m: MemberSummary) => ({ publicKey: m.publicKey, callsign: m.callsign, balance: (m as any).balance ?? 0 })));
            }
        } catch (err: any) {
            setError(err.message || t('Failed to fetch community enterprises'));
        } finally {
            setLoading(false);
        }
    };

    // The node's rule (a completed trade, or a node admin); earned credit only until the list has loaded.
    const canProposeDecision = nodeSaysCanPropose ?? (balanceInfo?.earnedCredit || 0) > 0;
    const hasOpenDecision = useMemo(() => {
        if (!identity?.publicKey) return false;
        return effectiveDecisions.some(d => d.authorPubkey === identity.publicKey && d.status === 'open');
    }, [effectiveDecisions, identity]);
    const openDecisionsCount = useMemo(() => {
        return effectiveDecisions.filter(d => d.status === 'open').length;
    }, [effectiveDecisions]);

    // True when the pick opens a dialog that takes focus itself (the showcase's decisions sheet); else the sheet gives focus
    // back to "＋ Start something".
    const handlePickStartRow = (key: StartRowKey): boolean => {
        setShowStartSomething(false);
        if (key === 'chat') {
            setShowCreateGroupModal(true);
        } else if (key === 'project') {
            setNewLifecycle('bounded');
            setShowNewModal(true);
            setCreateError(null);
        } else if (key === 'enterprise') {
            setNewLifecycle('ongoing');
            setShowNewModal(true);
            setCreateError(null);
        } else if (key === 'decision') {
            if (decisionsMode === 'preview') {
                setActiveSection('decide');
                setShowDecisionsSheet(true);
                return true;
            }
            if (!canProposeDecision) {
                alert(beansOn
                    ? t('You can propose a Decision once you have completed a trade.')
                    : t('Node admins propose here.'));
                return false;
            }
            if (hasOpenDecision) {
                alert(t('You already have an open decision (limit 1 open decision per author).'));
                return false;
            }
            setShowProposeDecision(true);
        } else if (key === 'poll') {
            onNavigate?.('marketplace', 'new-poll');
        } else if (key === 'event') {
            onNavigate?.('marketplace', 'new-event');
        }
        return false;
    };

    useEffect(() => {
        fetchEnterprises();
    }, [identity?.publicKey]);

    // The node has just said it reads whole: the list the fetch at open couldn't read yet, read once.
    useEffect(() => {
        if (membersOnDemand !== false) return;
        // Asked inside the promise, so a read that throws before it starts waits for the next fetch too.
        Promise.resolve().then(() => getAllMembers()).then((membersData) => {
            if (Array.isArray(membersData)) setAllMembersList(membersData.map((m: MemberSummary) => ({ publicKey: m.publicKey, callsign: m.callsign, balance: (m as any).balance ?? 0 })));
        }).catch(() => { /* the next fetch reads them again */ });
    }, [membersOnDemand]);

    // The viewer's balance (only earnedCredit, for proposing a Decision) is a member's alone. App learns
    // membership after mount, so this waits for it and a guest never asks the node.
    useEffect(() => {
        if (!canLoadBalance || !identity || !getBalance || !readsBalance) {
            if (isMember === false) setBalanceInfo(null);
            return;
        }
        let cancelled = false;
        getBalance(identity.publicKey).then(b => { if (!cancelled) setBalanceInfo(b); }).catch(() => {});
        return () => { cancelled = true; };
    }, [identity?.publicKey, canLoadBalance, readsBalance]);

    const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file || !file.type.startsWith('image/')) return;
        // Its logo is the part of the photo the member chooses in the crop dialog, a square shown in a circle (512 px),
        // redrawn on a canvas, never the raw file: the camera's GPS and serial number stay on the device (G9a-3). The
        // photo is the last field before the button, so the form waits for it: sent sooner, the enterprise would be
        // created without the photo the member chose. Cancel there leaves the form as it was.
        const pick = ++photoPick.current;
        setPreparingPhoto(true);
        cropper.crop(file, AVATAR_PICTURE)
            .then((cropped) => {
                if (pick !== photoPick.current || !cropped) return;
                setNewPhotos([cropped]); // Single avatar
                setCreateError((shown) => (shown === t(PHOTO_WORDS.readError) ? null : shown));
            })
            .catch((err) => {
                console.warn('[ProjectsPage] Could not read the picked photo:', err);
                if (pick === photoPick.current) setCreateError(t(PHOTO_WORDS.readError));
            })
            .finally(() => {
                if (pick === photoPick.current) setPreparingPhoto(false);
            });
    };

    const submitNewEnterprise = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!identity || creating || preparingPhoto) return;
        if (!newLifecycle) {
            setCreateError(t('Choose a project or an enterprise first'));
            return;
        }
        if (!newTitle.trim()) {
            setCreateError(t('Title is required'));
            return;
        }
        if (!newDescription.trim()) {
            setCreateError(t('Purpose statement is required (docs/the-commons.md §2.1)'));
            return;
        }
        if (newLifecycle === 'bounded' && (!newGoal || Number(newGoal) <= 0)) {
            setCreateError(t('A project needs a goal in Beans'));
            return;
        }

        let deadlineAt = null;
        if (newLifecycle === 'bounded' && newDeadline) {
            deadlineAt = new Date(newDeadline).toISOString();
        }

        setCreating(true);
        setCreateError(null);
        try {
            await createEnterprise({
                name: newTitle.trim(),
                purpose: newDescription.trim(),
                description: newDescription.trim(),
                lifecycle: newLifecycle,
                goalAmount: newLifecycle === 'bounded' ? Number(newGoal) : null,
                deadlineAt,
                photos: newPhotos,
                avatar: newPhotos.length > 0 ? newPhotos[0] : undefined,
            });
            setShowNewModal(false);
            setNewTitle('');
            setNewDescription('');
            setNewGoal('');
            setNewDeadline('');
            setNewPhotos([]);
            await fetchEnterprises();
        } catch (err: any) {
            setCreateError(err.message || t('Failed to propose enterprise'));
        } finally {
            setCreating(false);
        }
    };

    const fetchGroups = useCallback(async () => {
        setLoadingGroups(true);
        try {
            const list = await getGroups();
            setGroups(Array.isArray(list) ? list : []);
        } catch (e) {
            console.warn('[ProjectsPage] Failed to fetch groups:', e);
        } finally {
            setLoadingGroups(false);
        }
    }, []);

    useEffect(() => {
        if (activeSection === 'groups') {
            fetchGroups();
        }
    }, [activeSection, fetchGroups]);

    const yourKeptEnterprises = useMemo(() => {
        if (!identity?.publicKey) return [];
        const myPk = identity.publicKey;
        const list = treasuries.filter(t => t.keepers?.some(k => (k.publicKey || k.pubkey) === myPk));
        list.sort((a, b) => {
            const aLead = a.keepers?.some(k => (k.publicKey || k.pubkey) === myPk && k.role === 'lead');
            const bLead = b.keepers?.some(k => (k.publicKey || k.pubkey) === myPk && k.role === 'lead');
            if (aLead !== bLead) return aLead ? -1 : 1;
            return (a.name ?? '').localeCompare(b.name ?? '');
        });
        return list;
    }, [treasuries, identity?.publicKey]);

    const yourKeptPubkeys = useMemo(() => new Set(yourKeptEnterprises.map(t => t.publicKey)), [yourKeptEnterprises]);

    const yourGroups = useMemo(() => {
        if (!identity?.publicKey) return [];
        const list = groups.filter(g => g.viewerRole || g.viewerStatus === 'active');
        list.sort((a, b) => {
            const aConv = a.viewerRole === 'convenor';
            const bConv = b.viewerRole === 'convenor';
            if (aConv !== bConv) return aConv ? -1 : 1;
            return (a.name ?? '').localeCompare(b.name ?? '');
        });
        return list;
    }, [groups, identity?.publicKey]);

    const yourGroupIds = useMemo(() => new Set(yourGroups.map(g => g.id)), [yourGroups]);

    const filteredGroups = useMemo(() => {
        return groups.filter(g => !yourGroupIds.has(g.id));
    }, [groups, yourGroupIds]);

    const filteredEnterprises = useMemo(() => {
        let list = treasuries.filter(t => !yourKeptPubkeys.has(t.publicKey));
        if (filter === 'ongoing') {
            list = list.filter(t => t.lifecycle !== 'bounded' && (!t.goalAmount || t.goalAmount <= 0));
        } else if (filter === 'bounded') {
            list = list.filter(t => t.lifecycle === 'bounded' || (t.goalAmount != null && t.goalAmount > 0));
        }
        return list;
    }, [treasuries, filter, yourKeptPubkeys]);

    // In preview the two tabs hold very different lengths (the sample's cards on Groups only): a switch starts the new tab
    // at its top, or Decide would open far above the screen. A local node keeps its place as before.
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const previewTabs = enterprisesMode === 'preview';
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!previewTabs || !el) return;
        if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0 });
        else el.scrollTop = 0;
    }, [activeSection, previewTabs]);

    const headingInfo = commonsHeading(communityInfo?.features);
    const findHeadingLine = { text: findHeading(groupCategoryFilter, communityInfo?.features) };
    const emptyYoursLine = { text: yoursEmpty(communityInfo?.features) };

    return (
        <div ref={scrollContainerRef} className="flex flex-col h-full relative" style={{ overflowY: 'auto', overflowX: 'hidden', paddingBottom: 'var(--bottom-nav-offset)' }}>
            {/* Header — scrolls away with the list. Only the section switcher below stays pinned:
                on a 640px-tall phone at 1.3x text, a fully sticky header left ~29px for the list.
                No ground of its own, nor the two rows under it: the screen sits on the doodle wallpaper
                like Home and the Market (index.css "Doodle wallpaper"); the cards keep their fills. */}
            <header className="px-4 pt-4 pb-3 flex flex-col gap-3">
                {/* min-w-0 and break-words: a longer language's title and button wrap where they are, never off a 320 px screen.
                    The button is not min-w-0 (max 50 %, so a longer language's word still breaks), and the row has no gap
                    beside it, as before: English's "Commons" and "Propose" both stay whole at 320 px with 1.3x text. */}
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full flex justify-between items-center">
                    <div className="min-w-0">
                        <h1 className="text-xl font-bold text-nature-950 dark:text-white tracking-tight flex items-center gap-2">
                            <span className="min-w-0 break-words">{t(headingInfo.title)}</span>
                        </h1>
                        <p className="text-nature-700 dark:text-nature-300 text-sm mt-0.5">{t(headingInfo.description)}</p>
                    </div>
                    {identity && (
                        <button
                            ref={startButtonRef}
                            onClick={() => setShowStartSomething(true)}
                            className="max-w-[50%] break-words leading-tight bg-bp-sage-fill hover:bg-bp-sage-hover text-bp-sage-on px-4 py-2 rounded-xl font-bold text-sm shadow-md transition-all active:scale-95"
                        >
                            <span aria-hidden="true">＋ </span>{t('Start something')}
                        </button>
                    )}
                </div>

                {toolsHere && onNavigate && (
                    <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full min-w-0 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900">
                        <ToolRow icon="🧰" title={t('Tools')} state={t('Things you can do on your own')} onClick={() => onNavigate('tools')} testId="commons-tools-row" />
                    </div>
                )}

                {/* Enterprises off here and the node shows previews: Example Valley's, under the strip; Groups below stay real.
                    Drawn only on the Groups tab (where the enterprise list lives on a local node), so Decide opens at its own content. */}
                {enterprisesMode === 'preview' && activeSection === 'groups' && (
                    <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full bg-white dark:bg-nature-900 rounded-2xl p-3">
                        <CommonsPreview enterprises={true} onOpenEnterprise={onOpenTreasury} onNearYou={onNavigate ? () => onNavigate('home') : undefined} onGuide={onNavigate ? (slug) => onNavigate('guide', slug) : undefined} />
                    </div>
                )}
                {/* Commons Pool & Available Governance Credits */}
                {(enterprisesMode !== 'preview' || showsOwnVoiceCredits) && (
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full grid grid-cols-2 gap-3 pt-1">
                    {enterprisesMode !== 'preview' && (
                        <div className={`bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3 ${!showsOwnVoiceCredits ? 'col-span-2' : ''}`}>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-nature-600 dark:text-nature-300">
                                {t('Commons Pool')}
                            </div>
                            <div className="text-base sm:text-lg font-black text-nature-950 dark:text-white mt-1 truncate">
                                {formatNumber(balanceInfo ? Number(balanceInfo.commonsBalance ?? balanceInfo.commons ?? 0) : 0, 2)} 🫘
                            </div>
                        </div>
                    )}
                    {showsOwnVoiceCredits && (
                        <div className={`bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3 ${enterprisesMode === 'preview' ? 'col-span-2' : ''}`} data-testid="voice-credits-card">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-nature-600 dark:text-nature-300">
                                {t('Voice credits for money votes')}
                            </div>
                            <div className="text-base sm:text-lg font-black text-nature-950 dark:text-white mt-1 truncate">
                                {Math.floor(myPoolVoting?.voiceCredits ?? 0)}
                            </div>
                            <div className="text-[10px] text-nature-600 dark:text-nature-300 mt-0.5 leading-snug">
                                {myPoolVoting && !myPoolVoting.hasCompletedTrade
                                    ? t('Opens after your first completed trade')
                                    : t('From completed trades · N votes cost N×N')}
                            </div>
                        </div>
                    )}
                </div>
                )}
            </header>

            {/* Section Switcher: Decide vs Groups — the one sticky row, where Decide is available (live or preview). */}
            {hasDecide && (
            <div className="sticky top-0 z-40 px-4 py-2" data-testid="commons-section-tabs">
                {/* Emoji over label below `sm`: side by side, the three tabs need ~400px and pushed
                    Groups off a 320px screen at 1.3x text. */}
                <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full flex bg-nature-950 p-1 rounded-xl border border-nature-800">
                    {SECTION_TABS.map(tab => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveSection(tab.key)}
                            className={`flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-3 rounded-lg text-xs sm:text-sm font-bold flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-2 transition-colors ${
                                activeSection === tab.key
                                    ? 'bg-nature-800 text-white shadow-sm'
                                    : 'text-nature-400 hover:text-white'
                            }`}
                        >
                            <span className="flex items-center gap-1">
                                <span>{tab.emoji}</span>
                                {tab.key === 'decide' && openDecisionsCount > 0 && (
                                    <span className="bg-bp-accent-fill text-bp-accent-on text-xs px-1.5 sm:px-2 py-0.5 rounded-full font-bold leading-none">
                                        {openDecisionsCount}
                                    </span>
                                )}
                            </span>
                            <span className="leading-tight">{t(tab.label)}</span>
                        </button>
                    ))}
                </div>
            </div>
            )}

            {activeSection === 'decide' ? (
                <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full">
                    <DecideSection
                        decisions={effectiveDecisions}
                        myPoolVoting={effectiveMyPoolVoting}
                        identity={identity}
                        commonsBalance={effectiveCommonsBalance}
                        onRefresh={fetchEnterprises}
                        onOpenPropose={() => {
                            if (!canProposeDecision) {
                                alert(beansOn
                                    ? t('You can propose a Decision once you have completed a trade.')
                                    : t('Node admins propose here.'));
                                return;
                            }
                            if (hasOpenDecision) {
                                alert(t('You already have an open decision (limit 1 open decision per author).'));
                                return;
                            }
                            setShowProposeDecision(true);
                        }}
                        canPropose={canProposeDecision}
                        hasOpenDecision={hasOpenDecision}
                        activeView={activeDecideView}
                        onChangeView={setActiveDecideView}
                        preview={decisionsMode === 'preview'}
                        onNearYou={onNavigate ? () => onNavigate('home') : undefined}
                        onGuide={onNavigate ? (slug) => onNavigate('guide', slug) : undefined}
                    />
                </div>
            ) : (
                <>
                {/* Block 1: Yours */}
                <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full" data-testid="commons-yours">
                    <div className="text-xs font-black uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-3">
                        {t('Yours')}
                    </div>
                    {yourKeptEnterprises.length > 0 || yourGroups.length > 0 ? (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
                            {yourKeptEnterprises.map(e => {
                                const myKeeper = e.keepers?.find(k => (k.publicKey || k.pubkey) === identity?.publicKey);
                                const isProject = e.lifecycle === 'bounded' || (e.goalAmount != null && e.goalAmount > 0);
                                const isLead = myKeeper?.role === 'lead';
                                const roleWord = isProject
                                    ? (isLead ? t('Leader', undefined, 'project role') : t('Collaborator', undefined, 'project role'))
                                    : (isLead ? t('Lead keeper', undefined, 'enterprise role') : t('Keeper', undefined, 'enterprise role'));
                                const kindWord = isProject ? t('Project') : t('Enterprise');
                                const isFunded = isProject && e.goalAmount != null && e.goalAmount > 0 && (e.currentAmount ?? e.balance ?? 0) >= e.goalAmount;
                                const offersText = tn(e.liveOffers || 0, '{n} live offer', '{n} live offers');
                                const line2 = isProject
                                    ? t('{raised} of {goal} 🫘 raised', {
                                        raised: formatNumber(e.currentAmount ?? e.balance ?? 0),
                                        goal: formatNumber(e.goalAmount ?? 0),
                                    })
                                    : t('Balance {amount} 🫘 · {offers}', {
                                        amount: formatNumber(e.balance || 0),
                                        offers: offersText,
                                    });

                                return (
                                    <div
                                        key={e.publicKey}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={t('View details for {name}', { name: e.name })}
                                        onClick={() => onOpenTreasury?.(e.publicKey)}
                                        onKeyDown={(ev) => {
                                            if (ev.key === 'Enter' || ev.key === ' ') {
                                                ev.preventDefault();
                                                onOpenTreasury?.(e.publicKey);
                                            }
                                        }}
                                        className="p-4 bg-white dark:bg-nature-950/70 hover:bg-oat-50 dark:hover:bg-nature-900/80 border border-nature-200 dark:border-nature-800 rounded-2xl cursor-pointer transition-all space-y-3 flex flex-col justify-between focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                    >
                                        <div>
                                            <div className="flex items-start gap-3">
                                                <div className="w-11 h-11 rounded-xl bg-nature-100 dark:bg-nature-800 flex items-center justify-center shrink-0 overflow-hidden text-xl">
                                                    {e.avatar || e.avatarUrl ? (
                                                        <img src={resolveAvatarUrl(e.avatar || e.avatarUrl) || ''} alt="" className="w-full h-full object-cover" />
                                                    ) : (
                                                        <span>{isProject ? '🎯' : '🥖'}</span>
                                                    )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <h4 className="font-extrabold text-base text-nature-950 dark:text-white truncate">{e.name}</h4>
                                                    <div className="flex items-center gap-1.5 flex-wrap mt-1">
                                                        {e.paused ? (
                                                            <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-bp-chip-warn-tint text-bp-chip-warn-ink border border-transparent">
                                                                {t('⏸️ PAUSED')}
                                                            </span>
                                                        ) : e.status === 'winding_up' ? (
                                                            <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-bp-chip-danger-tint text-bp-chip-danger-ink border border-transparent">
                                                                {t('⏳ WINDING UP')}
                                                            </span>
                                                        ) : e.status === 'completed' || e.status === 'closed' ? (
                                                            <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-nature-800 text-nature-300 border border-transparent">
                                                                {t('CLOSED')}
                                                            </span>
                                                        ) : null}
                                                        {isFunded && (
                                                            <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-bp-chip-ok-tint text-bp-chip-ok-ink border border-transparent">
                                                                {t('🎉 FUNDED')}
                                                            </span>
                                                        )}
                                                        <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-nature-800 text-nature-300">
                                                            {kindWord}
                                                        </span>
                                                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider ${
                                                            isLead ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink' : 'bg-nature-800 text-nature-300'
                                                        }`}>
                                                            {roleWord}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="text-xs text-nature-600 dark:text-nature-400 mt-2">
                                                {line2}
                                            </div>
                                        </div>
                                        <div className="flex justify-end pt-2 border-t border-nature-100 dark:border-nature-900">
                                            <button
                                                type="button"
                                                aria-label={t('Manage {name}', { name: e.name })}
                                                onClick={(ev) => {
                                                    ev.stopPropagation();
                                                    onOpenTreasury?.(e.publicKey, 'manage');
                                                }}
                                                className="text-xs font-bold text-emerald-700 dark:text-emerald-400 hover:underline min-h-[44px] min-w-[44px] flex items-center justify-center"
                                            >
                                                {t('Manage ›')}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                            {yourGroups.map(g => (
                                <div
                                    key={g.id}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={t('View details for group {name}', { name: g.name })}
                                    onClick={() => {
                                        if (onNavigate) onNavigate('messages', g.id);
                                        else setSelectedGroupForDetail(g);
                                    }}
                                    onKeyDown={(ev) => {
                                        if (ev.key === 'Enter' || ev.key === ' ') {
                                            ev.preventDefault();
                                            if (onNavigate) onNavigate('messages', g.id);
                                            else setSelectedGroupForDetail(g);
                                        }
                                    }}
                                    className="p-4 bg-white dark:bg-nature-950/70 hover:bg-oat-50 dark:hover:bg-nature-900/80 border border-nature-200 dark:border-nature-800 rounded-2xl cursor-pointer transition-all space-y-3 flex flex-col justify-between focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                >
                                    <div>
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <h4 className="font-extrabold text-base text-nature-950 dark:text-white truncate">{g.name}</h4>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className="text-[11px] font-bold text-nature-600 dark:text-nature-400 capitalize">
                                                        🏷️ {named(CATEGORY_WORDS, g.category, g.category.replace(/_/g, ' '))}
                                                    </span>
                                                    <span className="text-nature-600 dark:text-nature-400">•</span>
                                                    <span className="text-[11px] text-nature-600 dark:text-nature-400">
                                                        {tn(g.memberCount || 0, '{n} member', '{n} members')}
                                                    </span>
                                                </div>
                                            </div>
                                            {g.viewerRole && (
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                                                    g.viewerRole === 'convenor'
                                                        ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                                                        : 'bg-nature-800 text-nature-300'
                                                }`}>
                                                    {named(ROLE_WORDS, g.viewerRole, g.viewerRole)}
                                                </span>
                                            )}
                                        </div>
                                        {g.description && (
                                            <p className="text-xs text-nature-700 dark:text-nature-300 line-clamp-2 leading-relaxed mt-2">
                                                {g.description}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex items-center justify-between pt-1 border-t border-nature-100 dark:border-nature-900 text-[11px] text-nature-600 dark:text-nature-400">
                                        <span>{t('Join: {policy}', { policy: named(JOIN_POLICY_WORDS, g.joinPolicy, g.joinPolicy?.replace(/_/g, ' ') || '') })}</span>
                                        <span className="text-emerald-700 dark:text-emerald-500 font-bold hover:underline">{t('Open chat →')}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-nature-600 dark:text-nature-400">
                            {t(emptyYoursLine.text)}
                        </p>
                    )}
                </div>

                {/* Block 2: Find heading */}
                <div className="px-4 pt-2 max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full">
                    <h2 className="text-sm font-black uppercase tracking-wider text-nature-700 dark:text-nature-300">
                        {t(findHeadingLine.text)}
                    </h2>
                </div>

                {/* Block 3: Filters / Chips */}
                <div className="px-4 pb-3 empty:hidden" data-testid="commons-filters">
                    <div className="max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full flex items-center justify-between gap-2 pt-1">
                        <div className="min-w-0 flex gap-2 overflow-x-auto py-1 scrollbar-none" data-testid="group-filter-chips">
                            {GROUP_CHIPS.filter(option => !enterprisesPreview || (option.key !== 'projects' && option.key !== 'enterprises')).map(option => (
                                <button
                                    key={option.key}
                                    onClick={() => setGroupCategoryFilter(option.key)}
                                    className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
                                        groupCategoryFilter === option.key
                                            ? 'bg-bp-commit-fill text-bp-commit-on shadow-sm'
                                            : 'bg-nature-800 text-nature-300 hover:bg-nature-700'
                                    }`}
                                >
                                    {t(option.label)}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {showChatGroups && (
                <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full space-y-4" data-testid="commons-chat-groups">

                    {loadingGroups ? (
                        <div className="py-12 text-center text-sm text-nature-600 dark:text-nature-400">{t('Loading groups...')}</div>
                    ) : filteredGroups.length === 0 ? (
                        <div className="text-center py-16 px-4 bg-white dark:bg-nature-950/40 rounded-2xl border border-nature-200 dark:border-nature-800/80">
                            <div className="text-4xl mb-3">👥</div>
                            <h3 className="text-base font-bold text-nature-950 dark:text-white mb-1">{t('No groups found')}</h3>
                            <p className="text-xs text-nature-600 dark:text-nature-400 max-w-xs mx-auto mb-4">
                                {t('Start a working group, guild, or team to coordinate discussions.')}
                            </p>
                            <button
                                onClick={() => setShowCreateGroupModal(true)}
                                className="px-4 py-2 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-xs font-bold transition-colors"
                            >
                                {t('+ Create a Group')}
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {filteredGroups.map(g => (
                                <div
                                    key={g.id}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={t('View details for group {name}', { name: g.name })}
                                    onClick={() => setSelectedGroupForDetail(g)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            setSelectedGroupForDetail(g);
                                        }
                                    }}
                                    className="p-4 bg-white dark:bg-nature-950/70 hover:bg-oat-50 dark:hover:bg-nature-900/80 border border-nature-200 dark:border-nature-800 hover:border-nature-300 dark:hover:border-nature-700 rounded-2xl cursor-pointer transition-all space-y-3 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <h4 className="font-extrabold text-base text-nature-950 dark:text-white truncate">{g.name}</h4>
                                            <div className="flex items-center gap-2 mt-1">
                                                <span className="text-[11px] font-bold text-nature-600 dark:text-nature-400 capitalize">
                                                    🏷️ {named(CATEGORY_WORDS, g.category, g.category.replace(/_/g, ' '))}
                                                </span>
                                                <span className="text-nature-600 dark:text-nature-400">•</span>
                                                <span className="text-[11px] text-nature-600 dark:text-nature-400">
                                                    {tn(g.memberCount || 0, '{n} member', '{n} members')}
                                                </span>
                                            </div>
                                        </div>
                                        {g.viewerStatus === 'invited' ? (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-bp-chip-ok-tint text-bp-chip-ok-ink">
                                                {t('INVITED')}
                                            </span>
                                        ) : g.viewerRole ? (
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                                                g.viewerRole === 'convenor'
                                                    ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                                                    : 'bg-nature-800 text-nature-300'
                                            }`}>
                                                {named(ROLE_WORDS, g.viewerRole, g.viewerRole)}
                                            </span>
                                        ) : g.viewerStatus === 'pending_approval' ? (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-bp-chip-warn-tint text-bp-chip-warn-ink">
                                                {t('Pending', undefined, 'join request')}
                                            </span>
                                        ) : null}
                                    </div>

                                    {g.description && (
                                        <p className="text-xs text-nature-700 dark:text-nature-300 line-clamp-2 leading-relaxed">
                                            {g.description}
                                        </p>
                                    )}

                                    <div className="flex items-center justify-between pt-1 border-t border-nature-100 dark:border-nature-900 text-[11px] text-nature-600 dark:text-nature-400">
                                        <span>{t('Join: {policy}', { policy: named(JOIN_POLICY_WORDS, g.joinPolicy, g.joinPolicy.replace(/_/g, ' ')) })}</span>
                                        <span className="text-emerald-700 dark:text-emerald-500 font-bold hover:underline">{t('View Details →')}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                )}
                {!showEnterprises ? null : loading ? (
                <div className="p-8 text-center text-nature-600 dark:text-nature-500">{t('Loading enterprises…')}</div>
                ) : error ? (
                    <div className="p-8 text-center text-red-700 dark:text-red-500">{error}</div>
                ) : filteredEnterprises.length === 0 ? (
                    // Beans off (the global node): no enterprise can be proposed here, and the preview above already says
                    // what a local community's Commons holds, so no empty state offering one.
                    !beansOn ? null : (
                    <div className="p-8 text-center text-nature-500 max-w-md mx-auto my-12">
                        <p className="text-4xl opacity-50 mb-3">🌱</p>
                        <p className="text-base font-bold text-nature-950 dark:text-white mb-1">{t('No enterprises found')}</p>
                        <p className="text-sm text-nature-600 dark:text-nature-400 mb-6">
                            {t('Got an idea that benefits the community? Start an enterprise or propose a project to get started.')}
                        </p>
                        {identity && (
                            <button
                                onClick={() => {
                                    setNewLifecycle(groupCategoryFilter === 'enterprises' ? 'ongoing' : 'bounded');
                                    setShowNewModal(true);
                                    setCreateError(null);
                                }}
                                className="bg-bp-sage-fill hover:bg-bp-sage-hover text-bp-sage-on px-5 py-2.5 rounded-xl font-bold text-sm shadow-md"
                            >
                                {groupCategoryFilter === 'enterprises' ? t('Start an enterprise') : groupCategoryFilter === 'projects' ? t('Start a project') : t('+ Propose a Project')}
                            </button>
                        )}
                    </div>
                    )
                ) : (
                    <div className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
                        {filteredEnterprises.map(t => <EnterpriseCard key={t.publicKey} treasury={t} onOpen={onOpenTreasury} />)}
                </div>
                )}
                </>
            )}

            {/* Propose Enterprise / Project Modal */}
            {showNewModal && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                    onClick={() => setShowNewModal(false)}
                    style={{ overflowY: 'auto', paddingBottom: 'calc(var(--bottom-nav-offset) + 2rem)' }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="propose-modal-title"
                        onClick={(e) => e.stopPropagation()}
                        className="bg-nature-900 border border-nature-800 rounded-2xl p-6 w-full max-w-lg shadow-xl space-y-4 animate-in zoom-in-95 duration-200 text-white max-h-[90vh] overflow-y-auto"
                        style={{ paddingBottom: 'calc(var(--bottom-nav-offset) + 1.5rem)' }}
                    >
                        <div className="flex justify-between items-center">
                            <h2 id="propose-modal-title" className="text-lg font-black text-white">
                                {newLifecycle === 'bounded'
                                    ? t('Start a project')
                                    : newLifecycle === 'ongoing'
                                    ? t('Start an enterprise')
                                    : t('Start a project or an enterprise')}
                            </h2>
                            <button
                                type="button"
                                aria-label={t('Close dialog')}
                                onClick={() => setShowNewModal(false)}
                                className="text-nature-400 hover:text-white text-lg font-bold min-w-[44px] min-h-[44px] flex items-center justify-center -mr-2"
                            >
                                ✕
                            </button>
                        </div>

                        {createError && (
                            <div className="p-3 bg-red-950/40 border border-red-800 text-red-300 rounded-xl text-xs font-semibold">
                                {createError}
                            </div>
                        )}

                        <form onSubmit={submitNewEnterprise} className="space-y-4">
                            {/* Lifecycle choice: Bounded Project vs Ongoing Enterprise */}
                            <div>
                                <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-2">
                                    {t('Initiative Type')}
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        aria-pressed={newLifecycle === 'bounded'}
                                        onClick={() => setNewLifecycle('bounded')}
                                        className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all text-left flex flex-col gap-0.5 ${
                                            newLifecycle === 'bounded'
                                                ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                                                : 'bg-nature-800/60 border-nature-700 text-nature-400 hover:text-white'
                                        }`}
                                    >
                                        <span>{t('🌱 Project')}</span>
                                        <span className="text-[10px] font-normal opacity-80">{t('A leader, a goal, an end date')}</span>
                                    </button>
                                    <button
                                        type="button"
                                        aria-pressed={newLifecycle === 'ongoing'}
                                        onClick={() => setNewLifecycle('ongoing')}
                                        className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all text-left flex flex-col gap-0.5 ${
                                            newLifecycle === 'ongoing'
                                                ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                                                : 'bg-nature-800/60 border-nature-700 text-nature-400 hover:text-white'
                                        }`}
                                    >
                                        <span>{t('🏛️ Enterprise')}</span>
                                        <span className="text-[10px] font-normal opacity-80">{t('Keepers; it keeps going')}</span>
                                    </button>
                                </div>
                            </div>

                            {/* Title */}
                            <div>
                                <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                    {t('Name / Title')}
                                </label>
                                <input
                                    type="text"
                                    required
                                    placeholder={t('e.g. Community Tool Shed or Shade House')}
                                    value={newTitle}
                                    onChange={(e) => setNewTitle(e.target.value)}
                                    className="w-full bg-nature-800 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            {/* Purpose Statement (required per docs §2.1) */}
                            <div>
                                <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                    {t('Purpose Statement')} <span className="text-emerald-400">*</span>
                                </label>
                                <textarea
                                    required
                                    rows={3}
                                    placeholder={t("State clearly what this enterprise exists to do (e.g. 'We build and maintain a communal shade house by November')")}
                                    value={newDescription}
                                    onChange={(e) => setNewDescription(e.target.value)}
                                    className="w-full bg-nature-800 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            {/* Bounded Project Fields: Goal & Deadline */}
                            {newLifecycle === 'bounded' && (
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                            {t('Goal Amount (🫘 Beans)')}
                                        </label>
                                        <input
                                            type="number"
                                            required
                                            min="1"
                                            step="1"
                                            placeholder={t('e.g. {amount}', { amount: 500 })}
                                            value={newGoal}
                                            onChange={(e) => setNewGoal(e.target.value === '' ? '' : Number(e.target.value))}
                                            className="w-full bg-nature-800 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                            {t('Deadline (Optional)')}
                                        </label>
                                        <input
                                            type="date"
                                            min={localToday()}
                                            value={newDeadline}
                                            onChange={(e) => setNewDeadline(e.target.value)}
                                            className="w-full bg-nature-800 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Its logo, the one picture made with it (its avatar). Its banner is its shop's photo, which a keeper
                                chooses later in Manage (Marty, 24 Oct 2026: "avatar and cover photo are different"). */}
                            <div>
                                <label htmlFor="propose-logo" className="block text-xs font-bold text-nature-400 uppercase tracking-wider mb-1">
                                    {t('Logo (optional)')}
                                </label>
                                <p className="m-0 mb-1 text-xs text-nature-400">{t('Its banner photo is chosen later, in Manage.')}</p>
                                <input
                                    id="propose-logo"
                                    type="file"
                                    accept="image/*"
                                    onChange={handlePhotoUpload}
                                    className="text-xs text-nature-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-nature-800 file:text-nature-200 hover:file:bg-nature-700 cursor-pointer"
                                />
                                {newPhotos.length > 0 && (
                                    <div className="mt-2 flex items-center gap-2">
                                        <img src={resolveAvatarUrl(newPhotos[0]) || ''} alt={t('Preview')} className="w-12 h-12 rounded-full object-cover border border-nature-700" />
                                        <button
                                            type="button"
                                            onClick={() => setNewPhotos([])}
                                            className="text-xs text-red-400 hover:underline"
                                        >
                                            {t('Remove photo')}
                                        </button>
                                    </div>
                                )}
                                <AvatarPresetPicker
                                    selected={newPhotos[0]}
                                    headingClassName="text-nature-400"
                                    onSelect={(uri) => {
                                        // A photo still being read must not land over the preset chosen after it, nor open its crop.
                                        photoPick.current++;
                                        cropper.cancel();
                                        setPreparingPhoto(false);
                                        setNewPhotos([uri]);
                                    }}
                                />
                                {cropper.dialog}
                            </div>

                            <div className="flex gap-3 pt-3">
                                <button
                                    type="button"
                                    onClick={() => setShowNewModal(false)}
                                    className="flex-1 py-2.5 rounded-xl border border-nature-700 text-nature-300 font-bold text-sm hover:bg-nature-800"
                                >
                                    {t('Cancel')}
                                </button>
                                <button
                                    type="submit"
                                    disabled={creating || preparingPhoto || !newLifecycle}
                                    className="flex-1 py-2.5 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-sm disabled:opacity-50"
                                >
                                    {creating
                                        ? t('Submitting…')
                                        : preparingPhoto
                                        ? t('Preparing photo…')
                                        : !newLifecycle
                                        ? t('Choose a project or an enterprise first')
                                        : newLifecycle === 'bounded'
                                        ? t('Start the project 🌱')
                                        : t('Start the enterprise 🏛️')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {votes && (
                <ProposeDecisionModal
                    isOpen={showProposeDecision}
                    onClose={() => setShowProposeDecision(false)}
                    onCreated={fetchEnterprises}
                    identity={identity}
                    commonsBalance={commonsBalance}
                    treasuries={treasuries}
                    members={allMembersList}
                />
            )}

            <CreateGroupModal
                isOpen={showCreateGroupModal}
                onClose={() => setShowCreateGroupModal(false)}
                onCreated={() => fetchGroups()}
                onStartWithBeans={!beansOn ? undefined : () => {
                    setShowCreateGroupModal(false);
                    setNewLifecycle('');
                    setShowNewModal(true);
                    setCreateError(null);
                }}
            />

            <StartSomethingDialog
                isOpen={showStartSomething}
                onClose={() => setShowStartSomething(false)}
                onPick={handlePickStartRow}
                features={{ beans: beansOn, enterprises: enterprisesMode === 'live' || (modesUnknown && beansOn), decisions: votes }}
                canPropose={canProposeDecision}
                decisionsPreview={decisionsMode === 'preview'}
                enterprisesPreview={enterprisesMode === 'preview'}
            />

            {decisionsMode === 'preview' && showDecisionsSheet && (
                <LocalCommunitySheet
                    feature="decisions"
                    returnFocus={() => startButtonRef.current}
                    onClose={() => setShowDecisionsSheet(false)}
                    onStart={() => {
                        setShowDecisionsSheet(false);
                        setShowStartCommunity(true);
                    }}
                    onNearYou={onNavigate ? () => onNavigate('home') : undefined}
                    onGuide={onNavigate ? (slug) => onNavigate('guide', slug) : undefined}
                />
            )}

            {showStartCommunity && (
                <StartCommunityScreen
                    returnFocus={() => startButtonRef.current}
                    onClose={() => setShowStartCommunity(false)}
                    onNearYou={onNavigate ? () => onNavigate('home') : undefined}
                />
            )}

            <GroupDetailModal
                group={selectedGroupForDetail}
                isOpen={!!selectedGroupForDetail}
                onClose={() => setSelectedGroupForDetail(null)}
                myPubkey={identity?.publicKey}
                onMembershipChanged={() => fetchGroups()}
                onPostToGroup={(group) => {
                    setSelectedGroupForDetail(null);
                    onNavigate?.('map-post', group.id);
                }}
            />
        </div>
    );
}
