# Interaction Parity Audit: React Native vs. Web PWA

## Executive Summary & Methodology

This audit evaluates the interaction behavior between BeanPool's reference React Native client (`apps/native`, Expo SDK 55) and the Web Progressive Web App (`apps/pwa/src`, React 19).

Rather than comparing static feature checklists, this audit focuses strictly on **interaction behavior**: what happens when a member touches, clicks, long-presses, drags, navigates, uses keyboard inputs, or presses browser/hardware back buttons.

### Explicitly Excluded (Architectural Decisions)
As established in project architecture, the following deliberate decisions are acknowledged and **not** classified as parity gaps:
- No multi-node switching on PWA (fixed relative `/api/` calls).
- No PWA-to-native QR identity pairing.
- No PIN / biometric / WebAuthn gate on web client.
- No service worker and no web push notifications.
- Pulse creator OAuth linking (TikTok/Instagram) is phone-only.
- Post photo tap-to-zoom on web is a known work-in-progress on another branch.

---

## 1. Marketplace List and Post Detail

| Element or gesture | Native behaviour (`apps/native`) | PWA behaviour (`apps/pwa/src`) | Verdict |
| :--- | :--- | :--- | :--- |
| **Feed post card tap** | `index.tsx:1120-1127`<br>`router.push({ pathname: '/post/[id]', params: ... })` pushes detail route to Expo Router stack. | `MarketplacePage.tsx:2079`<br>`onClick={() => setSelectedPost(post)}` swaps local state; unmounts the feed view entirely (`MarketplacePage.tsx:505`). | `divergent` |
| **Detail back button** | `post/[id].tsx:734-739`<br>`onPress={() => router.back()}` pops current screen from navigation stack. | `MarketplacePage.tsx:516-522`<br>`onClick={() => { setSelectedPost(null); setIsEditingPost(false); }}` clears state. | `divergent` |
| **Browser / Hardware back button** | Edge swipe or system back pops route cleanly back to marketplace feed, preserving scroll. | Triggers browser history navigation: leaves BeanPool or closes tab because `selectedPost` does not push history state. | `native-only` |
| **Escape key on post detail** | N/A (mobile OS platform). | No `onKeyDown` listener attached to window or modal container; `Escape` does nothing. | `native-only` |
| **Scroll restoration on return** | Native `FlatList` remains mounted in background; returning preserves exact scroll offset. | Feed was completely unmounted (`MarketplacePage.tsx:505`); returning resets scroll position to the top (`0px`). | `native-only` |
| **Post photo gallery / swipe** | `PhotoCarousel.tsx:47-66`<br>Horizontal paging `FlatList` with swipe gestures, pagination dots, and photo index badge. | `MarketplacePage.tsx:603-611`<br>Plain horizontal CSS scrollable `overflow-x-auto` div with `<img>` elements. | `divergent` |
| **Post photo tap / zoom** | `post/[id].tsx:720-726`<br>Tapping photo opens full-screen interactive `ImageViewer` modal (`visible={imageViewerVisible}`). | Tap-to-zoom known in progress on another branch (plain `<img>` currently). | `divergent` |
| **Author avatar / callsign tap (Feed card)** | `PostAuthorTrust.tsx:54-61`<br>`onPress={() => router.push({ pathname: '/public-profile', params: ... })}` | `PostAuthorTrust.tsx:50-59`<br>`onClick={(e) => { e.stopPropagation(); onOpenProfile(pubkey); }}` | `parity` |
| **Author avatar / callsign tap (Detail)** | `post/[id].tsx:889-897`<br>`onPress={() => router.push({ pathname: '/public-profile', params: ... })}` | `MarketplacePage.tsx:668-675`<br>`onClick={() => onOpenProfile(post.creator_pubkey)}` | `parity` |
| **"Deal" / Contact button** | `post/[id].tsx:813-820`<br>`onPress={() => router.push({ pathname: '/chat/[id]', params: ... })}` opens dedicated chat route. | `MarketplacePage.tsx:641-653`<br>`onClick={() => onOpenChat(post.creator_pubkey, post.id)}` switches tab and conversation. | `parity` |
| **Share post** | `post/[id].tsx:740-753`<br>`Share.share({ message: ... })` opens native share sheet. | `MarketplacePage.tsx:524-541`<br>`navigator.clipboard.writeText(...)` copies permalink URL and displays a toast. | `parity` |
| **Edit post (owner)** | `post/[id].tsx:754-762`<br>`onPress={() => router.push({ pathname: '/edit-post', params: ... })}` opens standalone edit screen. | `MarketplacePage.tsx:542-549`<br>`onClick={() => setIsEditingPost(true)}` renders inline edit form in place. | `divergent` |
| **Delete post (owner)** | `post/[id].tsx:763-780`<br>`Alert.alert` confirmation with destructive action before calling `deleteOfferApi`. | `MarketplacePage.tsx:550-565`<br>`window.confirm` modal before calling `request('POST', '/api/offers/delete')`. | `parity` |
| **Block user from detail** | `post/[id].tsx:1505-1548`<br>"🚫 Block User" button with confirmation `Alert.alert` and `blockMemberApi` call. | Missing entirely from post detail view. Member must navigate to People directory to block. | `native-only` |
| **Report post** | `post/[id].tsx:1450-1490`<br>"🚩 Report" button toggles embedded report form with category and justification. | `MarketplacePage.tsx:1358-1399`<br>"🚩 Report" button opens modal report dialog. | `parity` |
| **Trust level dropdown / filter** | `index.tsx:1011-1033`<br>Trust filter button opens Action Sheet / picker modal: Direct (1°), Friends of Friends (2°), All. | No trust filter dropdown exists on PWA. | `native-only` |
| **Federation peer toggles** | Not present on native marketplace feed header. | `MarketplacePage.tsx:1875-1880`<br>Pill buttons toggling specific federated partner node posts. | `PWA-only` |
| **Type filters (All / Want / Offer / Service)** | `index.tsx:1434-1457`<br>Horizontal category pills updating `activeFilter` state with haptic feedback. | `MarketplacePage.tsx:1850-1873`<br>Horizontal filter buttons updating `filter` state. | `parity` |
| **Feed pull-to-refresh** | `index.tsx:1467-1473`<br>`RefreshControl` with native spinner triggers sync and re-fetch. | No pull-to-refresh gesture; member relies on browser refresh or navigation remount. | `native-only` |
| **Missing / Deleted post state** | `post/[id].tsx:607-610`<br>Displays explicit error screen: "Post not found" with a "Return to Market" button. | `MarketplacePage.tsx:209-216`<br>Silent failure: if deep-linked post ID does not exist, page silently remains on feed. | `native-only` |
| **Empty feed state actions** | `index.tsx:1519-1532`<br>Displays empty state illustration with "+ Post a Deal" and "Clear All Filters" action buttons. | `MarketplacePage.tsx:2054-2066`<br>Renders static text: "No listings in this category yet" without action buttons. | `divergent` |

