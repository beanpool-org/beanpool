# BeanPool Core Protocol

> The shared cryptographic and networking library underpinning the BeanPool Protocol. This package handles the mutual credit ledger, identity passports, decentralized governance, and Merkle-based state synchronization.

---

## 1. Core Mechanics

### 1.1 Identity (Self-Managed Passports)
Each participant generates an **Ed25519 keypair** locally on their device. There are no central accounts or passwords.
*   **Callsign**: A human-readable name chosen at first boot (e.g. "Farm-Jenny") that maps to the cryptographic public key. Callsigns are editable and sync across IndexedDB and the server.
*   **Invite Tree**: New members join by redeeming single-use invite codes, building a hierarchical accountability tree.
*   **Profiles**: Avatar, editable callsign, bio, and contact details with 3-tier visibility (hidden / trade partners / community).
*   **Signatures**: Every action (creating a pin, sending mutual credit) is mathematically signed by the mobile app's Ed25519 private key.

### 1.2 Economics (Mutual Credit + Circulation Fee)
A peer-to-peer economic layer designed to encourage circulation rather than accumulation.
*   **Mutual Credit**: Participants begin with 0.00 credits and a guaranteed credit floor of `-80 Beans`. This enables immediate participation — you can contribute value before receiving it.
*   **Community Circulation Fee (Decay)**: Positive balances decay progressively based on abundance (0.5% - 2.5% per month). The circulated value is swept into a shared `COMMONS_BALANCE`, funding community projects via governance proposals.
*   **Tax-Free Green Zone**: Balances between 0 and 200 Beans are exempt (0% fee) from circulation fee decay to encourage early economic participation.
*   **Escrow Settlement**: Marketplace deals utilize atomic `escrow_{id}` synthetic wallets to lock funds prior to service delivery, guaranteeing robust refunds on cancellation without double-charging base ledgers.
*   **Escrow Demurrage Exemption**: Funds currently locked inside active synthetic escrow wallets are entirely exempt from circulation decay.

### 1.3 Governance (Quadratic Voting)
Community proposals are voted on using quadratic voting to prevent plutocratic capture.
*   **Grand Bounties**: Community-level goals funded from the Commons Fund.
*   **Commons Escrow**: When proposals reach their vote threshold, credits are drawn from `COMMONS_BALANCE`.

### 1.4 Reputation & Trust
Community-driven accountability mechanisms:
*   **🫘 Bean Ratings**: 5-tier reputation score with optional comments (one per rater-per-target, updatable).
*   **Abuse Reporting**: Flag bad actors with reason dropdowns (spam, offensive, misleading, harassment).

---

## 2. Network & Scaling Architecture

BeanPool is designed to scale horizontally without requiring centralized infrastructure.

### 2.1 Eventual Consistency & CRDTs
Traditional bank databases use "Strict Consistency"—every server must agree on a balance before moving to the next split-second transaction. This creates massive bottlenecks.

BeanPool relies on **Conflict-Free Replicated Data Types (CRDTs)** and cryptographic Merkle Syncs (`src/merkle.ts`). A node handles transactions instantly against its local SQLite state, and asynchronously synchronizes the cryptographic proofs with other nodes. If the mesh splits in half, CRDTs mathematically guarantee that when the network merges back together, every node will eventually compute the exact same state without destroying conflicting data.

### 2.2 Direct P2P Stream State Synchronization & E2E Encrypted Messaging
Nodes dial each other using a dedicated, private libp2p tunnel (e.g., `/beanpool/sync/1.0.0`) to silently transfer historical SQLite and ledger databases peer-to-peer, and route encrypted messages.
*   **Lazy State Sync**: Merkle hash comparison + delta exchange every 15 minutes. All exported sync payloads are cryptographically signed using the node's libp2p Ed25519 private key, and verified by the importing node prior to local database writing to guarantee replication payload integrity.
*   **E2E Direct Message Encryption**: Direct message payloads are encrypted end-to-end (Noise/X25519/AES-GCM) prior to transport, meaning middle-hop nodes and the host server cannot inspect DM messages (NAT-1).
*   **Handshake Protocol**: Mutual trust verification + latency measurement via Yamux streams.
*   **Independent Connectors**: Manual trust relationships between nodes (peer / mirror / blocked).

### 2.3 GossipSub Topic Sharding
All live transactions, pins, and map updates are broadcast over libp2p pub/sub. To handle massive scale, the protocol employs **Topic Sharding**:
*   **Geographic Tiles**: The global map is divided into regions (e.g., `topic:map:nsw-north`). A user in Byron Bay only subscribes to data relevant to their physical proximity.
*   **Categorical Filtering**: A backbone node in Europe doesn't need to process updates for a "Lawn Mower Rental" in Australia.

### 2.4 Edge Computing (Smartphones as Mini-Nodes)
The BeanPool Native App (`apps/native/`) acts as an edge node. The app runs a **background Merkle sync service** (Pillar Toggle) that periodically mirrors the community ledger onto the phone via delta exchange into a local `expo-sqlite` database. 
*   **Future Vision**: At physical gatherings, phones can use Bluetooth/Local Wi-Fi to gossip transactions directly, batching and relaying to a Backbone Node once internet connectivity is restored.
*   **Organic DHT**: The Kademlia Distributed Hash Table (Kad-DHT) allows nodes to organically discover peers, route traffic around dead zones, and store offline messages in a distributed manner.
