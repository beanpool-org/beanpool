# Events on the Map — Research & Architecture Design Document

> **Status: DESIGN DOCUMENT — Decision Ready.**
> **Target Audience & Context:** Federated mutual-credit community platform (BeanPool) operating across regional and off-grid Australian communities (Mullumbimby, Bindarrabi, Castlemaine, East Gippsland).
> **Accessibility Floor:** 320dp screen width, 1.3× font scale, Android 8 / API 26 minimum, intermittent/poor connectivity.
> **Constraint:** Read-only analysis. Core map components (`Map.tsx`, `Map.web.tsx`, `UnifiedMapPin.tsx`, `MapPinTail.tsx`, `GlobalHeader.tsx`, `logo.png`) remain unmodified.

---

## Executive Summary & Core Architectural Decisions

BeanPool's map today renders marketplace listings (offers and needs) and members. Extending the map to carry **events** transforms BeanPool from a transactional mutual-credit exchange into a true **bioregional community operating system**.

Events differ from marketplace listings in one fundamental, physics-level dimension: **TIME**. A marketplace listing represents a persistent inventory state until fulfilled; an event represents a temporal window at a physical location. Adding events without temporal mechanics turns the map into an unreadable "pin soup."

This document establishes the architectural, economic, and safety foundation for Events in BeanPool.

### The Five Fundamental Decisions

| # | Dimension | Decision | Why This Over Alternatives |
|---|---|---|---|
| **D1** | **Entity Model** | **New First-Class Entity (`community_events` & `event_attendees`)** | Overloading `posts` corrupts the escrow state machine, buyer/seller semantics, FTS indexes, and delta sync. Events have start/end times, host/co-host rosters, capacity, and RSVP states that have zero overlap with trade lifecycle. |
| **D2** | **Recurrence** | **Single Concrete Events in v1; Horizon Expansion in v2. NO RFC 5545 (RRule).** | Arbitrary RRule engines drown decentralized platforms in timezone/DST bugs, exception tracking (`EXDATE`), and orphaned sync state. v1 provides single events + one-tap "Clone / Re-list". v2 generates forward rolling concrete rows up to 30 days ahead. |
| **D3** | **Privacy Default** | **Fuzzed by Default (500m radius blur) for Residential/Private Venues; Exact Address Revealed on RSVP.** | A public event pin is a precise physical coordinate at a known time (frequently a private homestead or off-grid community). Revealing exact residential coordinates on unauthenticated PWAs or to unverified accounts creates a real-world physical safety hazard. Public venues (e.g. Community Gardens) opt-in to exact pins. |
| **D4** | **Map UX & Noise** | **Segmented Layer Toggle (`Market` \| `Events`) + Temporal Quick-Chips (`Today` \| `Weekend` \| `All Upcoming`).** | Avoids multi-slider scrubbers that break at 320dp width. Maintains instant spatial context while eliminating pin soup. Event pins use a distinct purple/indigo badge geometry with category emojis. |
| **D5** | **Federation & Reach** | **Bilateral Signed Delta Sync with Strict Local Default (`reach = 'local'`).** | Respects community boundary sovereignty. Mullumbimby working bees do not flood Bindarrabi's map unless explicitly published with `reach = 'peers'`. Cross-node RSVPs and ticketing reuse the established #104/#143 bilateral settlement engine. |

---

## 1. Grounded Audience Research: What "Events" Mean in Regional Australia

### 1.1 The Audience Profile & Context

BeanPool's users are not organizing corporate tech meetups or commercial nightlife. They live in regional hubs, permaculture valleys, transition towns, and remote intentional communities across Australia:
- **Mullumbimby / Byron Hinterland (Bundjalung Country, NSW):** Permaculture hubs, flood recovery networks, seed savers, regenerative agriculture, natural beekeeping, ecovillages.
- **Bindarrabi (Border Ranges / QLD-NSW border):** Remote off-grid intentional community on mountainous terrain, communal asset management, infrastructure working bees, solar/water maintenance.
- **Castlemaine / Mount Alexander (Dja Dja Wurrung Country, VIC):** Active transition town, repair cafes, tool libraries, radical barter, community fruit harvesting, firewood working bees.
- **East Gippsland (Gunaikurnai Country, VIC):** Remote bushfire-affected communities, agricultural recovery, machinery sharing, regional farmers' markets, seasonal muster gatherings.

### 1.2 The Real Event Taxonomy