---

## 2. The Map and Pin Interactions

| Element or gesture | Native behaviour (`apps/native`) | PWA behaviour (`apps/pwa/src`) | Verdict |
| :--- | :--- | :--- | :--- |
| **Map pin tap** | `map.tsx:1010-1015`<br>Tapping `UnifiedMapPin` selects pin, centers map, and displays bottom preview card. | `MapPage.tsx:327-332`<br>Clicking Leaflet pin marker selects pin and displays bottom preview card. | `parity` |
| **Bottom preview card tap** | `map.tsx:1063-1075`<br>`router.push({ pathname: '/post/[id]', params: ... })` navigates to full post detail. | `MapPage.tsx:691-698`<br>`onClick={() => onOpenPost(selectedPost.id)}` invokes navigation callback. | `parity` |
| **Preview card author tap** | `map.tsx:1081-1085`<br>`Pressable` wrapping author name navigates to `/public-profile`. | `MapPage.tsx:725-727`<br>Author is rendered as inert non-clickable `<span>` text. | `native-only` |
| **Preview card dismissal** | `map.tsx:1054, 1108`<br>Tapping map background or close button `✕` dismisses card (`setSelectedPost(null)`). | `MapPage.tsx:183, 730`<br>Clicking map background or `✕` button clears `selectedPost`. | `parity` |
| **Escape key to dismiss card** | N/A (touch OS). | No keyboard listener attached; pressing `Escape` key does not dismiss preview card. | `native-only` |
| **"Drop a Pin" interaction** | `map.tsx:1154-1175`<br>Tapping "Drop a Pin" hides composer sheet; displays dedicated bottom bar with "Cancel" and "Confirm Pin ✓". | `MapPage.tsx:743, 795-817`<br>Composer sheet remains open covering ~60% of viewport; user must click map background without confirmation bar. | `divergent` |
| **Zoom controls (+ / −)** | Touch pinch-to-zoom and double-tap zoom gestures only. | `MapPage.tsx:631-645`<br>Explicit on-screen `+` and `−` zoom buttons for mouse/touch. | `PWA-only` |
| **GPS "Locate Me" button** | Not rendered on map surface; relies on initial location fix. | `MapPage.tsx:647-672`<br>Dedicated GPS target button triggers geolocation lookup and pans map. | `PWA-only` |
| **Cluster expansion tap** | `map.tsx:480-495`<br>Tapping cluster marker calculates zoom level and smoothly animates camera to spiderfy/zoom. | Leaflet markercluster plugin handles zoom animation on click. | `parity` |

