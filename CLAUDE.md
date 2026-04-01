# CLAUDE.md — Tetsuclaw

## What This Is

Tetsuclaw is a work operating system for English-speaking operators in Japan. It systematically disintermediates Japanese corporate infrastructure through AI agents, clean data architecture, and human referral networks — by total legal and ethical means.

Built by Tetsuou (哲王) — tyrannosaurusjr on GitHub — as a solo operator tool that scales without partners, investors, or Japan Inc. consensus culture.

**Core principle: If you build for ideal conditions, it will fail. If you build for chaos, it will win.**

---

## Architecture

### Nanoclaw (Core Infrastructure)
The backend layer. Users never interact with it directly.
- Data ingestion and normalization
- Identity resolution across fragmented systems
- Cross-platform synchronization
- Automation and rule execution
- Single source of truth

### Tetsuclaw (Operator Interface)
The user-facing layer. Delivered via Telegram bot (Tetsuko).
- Structured agent tools for navigating Japan's systems
- Natural language interface in English
- Referral routing to vetted human professionals
- All agents accessible from a single Telegram conversation

---

## Target User

Primary: English-speaking business operators in Japan
- Founders, consultants, freelancers, small business owners
- Dealing with Japanese bureaucracy, language barriers, fragmented systems
- Tech-comfortable, high agency, frustrated with status quo
- Not waiting for Japan to fix itself

Secondary (future): Japan-facing operators based outside Japan

---

## The Agent Roster

### Money
Tax, payments, accounting.
- Stripe integration — cards, konbini, furikomi (virtual account numbers)
- Bank transfer parsing and auto-fill
- Receipt logging and OCR
- Transaction categorization
- 確定申告 prep, blue return logic
- 消費税 calculation (10%/8% split)
- Monthly summaries, accountant-ready exports
- Referral to English-speaking 税理士 partners (revenue share)

### People
Contacts, relationships, identity resolution.
- Unified contact database across phone, email, Stripe, Luma, events
- Tagging: client, lead, legal, vendor, partner
- Interaction history: notes, transactions, events attended
- Cross-system identity resolution with confidence scoring
- Name/email/company matching and merge logic
- Smart grouping by activity and relationship type
- Keigo and relationship etiquette context layer
- Referral to bilingual business consultants, networking orgs (ACCJ, BCCJ, FCCJ) (revenue share)

### Time
Scheduling, deadlines, daily ops.
- Calendar management
- Deadline tracking and reminders
- Action prompts: "You have 3 uncategorized transactions"
- Workflow checklists: company setup, visa renewal, tax season
- Japanese fiscal calendar awareness (April–March)
- National holiday awareness
- "What do I need to do today" daily briefing
- Referral to bilingual PA/VA services (revenue share)

### Intel
Research, scouting, market information.
- Web search and content retrieval
- Property scouting (akiya, rental, commercial)
- Competitive research
- News and regulatory monitoring
- Japan-specific source awareness
- Referral to Japan market research firms, bilingual consultants (revenue share)

### Words
Content, copy, communications.
- Blog posts, SEO articles, product descriptions
- Email and message drafting
- Japanese cultural context baked into output
- Bilingual output when needed
- Tone awareness for Japanese business communication
- Referral to bilingual copywriters, translation agencies, PR firms (revenue share)

### Events
Event discovery, flyer parsing, listings.
- OCR on event flyers (image input via Telegram)
- Scrapes online listings
- Categorizes by type: music, business, cultural, networking
- Weekly "what's on" digest
- Feeds into People agent (who attended what)
- Referral to ticket platforms, event organizers, venue partners (affiliate/commission)

### Home
Housing, real estate, neighborhood research.
- Rental search and translation
- Lease clause flagging
- Akiya research and valuation
- Neighborhood context for foreign operators
- Referral to foreigner-friendly real estate agents, relocation services (revenue share)

### Transit
Getting around Japan.
- Train route planning — JR, private lines, subway
- Multi-modal itinerary assistance: combines Shinkansen, limited express, local rail, bus, ferry, and taxi into single end-to-end journey plans
- Example: Takasaki → Tokyo by Shinkansen, Tokyo → Shimoda by Odoriko, Shimoda → Tōshima by ferry
- Fare calculation across operators and modes
- Reserved seat vs unreserved guidance
- IC card vs ticket guidance per leg
- Last train alerts
- IC card balance reminders
- Airport transfer logistics
- Referral to travel concierge and Japan Rail Pass vendors (revenue share)

### Health
Medical access and navigation.
- English-speaking clinic and doctor directory
- Prescription translation
- 国民健康保険 navigation for newcomers
- Appointment reminders
- Referral to vetted English-speaking medical providers, international health insurance providers (revenue share)

### Legal
Legal access, routing, case tracking.
- Document translation and plain-English summary
- Deadline and renewal tracking (visa, residence card, contracts)
- Contract clause flagging
- Legal intake: classify issue, structure problem summary
- Advisor directory: tagged by specialization (visa, corporate, tax)
- Case tracking: status, documents, communication log
- Referral to English-speaking 行政書士 and lawyers (revenue share)
- **Never gives legal advice. Always routes to licensed professionals.**
- Full audit log of every Legal agent interaction
- First-use disclaimer required before activation

### Docs
Document repository and retrieval.
- Central storage for tax, visa, contracts, invoices
- Tagging system
- OCR (Phase 2)
- Search by keyword and tag
- File linking to contacts and legal cases
- Target: any document retrievable in under 10 seconds