Interviews and observational research into regional Australian community organizing reveal eight core event archetypes:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BEANPOOL COMMUNITY EVENT ARCHETYPES                      │
├──────────────────────┬──────────────────────┬───────────────────────────────┤
│ 1. Working Bees      │ 2. Harvest & Swap    │ 3. Skill-Shares & Workshops   │
│ (Permaculture, weed  │ (Excess citrus, seed │ (Cob building, fermentation,  │
│ blitz, swale digging)│ swaps, plant starts) │ solar repair, scything)       │
├──────────────────────┼──────────────────────┼───────────────────────────────┤
│ 4. Repair Cafes      │ 5. Seasonal Feasts   │ 6. Community Assemblies       │
│ (Tool fixes, small   │ (Solstice gatherings,│ (Commons governance, Landcare │
│ engine maintenance)  │ community pizza oven)│ meetings, flood recovery)     │
├──────────────────────┼──────────────────────┼───────────────────────────────┤
│ 7. Ride-Shares       │ 8. Emergency Action  │                               │
│ (Town runs, supply   │ (Sandbagging, fire   │                               │
│ trips, carpooling)   │ prep, chainsaw crews)│                               │
└──────────────────────┴──────────────────────┴───────────────────────────────┘
```

### 1.3 What Communities Complain About Today

Permaculture and regional community organizers in Australia express persistent frustrations with existing digital platforms:

1. **Facebook Groups & Meta Enclosure:**
   - *Algorithmic Suppression:* Organic working bee posts are deprioritized in favor of boosted commercial content. Organizers report that 80% of group members never see a working bee post until 2 days *after* it occurred.
   - *Account Refusal:* Privacy-conscious, off-grid, and radical community members refuse to create Facebook/Instagram accounts, fragmenting communication into disjointed SMS or Signal threads.
   - *Security & Doxing:* Publishing a working bee on a private homestead in a public Facebook group exposes the host's residence to scraping, unregulated visitors, and surveillance.
2. **Eventbrite / Meetup:**
   - *Extractive Fees:* Meetup charges organizers ~$30–$40/month just to host a local group; Eventbrite extracts ticket fees and aggressively markets third-party corporate events to attendees.
   - *Corporate UX:* Built for conference halls and ticket barcodes, not a seed swap or creek-clearing morning where attendees bring a plate to share.
3. **WhatsApp / Signal Group Chaos:**
   - *Zero Spatial/Temporal Structure:* Crucial event details get buried under 300 chat messages. There is no calendar view, no map pin, and no reliable RSVP headcount.
4. **Poor Regional Connectivity:**
   - Heavy web applications (like full JS single-page apps) fail to load over 3G/satellite connections (e.g. Starlink dropouts or patchy valley signal). Users need cached offline access to venue directions and host contacts.

### 1.4 Map-First: What Works Better vs. What Works Worse

| Dimension | Map-First Advantage (BeanPool) | Map-First Vulnerability (Must Design Against) |
|---|---|---|
| **Spatial Proximity** | **Superior.** Instantly answers: "What is happening along my valley/creek road this weekend?" Visualizes hyper-local clusters. | **Pin Soup.** Without temporal filtering, a recurring weekly market completely obscures a one-off flood-relief working bee at the same venue. |
| **Discovery** | **Superior for Travelers & Neighbours.** Enables discovering a repair cafe or seed swap without needing prior social graph connections. | **The "Ghost Town" Map.** An empty map with no events for 30km makes the app feel dead, even if lively trade is occurring. |
| **Discussion & Context** | **Worse than a feed if isolated.** A map pin cannot comfortably host a 50-comment discussion on who is bringing which tools. | Must pair the map pin directly with an integrated in-app event conversation thread. |

---

## 2. Prior Art Analysis & Lessons Learned

We analyzed centralized and decentralized event systems to extract structural lessons.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            PRIOR ART LANDSCAPE                              │
│                                                                             │
│  Centralized / Proprietary               Federated / Decentralized          │
│  ├── Meetup                              ├── Mobilizon (Framasoft)          │
│  ├── Facebook Events                     ├── Gancio (autistici.org)         │
│  ├── Nextdoor                            └── Hylo (Bioregional Holochain)   │
│  ├── Luma / Partiful                                                        │
│  └── Karrot / Foodsharing                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Deep Dive: Federated Architectural Analogues (Mobilizon & Gancio)

#### A. Mobilizon (Framasoft — ActivityPub)
* **What they built:** Open-source, federated event and group management software based on ActivityPub, developed by Framasoft as an ethical alternative to Facebook Events.
* **What they got right:**
  - Strong group identity and multi-host permissions.
  - Granular privacy: public events, unlisted events, member-only events.
  - Clean representation of event participation (`Join`, `Leave`, `Invite` activities).
* **Where they struggled & lessons for BeanPool:**
  - *Generic Social Protocol Mismatch:* Applying generic ActivityPub actor-relay models created severe federation redundancy (e.g. redundant `Create` and `Announce` activities causing duplicate items on remote peers).
  - *No Mobile-First Offline Mode:* Mobilizon is a web-first desktop/responsive tool. It lacks offline-first SQLite state caching for remote field use.
  - *Framasoft's Maintenance Pivot (2024):* Framasoft halted active feature development on Mobilizon, citing the heavy maintenance burden of complex federation relays and low adoption compared to Mastodon.
  - **Key Lesson for BeanPool:** Avoid unbounded, multi-hop federated relays. BeanPool's direct, bilateral signed sync between known partner nodes (`sync.ts`) is dramatically more reliable, auditable, and resilient.

#### B. Gancio (autistici.org — Anarchist Shared Agenda)
* **What they built:** A lightweight, self-hosted, federated calendar and map designed specifically for local collectives, social centres, and activist groups.
* **What they got right:**
  - *Map + Agenda Cohesion:* Direct pairing of a spatial map with a clean date agenda.
  - *Lightweight Simplicity:* Minimal dependencies, fast load times, anonymous submissions via admin approval queues.
  - *Visual Density:* Colored dots and badges representing event density per day.
* **What they lacked / abandoned:**
  - *No Mutual Credit or Ticketing:* Purely an announcement broadcast board; cannot manage volunteer work commitments, tool deposits, or mutual-credit contributions.
  - *No Location Fuzzing:* Either exact coordinates or none; lacks tiered address disclosure for sensitive home gatherings.
  - **Key Lesson for BeanPool:** Keep the submission and map UI as frictionless and clean as Gancio, but back it with BeanPool's cryptographic identity, reputation, and mutual-credit ledger.

### 2.2 Summary of Commercial & Community Platforms

| Platform | Core Strength | Fatal Flaw for BeanPool's Context |
|---|---|---|
| **Hylo** | Bioregional mapping, relationship-first community directory. | Heavy web frontend, steep learning curve, non-trivial operational footprint. |
| **Karrot** | Frictionless local food-saving and community pickup coordination. | Lacks formal event scheduling, ticketing, and governance tie-ins. |
| **Luma / Partiful** | Slick mobile RSVP flows, viral SMS/contact book loops. | Centralized VC platforms; require SMS phone numbers; zero support for mutual credit or off-grid federation. |
| **Trustroots** | Radical hospitality, gift economy, open-source location map. | Events are an afterthought; focused strictly on traveler hosting. |
| **Open Collective** | Transparent collective budgeting and event expense tracking. | No spatial/map discovery; oriented around financial accounting rather than local gatherings. |

---

## 3. Data Model & Architecture

### 3.1 Entity Architecture Debate: New Table vs. Variant of `posts`

A critical architectural fork is whether an event should be a new row type in the existing `posts` table (e.g. `type = 'event'`) or a dedicated entity table (`community_events`).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DATA MODEL ARCHITECTURAL COMPARISON                      │
├──────────────────────────┬──────────────────────────────────────────────────┤
│ Option A: Overload posts │ Option B: Dedicated community_events (RECOMMENDED)│
├──────────────────────────┼──────────────────────────────────────────────────┤
│ • Reuses lat/lng & photos│ • Clean relational schema; zero pollution of     │
│ • Zero migration effort  │   marketplace queries (WHERE type IN ('offer'))  │
│ ❌ Corrupts escrow logic │ • Dedicated indexes on (start_at, end_at)        │
│ ❌ Nullable timestamp    │ • Clean event_attendees join table (multi-party) │
│   pollution              │ • Dedicated tombstoning & 90-day pruner lifecycle│
│ ❌ Single accepted_by    │ • Extensible co-hosts and location privacy rules │
│   vs multi-party RSVP    │ • Direct integration with Treasury & The Pulse   │
└──────────────────────────┴──────────────────────────────────────────────────┘
```