---

## 3. Chat List and Message Thread

| Element or gesture | Native behaviour (`apps/native`) | PWA behaviour (`apps/pwa/src`) | Verdict |
| :--- | :--- | :--- | :--- |
| **Open conversation** | `chats.tsx:628-634`<br>`onPress={() => router.push({ pathname: '/chat/[id]', params: ... })}` pushes route. | `MessagesPage.tsx:556-562`<br>`onClick={() => setActiveConv(conv)}` switches view state. | `divergent` |
| **Chat thread back navigation** | `chat/[id].tsx:1414-1420`<br>`Pressable` calls `router.back()`; native edge swipe pops screen. | `MessagesPage.tsx:734-740`<br>`onClick={() => setActiveConv(null)}`. Browser back button unloads BeanPool app! | `divergent` |
| **Chat header peer tap** | `chat/[id].tsx:1423-1434`<br>Tapping peer avatar or callsign in header navigates to `/public-profile`. | `MessagesPage.tsx:745-755`<br>Peer avatar and callsign are rendered inside an inert, non-clickable `<div>`. | `native-only` |
| **Chat header 3-dots action** | `chat/[id].tsx:1449`<br>Renders 3-dots icon button with **no `onPress` handler** (completely inert). | `MessagesPage.tsx:760-790`<br>Renders working "🚩 Report" and "🚫 Block/Unblock" buttons. | `PWA-only` |
| **Message bubble tap (Actions)** | `chat/[id].tsx:1233-1303`<br>Tapping message bubble toggles floating action bar (Reply, Reaction picker, Edit pencil). | `MessagesPage.tsx:1180-1255`<br>Renders persistent inline text buttons ("Reply", "React", "Edit") under every message. | `divergent` |
| **Chat image tap / enlarge** | `chat/[id].tsx:92, 1700-1705`<br>Tapping image attachment opens full-screen interactive `ImageViewer` modal. | `MessagesPage.tsx:141`<br>Renders standard `<img>`; clicking it does nothing (no zoom or viewer). | `native-only` |
| **Active deals strip in chat** | `chat/[id].tsx:1456-1490`<br>Horizontal strip of active deal cards with Release, Cancel, and Review action buttons. | `MessagesPage.tsx:816-860`<br>Renders single pending transaction banner; no direct link to the underlying post. | `divergent` |
| **Jump to quoted message** | `chat/[id].tsx:1310-1320`<br>Tapping quote header calls `FlatList.scrollToIndex` to scroll message into view. | `MessagesPage.tsx:1110-1118`<br>Calls DOM `scrollIntoView({ behavior: 'smooth' })` and triggers yellow highlight pulse. | `parity` |
| **Send message on Enter key** | Multi-line input; send button tap triggers transmission. | Multi-line text area; `Enter` sends message, `Shift+Enter` inserts line break. | `PWA-only` |
| **Audio note recording** | `chat/[id].tsx:1620-1685`<br>Hold/press microphone icon to record audio note via `expo-av`. | Not supported on web PWA (no audio recording UI). | `native-only` |