---

## Referral Network (Revenue Layer)

Each agent routes to vetted human professionals:

| Agent | Referral Target | Model |
|-------|----------------|-------|
| Money | English-speaking 税理士 | Per retained client |
| People | Bilingual business consultants, ACCJ/BCCJ/FCCJ | Per introduction or membership |
| Time | Bilingual PA/VA services | Per retained client |
| Intel | Japan market research firms, bilingual consultants | Per project referral |
| Words | Bilingual copywriters, translation agencies, PR firms | Per project |
| Events | Ticket platforms, event organizers, venue partners | Affiliate/commission |
| Home | Foreigner-friendly real estate agents, relocation services | Per transaction |
| Transit | Japan Rail Pass vendors, travel concierge, airport transfers | Affiliate/commission |
| Health | English-speaking clinics, international health insurance | Per referral |
| Legal | English-speaking 行政書士 and lawyers | Per retained client |
| Docs | Cloud storage partners, bilingual document services | Per referral |

Positioning: **AI-first, human-backed.**

---

## Data Flow

**Inputs**
- Telegram messages, images, documents
- Stripe API
- CSV uploads
- Manual entry
- Web scraping
- OCR (Phase 2)
- Google Drive / email parsing (Phase 3)

**Processing (Nanoclaw core)**
1. Normalize
2. Resolve identity
3. Store unified records
4. Apply rules and triggers

**Outputs (Tetsuclaw)**
- Telegram responses
- Reports and exports
- Workflow prompts
- Referral routing
- Dashboard (Phase 2)

---

## MVP Scope

**Phase 1 — Build This First**
- Tetsuko Telegram bot live and always-on
- Money: Stripe integration + manual transaction input
- People: basic contact system
- Docs: upload and tagging
- Time: basic reminders and action prompts

**Phase 2**
- Identity resolution engine
- Contact merging
- Events: OCR flyer parsing
- Legal: intake and routing
- Workflow prompt expansion

**Phase 3**
- Full referral network
- Home, Health, Transit agents
- Dashboard UI
- Google Drive / email integration

**Phase 4**
- Advanced OCR and document search
- Automation rules
- VoIP/eSIM infrastructure layer
- Platform expansion beyond Telegram

---

## Infrastructure

- **Bot:** Tetsuko (Telegram, @Tetsukobot)
- **Runtime:** Tetsuclaw fork of NanoClaw
- **Container isolation:** Docker (Linux VPS)
- **Hosting:** DigitalOcean Droplet — Singapore region, always-on, independent of home internet (174.138.22.14)
- **Storage:** SQLite + per-group filesystems
- **Payments:** Stripe
- **Language:** TypeScript / Node.js 20+

---

## Security

Tetsuclaw's security model is inherited from NanoClaw's container isolation architecture:
- Every agent session runs in its own isolated Linux container
- Agents can only access directories explicitly mounted — no ambient system access
- Each group has its own filesystem, IPC namespace, and process space
- Groups cannot access other groups' data
- Entire codebase is small and fully auditable
- No Cloudflare, no Zero Trust — security is OS-level container isolation

**Data sensitivity by agent:**

| Agent | Sensitivity | Notes |
|-------|------------|-------|
| Legal | 🔴 Critical | Full audit log, disclaimer required, no advice given |
| Money | 🔴 Critical | Stripe webhook validation, no raw card data ever stored |
| Docs | 🔴 Critical | Encrypted storage, access-controlled |
| People | 🟡 High | PII — contact data encrypted at rest |
| Health | 🟡 High | Medical context — not stored beyond session unless explicit |
| Home | 🟡 High | Financial and location data |
| Time | 🟢 Standard | Calendar data, low sensitivity |
| Intel | 🟢 Standard | Web research, no PII |
| Words | 🟢 Standard | Content generation, no PII |
| Events | 🟢 Standard | Public event data |
| Transit | 🟢 Standard | Route data, no PII |

**⚠️ Beta disclosure:** Tetsuclaw is a personal fork under active development and has not been independently security audited. Do not input sensitive financial, legal, or medical data until a stable, audited release is available. Use at your own risk.

---

## Key Constraints

- Must be simple for non-technical users
- Must handle incomplete and messy data
- Must not assume Japanese fluency
- Must not rely on perfect API access
- Must work on low-bandwidth mobile connections
- Must never give legal or financial advice directly

---

## Non-Goals

Do NOT build:
- Full accounting software (not competing with freee or MoneyForward)
- Legal advisory AI (routing and structuring only)
- Complex ERP
- Anything requiring a Japanese corporate partner

---

## Strategic Positioning

**Surface:** A practical operating system for foreigners doing business in Japan.

**Underneath:** Systematic disintermediation of Japanese corporate infrastructure by total legal and ethical means. The people of a country ought to be able to conduct their business to a bare minimum of efficiency. Tetsuclaw makes that possible without violence, without revolution — just good modern business practice, available to anyone.

**One-man army infrastructure. Zero consensus meetings required.**

---

## Success Criteria

- Users see all financial activity in one place
- Users find any document in under 10 seconds
- Users know what actions to take next
- Users reduce reliance on fragmented Japanese systems
- System becomes daily-use infrastructure
- Each referral generates revenue
- Solo operator can run a real Japan business without a single Japanese corporate contract