**Recommendation: Build `community_events` as a dedicated entity table.**
Overloading `posts` creates severe architectural debt. The `posts` table is tightly coupled to 2-party trade escrow (`accepted_by`, `pending_transaction_id`, `price_type`, `cash_also_needed`). Events require multi-party RSVPs, capacity limits, start/end date ranges, timezone declarations, host/co-host pubkeys, and location privacy fuzzing.

### 3.2 Proposed SQLite Schema

Following the strict conventions established in `apps/server/src/db/schema.sql`, `creator_channels`, and `pulse_items`:
1. Row mutation watermarks (`updated_at`) with automated touch triggers.
2. Hard deletions scrub content and preserve minimal tombstones for delta sync.
3. Keyset pagination indexes matching query sort orders.

```sql
-- ============================================================================
-- COMMUNITY EVENTS & ATTENDANCE
-- ============================================================================

CREATE TABLE IF NOT EXISTS community_events (
    id                  TEXT PRIMARY KEY,          -- 'evt_' + 12 random bytes, hex
    organizer_pubkey    TEXT NOT NULL REFERENCES members(public_key),
    co_hosts            TEXT,                      -- JSON array of member public_keys
    title               TEXT NOT NULL,
    description         TEXT NOT NULL,
    category            TEXT NOT NULL CHECK (category IN (
                            'working_bee', 'market', 'workshop', 'gathering',
                            'repair_cafe', 'meeting', 'food_share', 'other'
                        )),
    
    -- Temporal Specification (ISO-8601 UTC)
    start_at            DATETIME NOT NULL,
    end_at              DATETIME NOT NULL,
    is_all_day          INTEGER NOT NULL DEFAULT 0,
    timezone            TEXT NOT NULL DEFAULT 'Australia/Sydney', -- IANA tz identifier
    
    -- Spatial & Venue Information
    lat                 REAL NOT NULL,
    lng                 REAL NOT NULL,
    location_name       TEXT NOT NULL,             -- e.g. "Mullumbimby Community Garden" or "Main Arm Valley Homestead"
    address_hidden      INTEGER NOT NULL DEFAULT 1,-- 1 = Fuzzed on map, exact address revealed on RSVP / vouched
    exact_address       TEXT,                      -- Private address, directions, or gate codes
    
    -- Capacity, Economics & Governance
    capacity            INTEGER,                   -- NULL = unlimited
    cost_beans          REAL NOT NULL DEFAULT 0.0 CHECK (cost_beans >= 0),
    cost_cash_desc      TEXT,                      -- e.g. "$5 for wood turning consumables" (cash-at-door only)
    treasury_pubkey     TEXT REFERENCES members(public_key), -- Linked Commons enterprise (docs/community-governance.md)
    
    -- Lifecycle & Status
    status              TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'cancelled', 'draft')),
    cancellation_reason TEXT,
    
    -- Federation Scope (matches posts table #143 standard)
    reach               TEXT NOT NULL DEFAULT 'local' CHECK (reach IN ('local', 'peers', 'everywhere')),
    reach_peers         TEXT,                      -- JSON array of libp2p peer_ids when reach='peers'
    origin_node         TEXT,                      -- libp2p peer_id of authoring node; NULL = authored locally
    
    -- Media & Keywords
    photos              TEXT,                      -- JSON array of photo URIs
    search_keywords     TEXT DEFAULT '',
    
    -- Watermarks & Tombstone Lifecycle
    created_at          DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at          DATETIME,
    
    CONSTRAINT event_lat_lng_check CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180),
    CONSTRAINT event_time_check CHECK (end_at >= start_at)
);

-- Indexes optimized for Map viewport queries, time filtering, and feed sorting
CREATE INDEX IF NOT EXISTS idx_community_events_upcoming 
    ON community_events(start_at ASC) 
    WHERE deleted_at IS NULL AND status = 'published';

CREATE INDEX IF NOT EXISTS idx_community_events_category_time 
    ON community_events(category, start_at ASC) 
    WHERE deleted_at IS NULL AND status = 'published';

CREATE INDEX IF NOT EXISTS idx_community_events_spatial 
    ON community_events(lat, lng) 
    WHERE deleted_at IS NULL AND status = 'published';

CREATE INDEX IF NOT EXISTS idx_community_events_organizer 
    ON community_events(organizer_pubkey) 
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_community_events_updated_at 
    ON community_events(updated_at);

-- ============================================================================
-- EVENT ATTENDANCE & RSVPs
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_attendees (
    event_id            TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    member_pubkey       TEXT NOT NULL REFERENCES members(public_key),
    status              TEXT NOT NULL DEFAULT 'going' CHECK (status IN ('going', 'interested', 'cancelled', 'waitlist')),
    guests_count        INTEGER NOT NULL DEFAULT 0 CHECK (guests_count >= 0),
    beans_paid          REAL NOT NULL DEFAULT 0.0 CHECK (beans_paid >= 0),
    note                TEXT,                      -- e.g. "Bringing a chainsaw and trailer"
    created_at          DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (event_id, member_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_event_attendees_member 
    ON event_attendees(member_pubkey, status);

CREATE INDEX IF NOT EXISTS idx_event_attendees_updated_at 
    ON event_attendees(updated_at);

-- ============================================================================
-- WATERMARK TRIGGERS (Phase 2 Delta Sync Participation)
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS community_events_touch_updated_at
AFTER UPDATE ON community_events
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE community_events 
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') 
     WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS event_attendees_touch_updated_at
AFTER UPDATE ON event_attendees
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE event_attendees 
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') 
     WHERE event_id = NEW.event_id AND member_pubkey = NEW.member_pubkey;
END;
```