---

## 4. People Directory and Public Profile

| Element or gesture | Native behaviour (`apps/native`) | PWA behaviour (`apps/pwa/src`) | Verdict |
| :--- | :--- | :--- | :--- |
| **Member directory card tap** | `people.tsx:685-695`<br>`router.push({ pathname: '/public-profile', params: { publicKey, callsign } })`. | `PeoplePage.tsx:246`<br>`onClick={() => onSelectPeer(member)}` calls app handler `openProfilePubkey`. | `divergent` |
| **Public profile back navigation** | `public-profile.tsx:285-290`<br>`router.back()` pops stack; native edge swipe pops screen. | `PublicProfilePage.tsx:250-256`<br>`onClick={onBack}` closes overlay. Browser back button exits app! | `divergent` |
| **Escape key on public profile** | N/A (touch OS). | No keyboard listener attached; pressing `Escape` key does not close profile overlay. | `native-only` |
| **Directory tab switching** | `people.tsx:590-630`<br>Horizontal tab strip (Active, Vouched, Pending, Blocked, Friends) with haptics. | `PeoplePage.tsx:150-185`<br>Horizontal tab buttons updating local filter state. | `parity` |
| **Empty Friends tab action** | `people.tsx:735-745`<br>Displays "Browse Community" button that switches active tab to 'Active'. | `PeoplePage.tsx:205`<br>Renders static text message with no interactive action button. | `native-only` |
| **Direct message button** | `public-profile.tsx:380-395`<br>`onPress` navigates to `/chat/[id]` with peer pubkey. | `PublicProfilePage.tsx:365-380`<br>`onClick` invokes `onOpenChat(peerPubkey)`. | `parity` |
| **Vouch / Trust action** | `public-profile.tsx:415-440`<br>Interactive slider or vouch button with confirmation `Alert.alert`. | `PublicProfilePage.tsx:410-440`<br>Vouch button opening trust configuration modal. | `parity` |
| **Block / Unblock toggle** | `public-profile.tsx:445-470`<br>Block button triggers confirmation dialog and updates blocklist. | `PublicProfilePage.tsx:445-470`<br>Block button triggers confirmation modal and updates blocklist. | `parity` |
| **Channel chips tap** | `ChannelChips.tsx:55-65`<br>Tapping external channel chip executes `Linking.openURL(url)`. | `ChannelChips.tsx:50-60`<br>Tapping channel chip opens link in new tab (`target="_blank"`). | `parity` |

---

## 5. Own Profile and Settings

| Element or gesture | Native behaviour (`apps/native`) | PWA behaviour (`apps/pwa/src`) | Verdict |
| :--- | :--- | :--- | :--- |
| **Header back button in sub-modes** | Sub-sections are separate routes/screens; back button returns to the previous settings view. | `SettingsPage.tsx:469-480`<br>Top-left `← Back` **unconditionally calls `onBack`**, closing Settings entirely. | `native-only` |
| **Inline return to settings menu** | N/A (standard top navigation header used). | `SettingsPage.tsx:1576`<br>Only a small secondary button at the bottom of the page calls `setMode('menu')`. | `PWA-only` |
| **Browser back button in sub-modes** | Standard stack navigation pops sub-screen back to main settings menu. | Browser back button leaves BeanPool app or closes browser tab. | `native-only` |
| **Seed phrase view action** | `settings.tsx:410-435`<br>Requires biometric or PIN authentication before revealing secret mnemonic. | `SettingsPage.tsx:740-770`<br>Revealed directly on click (WebAuthn/PIN deliberately omitted on web). | `parity` |
| **Account export action** | `settings.tsx:580-605`<br>Exports identity payload via system sharing sheet (`Sharing.shareAsync`). | `SettingsPage.tsx:1480-1495`<br>Triggers JSON file download to browser downloads directory. | `parity` |
| **Reset account / wipe data** | `settings.tsx:610-645`<br>`Alert.alert` with destructive confirmation dialog before clearing local database. | `SettingsPage.tsx:1500-1550`<br>`window.confirm` modal before clearing localStorage and IndexedDB. | `parity` |
| **Theme toggle (Dark / Light / System)** | `settings.tsx:320-345`<br>Segmented controls toggling theme context and persisting to AsyncStorage. | `SettingsPage.tsx:520-545`<br>Segmented buttons toggling theme and persisting to localStorage. | `parity` |