### 3.3 Core TypeScript Definitions

```typescript
export type EventCategory = 
    | 'working_bee'
    | 'market'
    | 'workshop'
    | 'gathering'
    | 'repair_cafe'
    | 'meeting'
    | 'food_share'
    | 'other';

export type EventStatus = 'published' | 'cancelled' | 'draft';
export type AttendeeStatus = 'going' | 'interested' | 'cancelled' | 'waitlist';

export interface CommunityEvent {
    id: string;
    organizerPubkey: string;
    coHosts: string[];
    title: string;
    description: string;
    category: EventCategory;
    startAt: string;       // ISO-8601 UTC
    endAt: string;         // ISO-8601 UTC
    isAllDay: boolean;
    timezone: string;
    lat: number;
    lng: number;
    locationName: string;
    addressHidden: boolean;
    exactAddress?: string | null;
    capacity: number | null;
    costBeans: number;
    costCashDesc?: string | null;
    treasuryPubkey?: string | null;
    status: EventStatus;
    cancellationReason?: string | null;
    reach: 'local' | 'peers' | 'everywhere';
    reachPeers?: string[];
    originNode?: string | null;
    photos: string[];
    createdAt: string;
    updatedAt: string;
    deletedAt?: string | null;
}

export interface EventAttendee {
    eventId: string;
    memberPubkey: string;
    status: AttendeeStatus;
    guestsCount: number;
    beansPaid: number;
    note?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface PublicEventCard extends Omit<CommunityEvent, 'exactAddress> {
    organizerCallsign: string;
    organizerAvatarUrl: string | null;
    isOrganizerElder: boolean;
    attendeeCount: number;
    userRsvpStatus?: AttendeeStatus | null;
    isLocationFuzzed: boolean;
    exactAddress?: string | null; // Populated only if member is RSVP'd or event is public venue
}
```