---

## 6. Ledger

| Element or gesture | Native behaviour (`apps/native`) | PWA behaviour (`apps/pwa/src`) | Verdict |
| :--- | :--- | :--- | :--- |
| **Transaction row tap** | `ledger.tsx:859`<br>Transaction rows are plain non-interactive cards; tapping does nothing. | `LedgerPage.tsx:635`<br>Transaction rows are plain non-interactive rows; tapping does nothing. | `parity` |
| **Offer deep-link in transaction memo** | `ledger.tsx:843-849`<br>Regex parses UUID from memo; renders clickable "View Offer" navigating to `/post/[id]`. | `LedgerPage.tsx:87-95`<br>Regex parses UUID from memo; renders clickable "View Offer" calling `onOpenPost(id)`. | `parity` |
| **Send Beans CTA button** | `ledger.tsx:770`<br>Floating / header "Send" button disabled if balance is zero or negative. | `LedgerPage.tsx:129`<br>"Send" button disabled if balance is zero or negative. | `parity` |
| **Export statement / transactions** | `ledger.tsx:89, 360-395`<br>Generates CSV via `expo-file-system` and shares via `Sharing.shareAsync`. | `LedgerPage.tsx:210-235`<br>Generates CSV Blob and triggers native browser file download. | `parity` |
| **Credit limit bar display** | `CreditBar.tsx:35-65`<br>Visual credit limit bar with min, max, current balance, and committed escrow. | `CreditBar.tsx:35-65`<br>Visual credit limit bar with min, max, current balance, and committed escrow. | `parity` |

---

## 7. Commons / Projects

| Element or gesture | Native behaviour (`apps/native`) | PWA behaviour (`apps/pwa/src`) | Verdict |
| :--- | :--- | :--- | :--- |
| **Quadratic governance voting** | `projects.tsx:377-456`<br>"Vote with Credits" opens stepper (`-`/`+`/`Cast`). Calculates quadratic cost (`credits = votes²`). | Completely absent from PWA. PWA only supports crowdfunding pledge flow. | `native-only` |
| **Commons pool & credits stat cards** | `projects.tsx:536-547`<br>Prominent stat cards for "Commons Pool" balance and "Available Governance Credits". | Completely absent from PWA header. | `native-only` |
| **Commons info modal button** | `projects.tsx:526-528, 679-683`<br>Information icon button opens `CommonsInfoModal` explaining pool mechanics. | Component exists in codebase (`CommonsInfoModal.tsx`) but is never rendered or opened. | `native-only` |
| **Active voting round banner** | `projects.tsx:587-601`<br>Banner displaying active voting round, time remaining, and number of eligible projects. | Absent from PWA. | `native-only` |
| **Sort controls (Trending / Newest / Cost)** | `projects.tsx:604-618`<br>Sort pill buttons sorting project cards dynamically. | Absent from PWA (projects rendered in default API return order). | `native-only` |
| **Project card tap** | `projects.tsx:310-322`<br>`router.push({ pathname: '/project-detail', params: ... })` pushes dedicated route. | `ProjectsPage.tsx:363`<br>`onClick={() => setSelectedProject(project)}` opens full-screen overlay modal. | `divergent` |
| **Project detail back navigation** | `project-detail.tsx:136`<br>`router.back()` pops screen cleanly. | `ProjectsPage.tsx:542`<br>`onClick` clears state. Browser back button leaves BeanPool app! | `divergent` |
| **Creator profile tap (List card)** | `projects.tsx:363-375`<br>Tapping "Proposed by [callsign]" stops propagation and navigates to `/public-profile`. | `ProjectsPage.tsx:391-393`<br>Callsign is plain non-clickable text; clicking anywhere on card opens project detail. | `native-only` |
| **Report project** | `project-detail.tsx:202-237`<br>"Report Project" button with expandable reason input and abuse submission. | Completely absent from PWA project detail. | `native-only` |
| **Community Treasury card tap** | `projects.tsx:554-576`<br>Tapping treasury card navigates to `/treasury-detail` screen. | `ProjectsPage.tsx:274-328`<br>Treasury cards are inert `<div>` containers; tapping does nothing. | `native-only` |
| **Propose project flow** | `projects.tsx:674`<br>`router.push('/propose-project')` pushes dedicated proposal modal screen. | `ProjectsPage.tsx:261, 437`<br>`onClick={() => setShowNewProject(true)}` renders full-screen overlay modal. | `divergent` |
| **Creator edit & refund/delete** | In list card: edit pencil opens `/edit-project`. Detail screen has no inline delete/refund. | `ProjectsPage.tsx:550-557, 665-686`<br>Detail header has "Edit" button with "Delete Project & Refund Backers". | `PWA-only` |
| **Pledge breakdown visualization** | Single progress bar showing total raised vs goal. | `ProjectsPage.tsx:408-428`<br>Segmented bar showing member pledges (green) vs Commons allocation (blue) + legend. | `PWA-only` |