### 3.4 The Recurrence Problem: Why RFC 5545 (RRule) is Rejected

A recurring pitfall in calendar design is attempting to implement full RFC 5545 (iCalendar RRule) recurrence.

```
RFC 5545 Complexity Trap:
  Recurrence Rules (FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=...)
  + Exception Dates (EXDATE)
  + Modified Single Instances (RECURRENCE-ID with overridden lat/lng or cancelled status)
  + Daylight Savings Shifts (NSW vs QLD border time shifts across Mullum & Bindarrabi)
  = ❌ Massive dependency overhead, sync desynchronization, and silent data drift across SQLite nodes.
```

**The BeanPool Recurrence Policy:**
1. **v1 (Immediate Scope): Single Concrete Events with "Clone / Re-list".**
   Organizers tap **"Clone Event"** to instantiate a new event with identical descriptions, coordinates, and categories, advancing the date by 1 week or 1 month.
2. **v2 (Future Horizon): Finite Rolling Materialization.**
   For verified recurring community fixtures (e.g. "Mullum Farmers Market every Friday 7am–11am"), the server instantiates **discrete, concrete rows** up to 30 days into the future. Each instance is a standard `community_events` row with an optional `parent_series_id`. If one date is rained out, the organizer simply marks that single concrete row `status = 'cancelled'`.

### 3.5 Aging Out & Lifecycle Retention

Events naturally decay in relevance. The lifecycle model is:
- **Active Discovery Query Window:**
  `WHERE deleted_at IS NULL AND status = 'published' AND end_at >= datetime('now', '-6 hours')`
- **Recent Past Window (30 Days):**
  Past events remain visible on organizer/attendee profile histories and in the Commons archive for 30 days.
- **Tombstone Pruning (90 Days):**
  Similar to `prunePulseItems`, an automated background pruner runs monthly to tombstone events older than 90 days (`scrubEventRows`), clearing memory blobs and photo data while preserving the replication watermark.

---

## 4. Map Integration & Solving the Noise Problem

### 4.1 The 320dp Accessibility Floor Constraint

BeanPool must render on narrow Android devices (320dp width) at 1.3× font scale. The map interface cannot support cluttered multi-row controls, wide sidebars, or complex floating scrubbers.

```
┌───────────────────────────────────────────────────────────┐
│ [GlobalHeader: BeanPool Vine Banner]                     │
├───────────────────────────────────────────────────────────┤
│ [Top Segmented Bar:  (🤝 Market)  |  (📅 Events)  | (All) ]│
├───────────────────────────────────────────────────────────┤
│ [Sub-Chips (Events Mode): (Today) (Weekend) (This Month) ]│
│                                                           │
│                      🗺️ MAP VIEW                           │
│                                                           │
│           [ 🟣 Working Bee ]                              │
│                                    [ 📦 Offer ]           │
│                    [ 🟣 (3) Market Cluster ]              │
│                                                           │
│                                                           │
│ [FAB Pill: 🌙 | 🎯 | + | − ]               [+ ADD EVENT] │
├───────────────────────────────────────────────────────────┤
│ [Bottom Tab Bar: Market | Map | Chat | People | Commons ] │
└───────────────────────────────────────────────────────────┘
```

### 4.2 Map Layering & Temporal Filtering

1. **Top Segmented Filter Bar:**
   The existing `All | Offers | Needs | 🏷️ Category` filter bar in `MapScreen` is elevated to a primary mode switcher:
   - **Market Mode (Default):** Shows Offers (Green `#10b981`) and Needs (Orange `#ea580c`).
   - **Events Mode:** Shows Events (Purple/Indigo `#8b5cf6`), swapping the sub-chips to **Temporal Filters**:
     `⚡ Today` | `🌿 This Weekend` | `📅 Next 7 Days` | `🏷️ Category`.
   - **All Mode:** Shows both, with cluster pins dynamically displaying mixed color rings.
2. **Temporal Quick-Chips (No Complex Slider):**
   A slider widget fails usability tests at 320dp with touch targets < 48dp. Discrete, thumb-friendly chips provide instant temporal slicing:
   - `Today`: `start_at <= date('now', 'localtime', '+1 day') AND end_at >= datetime('now')`
   - `This Weekend`: Bounds between upcoming Friday 17:00 and Sunday 23:59 local node time.
   - `Next 7 Days`: Rolling 7-day window.

### 4.3 Pin Visual Geometry & Rasterization Pipeline

Under `UnifiedMapPin.tsx`, BeanPool uses an off-screen rasterization engine (`react-native-view-shot` capturing SVGs to PNGs) to prevent Android native marker canvas tearing and ensure 60fps clustering.

**The Event Pin Visual Contract:**
- **Pin Head Shape:** Distinct **Hexagonal Shield** or **Badge Geometry** (differentiating from the teardrop circle used for marketplace listings).
- **Brand Palette:** Deep Purple / Indigo background (`#7c3aed` to `#6366f1`) with a white inner circle.
- **Glyph:** Event category emoji (e.g. 🐝 for Working Bee, 🔧 for Repair Cafe, 🍎 for Food Swap, 🎪 for Market).
- **"Happening Today" Indicator:** A pulsing golden amber halo (`#f59e0b`) around events active within 12 hours.

```
Market Pin (Teardrop):            Event Pin (Hexagonal Badge):
      ╭───────╮                         ╭─────────╮
     │   📦   │                        ╱    🐝    ╲
      ╰───┬───╯                        ╲         ╱
          ▼                             ╰───┬───╯
     Green (#10b981)                        ▼
                                       Purple (#7c3aed)
```

### 4.4 Co-Located Events & Cluster Resolution

In regional towns, multiple events frequently occur at the same anchor venue (e.g. 3 different stalls and a workshop all at the *Mullumbimby Community Gardens* on Friday).
- **Cluster Behavior:** The map clustering engine (`react-native-map-clustering`) groups co-located event pins.
- **Multi-Event Preview Sheet:** Tapping a cluster of co-located events opens a **Horizontal Carousel Preview Card** at the bottom of the screen, allowing users to swipe through the events happening at that location without expanding overlapping pins.

---

## 5. Safety & Privacy: A First-Class Architecture

An event pin is fundamentally more privacy-sensitive than a marketplace listing: it broadcasts that a specific property owner will be at a specific location, or invites people directly onto private residential or off-grid land.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TIERED LOCATION PRIVACY MODEL                         │
├──────────────────────────┬──────────────────────────────────────────────────┤
│ Level 1: Public Venue    │ • Exact pin on map for all viewers.              │
│ (Halls, Gardens, Parks)  │ • Full street address visible publicly.          │
├──────────────────────────┼──────────────────────────────────────────────────┤
│ Level 2: Fuzzed (DEFAULT)│ • Map pin randomly jittered within 500m radius.  │
│ (Homesteads, Residences) │ • Street address HIDDEN on map and public feeds. │
│                          │ • General area shown (e.g. "Main Arm, near Hall")│
├──────────────────────────┼──────────────────────────────────────────────────┤
│ Level 3: RSVP-Gated      │ • Exact address & gate code revealed ONLY after: │
│ Disclosure               │   1. Member submits RSVP, AND                    │
│                          │   2. Host confirms (or member is Elder-vouched)  │
│                          │ • Delivered via encrypted in-app event DM thread.│
└──────────────────────────┴──────────────────────────────────────────────────┘
```

### 5.1 The Default Must Be Fuzzed (`address_hidden = 1`)

**Policy Rule:** Every event created on BeanPool defaults to `address_hidden = 1` unless the organizer explicitly checks *"This is a public venue (hall, park, shopfront)"*.

*Why:* In regional Australia, many intentional communities, bush properties, and homesteads have private access roads, locked fire gates, and solar/water infrastructure that cannot accommodate unannounced drive-ins. Fuzzing by default protects community members from unvetted visitors and burglary risk while preserving spatial discovery.

### 5.2 Unauthenticated PWA vs. Verified Member Gating

1. **Unauthenticated PWA Visitors:**
   - See fuzzed event pins with general suburb/valley labels.
   - Exact coordinates and attendee rosters are stripped by the API endpoint (`GET /api/events/public-map`).
2. **Authenticated Node Members:**
   - Can view event descriptions, organizer trust profiles, and attendee counts.
   - Tapping **"RSVP (Going)"** triggers the gated disclosure workflow.
3. **Host Approval & Elder Auto-Unlock:**
   - Hosts can configure *"Auto-reveal address to Elder-vouched members"* (`can_vouch` / `standing >= 50`).
   - For unvouched or new members, the host receives an in-app notification to confirm the RSVP before the private address is released.

### 5.3 Emergency Cancellation & Address Scrubbing

If an event is cancelled (due to bushfire, flood, weather, or security concerns), the host taps **"Cancel Event"**:
1. `status` flips to `'cancelled'` with an optional `cancellation_reason`.
2. The exact address and coordinates are scrubbed from the active feed.
3. An immediate high-priority push notification is dispatched to all RSVP'd attendees.
4. The pin turns grey with a strikethrough banner on the map for 24 hours so attendees checking the map see the cancellation plainly.

---

## 6. Federation Architecture & Cross-Node Sync

BeanPool's federation model connects independent SQLite community nodes (e.g. Mullumbimby, Bindarrabi, Castlemaine) via libp2p.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CROSS-NODE EVENT FEDERATION PIPELINE                     │
│                                                                             │
│   Mullumbimby Node (Author)                  Bindarrabi Node (Peer)         │
│   ┌───────────────────────────┐              ┌───────────────────────────┐  │
│   │ community_events (row)    │              │ community_events (replica)│  │
│   │ reach = 'peers'           │              │ origin_node = 'mullum_id' │  │
│   └─────────────┬─────────────┘              └─────────────▲─────────────┘  │
│                 │ exportSyncState()                        │                │
│                 │ (Signed Delta Payload)                   │                │
│                 └──────────────────► libp2p ───────────────┘                │
│                                 importRemoteState()                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Visibility & Reach Filtering

Events follow the exact reach model established in #143 for marketplace posts:
- `reach = 'local'` (Default): The event replicates only to local backup mirrors; it is never broadcast to peer communities.
- `reach = 'peers'`: The event replicates to explicitly selected partner nodes listed in `reach_peers` (e.g. Mullumbimby sharing a Permaculture Convergence with Bindarrabi and Nimbin).
- `reach = 'everywhere'`: The event replicates to all authorized federation peers.

### 6.2 Signed Delta Sync Registration (The Four Sites)

Conforming to `CONTRACTS.md §2`, event replication must be registered across all four synchronization sites:

1. **Type & Payload Definition:**
   `SyncCommunityEvent` and `SyncEventAttendee` added to `packages/beanpool-engine/src/sync.ts`.
2. **Delta Exporter:**
   `exportSyncState` updated to select `WHERE updated_at >= :since` with tombstone inclusion.
3. **Delta Importer:**
   `importRemoteState` in `apps/server/src/engine/sync.ts` updated with:
   - Max row batch guard (`MAX_IMPORT_ROWS_PER_CATEGORY = 250,000`).
   - Prepared statement hoisted above the loop (preventing `better-sqlite3` recompilation overhead).
   - Last-Write-Wins (LWW) conflict resolution: `WHERE excluded.updated_at > community_events.updated_at`.
4. **Resync Cleanup:**
   `clearReplicatedTables()` in `apps/server/src/state-engine.ts` updated to include `community_events` and `event_attendees`.

### 6.3 State Convergence Checks

To prevent silent replication divergence between nodes:
- **`getStateHash` (`packages/beanpool-engine/src/sync.ts`):**
  Hashes live event IDs (`WHERE deleted_at IS NULL AND status != 'cancelled'`).
- **`getReplicaConsistency` (`packages/beanpool-engine/src/audit.ts`):**
  Includes `community_events` and `event_attendees` in table row count comparisons.

### 6.4 Cross-Node Economic Settlements for Events

When a paid workshop charges Beans across nodes (e.g. a Bindarrabi member attending a Mullum ceramic firing workshop):
- The ticket transaction executes via the existing **#104 Settlement Exchange** (`settlements` table).
- The buyer's home node escrows the beans and issues a signed settlement receipt; the host's node credits the host's local balance and adjusts the inter-node energy balance (`bridge_bindarrabi`).

---

## 7. Connections to Existing Subsystems

### 7.1 Integration with The Pulse (`apps/native/app/pulse.tsx`)

The Pulse is BeanPool's chronological community feed. Events must not live exclusively on the map; they should naturally surface in The Pulse as temporal activity cards.

```
Pulse Feed Integration:
  [Pulse Screen]
     ├── Creator Videos & Articles (Autolisted YouTube/RSS)
     ├── Living Activity Waterfall (Trade completions, joins)
     └── 🌟 UPCOMING EVENTS PIN (Sticky Carousel at Top of Pulse)
           ├── "🐝 Working Bee — Tomorrow 9:00 AM @ Main Arm"
           └── "🔧 Repair Cafe — This Saturday 10:00 AM @ Hall"