---

## 8. Pulse

| Element or gesture | Native behaviour (`apps/native`) | PWA behaviour (`apps/pwa/src`) | Verdict |
| :--- | :--- | :--- | :--- |
| **Lane navigation** | `pulse.tsx:45, 309-342`<br>Supports 3 lanes: **Neighbours**, **Local**, and **Learn** (community guides & reflections). | `PulsePage.tsx:42, 272-309`<br>Supports only 2 lanes: **Neighbours** and **Local**. **Learn lane is missing**. | `native-only` |
| **Subscreen navigation (+ Channels / + Intake)** | `pulse.tsx:240, 286`<br>`router.push('/channels')` and `router.push('/pulse-intake')` push discrete routes. | `PulsePage.tsx:208-233`<br>Controlled via local `view: 'feed' \| 'channels' \| 'intake'`. Browser back exits app! | `divergent` |
| **Card / Thumbnail tap (External link)** | `PulseFeedCard.tsx:53-67`<br>`onPress` validates URL and calls `Linking.openURL(url)` to open browser/app. | `PulseFeedCard.tsx:44-52`<br>`onClick` validates URL and opens new tab via `window.open(url, '_blank')`. | `parity` |
| **Keyboard activation of card** | Touch only (standard mobile). | `PulseFeedCard.tsx:180-189`<br>`tabIndex={0}`, `role="link"`, triggers on `Enter` or `Space`. | `PWA-only` |
| **Author profile navigation** | `PulseFeedCard.tsx:99-136`<br>Tapping author avatar or name navigates to `/public-profile`. | `PulseFeedCard.tsx:54-59`<br>Tapping author button calls `onOpenProfile(pubkey)` opening profile overlay. | `parity` |
| **Owner item actions** | `PulseFeedCard.tsx:145-156`<br>Owner has a **"Hide"** button (`mutePulseItem`) with `Alert.alert` confirmation. | `PulseFeedCard.tsx:152-175`<br>Owner has **BOTH "Hide" and "Delete"** buttons with custom modal dialogs. | `PWA-only` |
| **Feed refresh gesture** | `pulse.tsx:436-443`<br>Pull-to-refresh `RefreshControl` spinner at top of feed. | `PulsePage.tsx:244-253`<br>Header icon button `🔄` refreshes feed on click. | `divergent` |
| **Pagination trigger** | `pulse.tsx:444`<br>`onEndReached` on `FlatList` triggers automatic infinite loading. | `PulsePage.tsx:428-439`<br>Manual "Load more posts" button at bottom of feed list. | `divergent` |
| **Manual intake clipboard paste** | `pulse-intake.tsx:258-269`<br>Reads clipboard via `expo-clipboard` with haptic feedback. | `PulseIntakePage.tsx:200-209`<br>Reads clipboard via `navigator.clipboard.readText()`. | `parity` |

---

## HIGH

This section documents critical interaction discrepancies that directly degrade member experience, ranked from most severe.

### 1. Browser Back Button Closes or Exits Application Across All PWA Sub-Views
- **What the member attempts to do**: When viewing a Post Detail, Message Thread, Public Profile, Project Detail, New Project Proposal, Pulse Channel Manager, or Pulse Manual Intake on the Web PWA, the member clicks their browser's native Back button (or mouse back button / Android system swipe back) expecting to return to the parent list.
- **What happens instead**: Because these views are managed via React state switches (`selectedPost`, `activeConv`, `openProfilePubkey`, `selectedProject`, `showNewProject`, `view`) without pushing history state via the History API (`pushState` / `popstate`), the browser navigates to the previous domain or closes the session entirely. The member loses their current place and context.
- **Files & Lines**:
  - `apps/pwa/src/pages/MarketplacePage.tsx:505, 2079`
  - `apps/pwa/src/pages/MessagesPage.tsx:556, 734`
  - `apps/pwa/src/App.tsx:539` (`openProfilePubkey`)
  - `apps/pwa/src/pages/ProjectsPage.tsx:363, 437, 538`
  - `apps/pwa/src/pages/PulsePage.tsx:38, 208-233`

---

### 2. Settings Top-Left Back Button Abruptly Exits Settings From Sub-Screens
- **What the member attempts to do**: Inside Settings, a member enters a nested management section such as "Edit Profile", "Advanced Configuration", "Recovery Seed", "System Diagnostics", or "Blocked Members". After finishing, they click the prominent top-left `← Back` button in the header expecting to return to the Settings menu.
- **What happens instead**: In `apps/pwa/src/pages/SettingsPage.tsx:469-480`, the top-left header back button unconditionally invokes `onBack()`, which closes Settings entirely and ejects the member back to the Marketplace tab. Only a small, easy-to-miss secondary button at the very bottom of the page (`SettingsPage.tsx:1576`) calls `setMode('menu')`.
- **Files & Lines**:
  - `apps/pwa/src/pages/SettingsPage.tsx:469-480`
  - `apps/pwa/src/pages/SettingsPage.tsx:1576`

---

### 3. Marketplace Feed Scroll Position Destroyed When Returning from Post Detail on PWA
- **What the member attempts to do**: A member scrolls deep down the Marketplace feed, clicks a listing to inspect its terms, and then clicks the back button to continue browsing.
- **What happens instead**: In `apps/pwa/src/pages/MarketplacePage.tsx:505`, opening a post causes the feed list to be completely unmounted from the DOM. When the member returns, the feed component remounts from scratch, resetting the scroll offset to `0px` (the top). The member must re-scroll and find their place again. On Native, `FlatList` remains mounted in the React Navigation stack and preserves exact scroll offset.
- **Files & Lines**:
  - `apps/pwa/src/pages/MarketplacePage.tsx:505, 1817`
  - `apps/native/app/(tabs)/index.tsx:1460-1540`

---

### 4. Chat Message Images Are Unclickable Dead Ends on PWA
- **What the member attempts to do**: In a chat thread, a counterparty sends a photo of an item, receipt, or condition. The member clicks the image thumbnail to inspect the full-resolution image.
- **What happens instead**: On PWA (`apps/pwa/src/pages/MessagesPage.tsx:141`), the image is rendered as a standard `<img>` without an `onClick` handler, light box, or modal zoom. Clicking it does nothing. In contrast, Native (`apps/native/app/chat/[id].tsx:92, 1700-1705`) opens a full-screen pinch-and-zoom modal image viewer.
- **Files & Lines**:
  - `apps/pwa/src/pages/MessagesPage.tsx:141`
  - `apps/native/app/chat/[id].tsx:92, 1700-1705`

---

### 5. Chat Header Peer Avatar and Callsign Are Non-Interactive on PWA
- **What the member attempts to do**: In a conversation, the member clicks the counterparty's avatar or callsign in the chat header to review their trust score, vouches, or active listings.
- **What happens instead**: In PWA (`apps/pwa/src/pages/MessagesPage.tsx:745-755`), the peer avatar and name are wrapped in an inert `<div>` with no click handler. In contrast, Native (`apps/native/app/chat/[id].tsx:1423-1434`) allows tapping either element to navigate directly to `/public-profile`.
- **Files & Lines**:
  - `apps/pwa/src/pages/MessagesPage.tsx:745-755`
  - `apps/native/app/chat/[id].tsx:1423-1434`