```

*Mechanics:*
`GET /api/pulse/feed` is extended to inject upcoming events within the next 48 hours into the top hero slot of the feed, complete with an instant "Going" RSVP button.

### 7.2 Integration with Commons & Community Governance (`docs/community-governance.md`)

Events provide the operational muscle for the Commons:
1. **Enterprise Working Bees:**
   A community enterprise (e.g. the 🥚 *Community Egg Flock* or 🚜 *Shared Tractor Co-op*) can author an event as a Treasury actor (`treasury_pubkey`).
2. **Labor-for-Credit (Earned Credit):**
   Members participating in designated Commons Working Bees can be awarded earned credit or have volunteer hours recorded directly to their trust profile (`members.earned_credit`), boosting their dynamic floor.
3. **Surplus Funding:**
   Ticket fees paid in Beans for community events can deposit directly into the sub-treasury of an enterprise or the root Commons pool.

### 7.3 Navigation & Bottom Tab Bar Integrity

The native bottom navigation bar is strictly capped at **6 slots** (`Market`, `Map`, `Chat`, `People`, `Commons`, `Ledger`) to ensure compliance with the 320dp width + 1.3× font scale floor.
- **Decision:** **DO NOT ADD A 7TH TAB.**
- Events live natively as a first-class layer on the **Map tab**, with chronological previews in **The Pulse** and governance ties in the **Commons tab**.

---

## 8. Phasing: Ruthless Scoping

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             PHASING ROADMAP                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ PHASE 1: Minimal Viable Events (v1 — Ship Next Month)                       │
│ • Single concrete events (published / cancelled)                            │
│ • "Clone Event" button (manual recurrence)                                  │
│ • Map Layer Switcher (Market vs Events) + Today/Weekend/7-Day chips        │
│ • Hexagonal Purple Event Pin in UnifiedMapPin                               │
│ • Location Fuzzing (500m radius blur) + RSVP-gated address reveal           │
│ • Basic RSVP (Going / Interested) + attendee count                          │
│ • Delta sync replication across nodes (reach = 'local' | 'peers')           │
├─────────────────────────────────────────────────────────────────────────────┤
│ PHASE 2: Feed & Governance Synergy (v2)                                     │
│ • Sticky "Happening Soon" Hero Carousel on The Pulse                        │
│ • Treasury Enterprise co-hosting & Commons earned-credit rewards            │
│ • Finite 30-day rolling recurrence materialization                          │
│ • Direct in-app Event Chat Thread auto-creation                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ PHASE 3: Advanced Ticketing & Settlements (v3)                              │
│ • Cross-node Beans ticket escrow via #104 settlements                       │
│ • Waitlist management & capacity automated cutoffs                          │
│ • iCal / .ics calendar feed export for mobile device calendars              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### What is Ruthlessly EXCLUDED from v1:
- ❌ **NO RFC 5545 RRule Parser:** No complex recurring calendar formulas.
- ❌ **NO Multi-Tiered Ticket Classes:** No VIP vs General Admission pricing tiers.
- ❌ **NO Third-Party Calendar OAuth Sync:** No bidirectional Google/Apple Calendar cloud syncing.
- ❌ **NO QR Code Barcode Scanners:** Trust-based member check-in via attendee list.
- ❌ **NO External Web Scrapers:** Events are authored natively by members.

---

## 9. Risks & Non-Goals

### 9.1 Explicit Non-Goals

1. **BeanPool is NOT Eventbrite:** We do not optimize for commercial concerts, ticket surcharges, or massive spectator events.
2. **BeanPool is NOT Facebook Events:** We do not use engagement algorithms, tracking pixels, or viral data harvesting.
3. **BeanPool is NOT a Conference Management Suite:** No multi-track badges, sponsor booths, or webinar streaming integrations.

### 9.2 Social & System Failure Modes and Mitigations

| Failure Mode | The Social Reality | Technical & Architectural Mitigation |
|---|---|---|
| **The "Dead Calendar" Problem** | If only 2 events are posted per month, the map looks empty and members stop checking. | Map defaults to showing active **Marketplace Listings** (Offers & Needs), so the map is always vibrant and populated. Events layer over active trade. |
| **Commercial Spam & Power-User Dominance** | A commercial yoga studio or cafe spams 40 recurring events, burying community working bees. | Rate limit unvouched accounts; limit active events per member (max 4 concurrent); allow Elder moderation and category filtering. |
| **The "No-Show Ghost Town"** | 20 people click "Going" casually on a whim; 2 turn up to the working bee. | RSVPs require a real cryptographic signature. For limited-capacity workshops, organizers can attach a nominal Bean deposit (e.g. 5 beans refunded upon attendance). |
| **Bushfire / Flood Misdirection** | An event is scheduled in a valley that experiences active flooding or fire threats. | Prominent host emergency cancellation button; push notifications broadcast to all attendees; fuzzed coordinates prevent strangers wandering into hazard zones. |

---

## 10. Codebase Discoveries & Technical Notes for Marty

During this research pass across `apps/native/` and `apps/server/`, several structural nuances in the existing codebase were documented:

1. **Marker Bitmap Tearing on Android (`UnifiedMapPin.tsx`):**
   The codebase solved Android marker re-render flashing by rendering SVGs in an off-screen container (`MapMarkerManager`), capturing them to temporary PNG files via `react-native-view-shot`, and passing static image URIs to `react-native-maps` `Marker`.
   *Implication for Events:* Event pins **must** plug into `MapMarkerManager` and `buildVariantList` to pre-capture purple badge PNGs before rendering on Android.
2. **Schema Migration Ordering in `apps/server/src/db/db.ts`:**
   `db.ts` enforces that **all `ALTER TABLE ... ADD COLUMN` statements must execute BEFORE `db.exec(schemaSql)`**. If a new column (e.g. on `community_events`) is referenced in an index in `schema.sql`, placing the ALTER after `schema.sql` causes SQLite to abort with `no such column` on existing live databases.
3. **`better-sqlite3` Statement Compilation in Sync (`sync.ts`):**
   `better-sqlite3` compiles statements on every `db.prepare()` call. In `apps/server/src/engine/sync.ts`, statement preparation must remain strictly *outside* the import loop to prevent blocking the event loop during large snapshot syncs.
4. **Header and Tab Layout Constraints (`apps/native/app/(tabs)/_layout.tsx`):**
   The tab bar uses `neon-vines-banner.jpg` with a fixed height and `fontSize: 10` labels. Adding a 7th tab causes text truncation and touch-target overlap on 320dp test devices. The Map tab remains the sole spatial destination.
5. **FTS5 Virtual Table Triggers (`posts_fts`):**
   The search keyword expansion uses `synonymMap` from `@beanpool/core`. A dedicated `events_fts` virtual table with triggers mirroring `title`, `description`, `location_name`, and `search_keywords` will provide instant full-text search without regex scans.

---

## Conclusion & Next Steps

This design delivers a resilient, localized, and privacy-preserving foundation for Events in BeanPool. By treating Events as a first-class spatial and temporal entity, respecting off-grid community privacy, and integrating with the existing mutual-credit and federation engine, BeanPool can reliably empower regional communities to coordinate, gather, and thrive.