---

### 6. Native Chat Header Action Menu Button Is Inert (Dead 3-Dots Button)
- **What the member attempts to do**: In a chat on Native, a member taps the three-dots `...` action button in the header expecting options to Report or Block the counterparty.
- **What happens instead**: In Native (`apps/native/app/chat/[id].tsx:1449`), the `Pressable` has no `onPress` handler attached. Tapping it produces zero reaction or feedback. Conversely, PWA (`apps/pwa/src/pages/MessagesPage.tsx:760-790`) provides explicit, functioning "🚩 Report" and "🚫 Block/Unblock" buttons in the chat header.
- **Files & Lines**:
  - `apps/native/app/chat/[id].tsx:1449`
  - `apps/pwa/src/pages/MessagesPage.tsx:760-790`

---

### 7. PWA Commons / Projects Completely Lacks Quadratic Governance Voting
- **What the member attempts to do**: On the Community Projects screen, a member with earned governance credits attempts to vote on proposed community projects.
- **What happens instead**: On PWA (`apps/pwa/src/pages/ProjectsPage.tsx`), there is no voting interface whatsoever. The member cannot see active voting rounds, cannot check their available governance credits, and cannot cast votes; PWA only supports crowdfunding Bean pledges. In Native (`apps/native/app/(tabs)/projects.tsx:377-456`), Commons projects include a "Vote with Credits" button expanding an interactive stepper calculating quadratic credit cost (`credits = votes²`).
- **Files & Lines**:
  - `apps/native/app/(tabs)/projects.tsx:377-456`
  - `apps/pwa/src/pages/ProjectsPage.tsx:342-434`

---

### 8. PWA Map Pin Drop Panel Obscures Map Without Confirmation Action
- **What the member attempts to do**: A member on PWA clicks "Drop a Pin" on the map to place a location-specific offer or request.
- **What happens instead**: In Native (`apps/native/app/(tabs)/map.tsx:1154-1175`), tapping "Drop a Pin" hides the composer form and displays a clear footer bar with "Cancel" and "Confirm Pin ✓". In PWA (`apps/pwa/src/pages/MapPage.tsx:743, 795-817`), the new post form remains open as a large sheet covering over half the screen, forcing the member to click on whatever sliver of the map remains visible without any confirmation step.
- **Files & Lines**:
  - `apps/native/app/(tabs)/map.tsx:1154-1175`
  - `apps/pwa/src/pages/MapPage.tsx:743, 795-817`

---

### 9. Post Detail View on PWA Lacks Block User Action
- **What the member attempts to do**: When encountering an abusive or spam listing on the Marketplace, the member attempts to block the creator directly from the post detail screen.
- **What happens instead**: Native (`apps/native/app/post/[id].tsx:1505-1548`) provides a prominent "🚫 Block User" button with confirmation alert. PWA (`apps/pwa/src/pages/MarketplacePage.tsx:1358-1399`) only provides a "🚩 Report" button. To block the user, the PWA member must exit post detail, navigate to the People directory, find the user, and block them from their profile.
- **Files & Lines**:
  - `apps/native/app/post/[id].tsx:1505-1548`
  - `apps/pwa/src/pages/MarketplacePage.tsx:1358-1399`

---

### 10. Community Treasury Cards Are Non-Clickable on PWA
- **What the member attempts to do**: On the Community Projects screen, a member clicks a Community Treasury card (e.g. egg exchange, tool pool) to inspect live offers, operator status, or ledger history.
- **What happens instead**: In Native (`apps/native/app/(tabs)/projects.tsx:554-576`), tapping a treasury card navigates to `/treasury-detail`. In PWA (`apps/pwa/src/pages/ProjectsPage.tsx:274-328`), treasury cards are rendered as inert `<div>` elements with no click handler or modal attached.
- **Files & Lines**:
  - `apps/native/app/(tabs)/projects.tsx:554-576`
  - `apps/pwa/src/pages/ProjectsPage.tsx:274-328`
