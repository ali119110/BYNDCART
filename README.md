# Shopify Returns & Exchanges SaaS — V1 Foundation

A production-ready, logical multi-tenant SaaS foundation for a Shopify post-purchase returns, exchanges, and reverse logistics application. Built using the current Shopify React Router framework (successor to Remix), React, Polaris Web Components, App Bridge v4, Node.js, Prisma ORM, and PostgreSQL.

---

## 📁 Complete Folder Structure

```text
d:\BYNDCART
├── .env.example              # Documented local & production environment configurations
├── .gitignore                # Version control exclusions
├── package.json              # Project dependencies and script pipelines
├── shopify.app.toml          # Shopify App registration config (scopes, webhooks)
├── vite.config.ts            # Vite compile and module configuration
├── tsconfig.json             # TypeScript configuration
├── prisma/
│   └── schema.prisma         # Database schema (PostgreSQL multi-tenant models)
├── app/
│   ├── db.server.ts          # Singleton Prisma Client instance
│   ├── shopify.server.ts     # Shopify App server instance & Auth hooks
│   ├── entry.server.tsx      # React Router entry for Server-Side Rendering
│   ├── entry.client.tsx      # React Router entry for Client-Side Hydration
│   ├── root.tsx              # HTML Shell layout wrapper (Polaris, App Bridge)
│   ├── routes.ts             # React Router file routing map
│   ├── routes/
│   │   ├── app.tsx           # Embedded Admin master layout & navigation menus
│   │   ├── app._index.tsx    # Dashboard view (overview metrics & activities)
│   │   ├── app.returns.tsx   # Returns management view (index list, approve/reject)
│   │   ├── app.exchanges.tsx # Exchanges management view (replacement tracking)
│   │   ├── app.settings.tsx  # Settings configuration tabs (policies, couriers, alerts)
│   │   ├── auth.$.tsx        # Shopify oauth validation routes
│   │   └── webhooks.tsx      # Catch-all Shopify webhooks receiver with deduplication
│   └── services/
│       ├── store.server.ts   # Multi-tenant merchant and store registration service
│       ├── returns.server.ts # CRUD service layer for Return requests
│       ├── exchanges.server.ts # CRUD service layer for Exchange requests
│       ├── webhooks.server.ts # Idempotent webhook receiver & routing logic
│       └── audit.server.ts   # SaaS audit logs logging helpers
```

---

## 🛠️ Technology Decisions & Rationale

1. **Framework: React Router / Remix (Official Shopify Standard)**
   * *Rationale:* Shopify has standardized their CLI and app SDK around Remix/React Router. It provides out-of-the-box Shopify OAuth, session management, and server-side request verification, preventing vulnerabilities and saving development overhead.
2. **UI Layer: Polaris Web Components & App Bridge v4**
   * *Rationale:* Standardizing on the newer App Bridge v4 CDN script and Polaris Web Components (`<s-page>`, `<s-card>`, etc.) ensures immediate UI rendering inside the Shopify Admin frame with zero hydration lag.
3. **Database Layer: Prisma ORM & PostgreSQL**
   * *Rationale:* PostgreSQL is a production-grade relational database suited for complex structures (returns, exchanges, inventory logs). Prisma ORM offers strict type-safety, visual migrations, and integrates natively with `@shopify/shopify-app-session-storage-prisma`.
4. **Logical Multi-Tenancy Architecture**
   * *Rationale:* Instead of expensive separate databases per merchant, we use a single database with strict logical separation. Every table is bound to a `ShopifyStore` via `shopifyStoreId`, and every query is forced to filter by this ID, ensuring complete isolation of merchant data.

---

## 🗄️ Database Schema (PostgreSQL)

Defined in [schema.prisma](file:///d:/BYNDCART/prisma/schema.prisma):

```prisma
model Session {
  id                  String    @id
  shop                String
  state               String
  isOnline            Boolean   @default(false)
  scope               String?
  expires             DateTime?
  accessToken         String
  userId              BigInt?
}

model Merchant {
  id            String         @id @default(uuid())
  name          String
  email         String?
  shopifyStores ShopifyStore[]
  users         User[]
}

model ShopifyStore {
  id               String            @id @default(uuid())
  merchantId       String
  shop             String            @unique
  merchant         Merchant          @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  returnRequests   ReturnRequest[]
  exchangeRequests ExchangeRequest[]
  webhookEvents    WebhookEvent[]
  auditLogs        AuditLog[]
}

model User {
  id         String     @id @default(uuid())
  merchantId String
  email      String     @unique
  role       String     @default("MEMBER")
  merchant   Merchant   @relation(fields: [merchantId], references: [id], onDelete: Cascade)
}

model ReturnRequest {
  id             String       @id @default(uuid())
  shopifyStoreId String
  shopifyOrderId String       // gid://shopify/Order/...
  orderNumber    String       // e.g. #1001
  status         String       @default("PENDING") // PENDING, APPROVED, REJECTED, COMPLETED
  shopifyStore   ShopifyStore @relation(fields: [shopifyStoreId], references: [id], onDelete: Cascade)
  items          ReturnItem[]
}

model ReturnItem {
  id                String        @id @default(uuid())
  returnRequestId   String
  shopifyLineItemId String
  quantity          Int
  reason            String        // e.g. SIZE_TOO_SMALL
  status            String        @default("PENDING") // PENDING, RECEIVED, INSPECTED
  returnRequest     ReturnRequest @relation(fields: [returnRequestId], references: [id], onDelete: Cascade)
}

model ExchangeRequest {
  id             String         @id @default(uuid())
  shopifyStoreId String
  shopifyOrderId String
  orderNumber    String
  status         String         @default("PENDING") // PENDING, APPROVED, FULFILLED
  newOrderId     String?
  shopifyStore   ShopifyStore   @relation(fields: [shopifyStoreId], references: [id], onDelete: Cascade)
  items          ExchangeItem[]
}

model ExchangeItem {
  id                   String          @id @default(uuid())
  exchangeRequestId    String
  originalLineItemId   String
  originalQuantity     Int
  replacementVariantId String
  replacementQuantity  Int
  priceDifference      Decimal         @default(0.00) @db.Decimal(10, 2)
  exchangeRequest      ExchangeRequest @relation(fields: [exchangeRequestId], references: [id], onDelete: Cascade)
}

model WebhookEvent {
  id             String       @id // Maps to unique X-Shopify-Webhook-Id header
  shopifyStoreId String
  topic          String       // e.g. orders/create
  payload        Json
  processed      Boolean      @default(false)
  processedAt    DateTime?
  shopifyStore   ShopifyStore @relation(fields: [shopifyStoreId], references: [id], onDelete: Cascade)
}

model AuditLog {
  id             String       @id @default(uuid())
  shopifyStoreId String
  userId         String?
  action         String       // e.g. RETURN_APPROVED
  entityType     String       // e.g. ReturnRequest
  entityId       String?
  metadata       Json?
  shopifyStore   ShopifyStore @relation(fields: [shopifyStoreId], references: [id], onDelete: Cascade)
}
```

---

## 🔒 Authentication & Shopify Flow

1. **OAuth Installation:** When a merchant installs the app, Shopify redirects to `/auth` mapping to our App Auth routes.
2. **Offline Token Generation:** Shopify grants an offline access token stored in the `Session` table.
3. **Multi-Tenant Onboarding:** Our dynamic `afterAuth` hook intercepts installation, fetches the store profile name/email, and registers or updates the `Merchant` and `ShopifyStore` records in PostgreSQL using [store.server.ts](file:///d:/BYNDCART/app/services/store.server.ts).
4. **SaaS Session Routing:** The admin loader executes `authenticate.admin(request)` on every page load to fetch the current store session, identifying the correct tenant using the verified shop name (`session.shop`), ensuring security boundary integrity.

---

## 📡 Webhook Architecture & Idempotency

* **Generic Route:** Webhook registrations are pointed to the single catch-all `/webhooks` route defined in [webhooks.tsx](file:///d:/BYNDCART/app/routes/webhooks.tsx).
* **Deduplication:** Shopify includes a unique `X-Shopify-Webhook-Id` header with every dispatch. Our [webhooks.server.ts](file:///d:/BYNDCART/app/services/webhooks.server.ts) attempts to insert this ID as the primary key in the `WebhookEvent` table. If the database returns a unique constraint error (P2002), we ignore the webhook as a duplicate, preventing double-processing.
* **Resilience:** Unprocessed webhooks are logged and updated to `processed = true` only *after* their specific handler runs successfully, allowing auditability and re-triggering of failed events.

---

## ⚙️ Environment Variables

Copy `.env.example` to create `.env`:

| Key | Description | Example |
|---|---|---|
| `SHOPIFY_API_KEY` | Client ID of your Shopify App (Partners Dashboard) | `4f32c918a23...` |
| `SHOPIFY_API_SECRET` | Client Secret of your Shopify App | `shpss_18d9f4a...` |
| `SCOPES` | Scopes requested (minimum scopes) | `read_orders,write_orders,read_products` |
| `SHOPIFY_APP_URL` | Local tunneling public HTTPS URL | `https://my-tunnel.ngrok-free.app` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/byndcart?schema=public` |

---

## 🚀 Local Development Setup

### Prerequisites
* Node.js v20.19+ (Vite compatible)
* A PostgreSQL instance (local or hosted, e.g., Supabase/Neon)
* Shopify Partner Account & Dev Store
* Ngrok or Cloudflare Tunneling (or run `npm run dev` to let Shopify CLI spin up Cloudflare Tunneling automatically)

### Setup Steps
1. **Clone & Install Dependencies:**
   ```bash
   npm install --legacy-peer-deps
   ```
2. **Configure Environment:**
   * Create a `.env` file matching the table above.
3. **Database Migrations:**
   * Point `DATABASE_URL` to your PostgreSQL database.
   * Run migrations to provision the schemas:
     ```bash
     npx prisma db push
     ```
4. **Start Development Tunnel & Dev Server:**
   ```bash
   npm run dev
   ```
   *Follow the CLI prompts to select your Partner organization and development store.*

---

## 📈 Scaling to Thousands of Stores

To scale this SaaS model from 10 to 10,000+ stores:

1. **Prisma Connection Pooling:** Connect via a pooler like **PgBouncer** or **Supabase Connection Pooler** (using transaction mode). This prevents running out of PostgreSQL client connections as web application nodes scale.
2. **Asynchronous Webhook Queueing:** Instead of processing webhooks inline within the web request handler, the `/webhooks` endpoint should quickly validate the signature, write to `WebhookEvent`, push a message to a queue (e.g., **Redis BullMQ** or **AWS SQS**), and return a `200 OK` to Shopify immediately. Background workers then consume from the queue, preventing request timeouts during traffic spikes.
3. **Read Replicas:** Point reporting query routers to a read-replica PostgreSQL database, keeping the primary write master unburdened for critical transactional mutations (returns, exchanges, and webhooks).
4. **Multi-Region Hosting:** Host front-end nodes on Vercel or Cloudflare Pages, with regional backend API instances colocated with your database (e.g., AWS us-east-1) to reduce network roundtrip latencies.

---

# 🛑 NEXT DEVELOPMENT PLAN (Incremental Phases)

Below is the step-by-step roadmap to advance this SaaS foundation into a production-ready product listed on the Shopify App Store.

```mermaid
graph TD
    V1[V1: Foundation] --> P1[Phase 1: Customer Returns Portal]
    P1 --> P2[Phase 2: Shipping & Carrier APIs]
    P2 --> P3[Phase 3: Exchange & Refund Logic]
    P3 --> P4[Phase 4: Warehouse Verification UI]
    P4 --> P5[Phase 5: Subscriptions & Billing]
    P5 --> P6[Phase 6: Advanced Analytics & Hardening]
```

### Phase 1: Customer Returns Portal
* **Goal:** Enable end-customers to request returns/exchanges without merchant admin intervention.
* **Deliverables:**
  * Standalone front-end client (Customer Portal) hosted at `/portal/:shop`.
  * Authentication matching Customer Email and Order Number using Shopify Admin REST API.
  * Interactive UI selecting items, return quantities, reasons, and return method (ship-back vs drop-off).
  * Save requests to database under `PENDING` status.

### Phase 2: Shipping & Carrier Integration
* **Goal:** Automate label generation and tracking.
* **Deliverables:**
  * Integrate multi-carrier logistics APIs (e.g., ClickPost, ShipEngine, Shippo).
  * Automatically request returns shipping labels upon merchant approval (`ReturnRequest` APPROVED status).
  * Generate PDF label URLs and store them in database.
  * Integrate webhooks for tracking updates (e.g., Package Picked Up, In Transit, Delivered).

### Phase 3: Exchange & Refund Automation
* **Goal:** Complete exchanges and refunds automatically via Shopify API.
* **Deliverables:**
  * Implement automatic draft order generation in Shopify for approved exchanges using Shopify GraphQL API (`draftOrderCreate`).
  * Add support for capturing price differences (if replacement item costs more).
  * Implement auto-refunds using Shopify's Refund GraphQL API (`refundCreate`) once returns are marked completed.

### Phase 4: Warehouse processing & Verification UI
* **Goal:** Build interface for shipping receiving teams.
* **Deliverables:**
  * A dedicated dashboard for warehouse workers to inspect packages.
  * Item-by-item condition marking (e.g., Re-stockable, Damaged, Discard).
  * One-click trigger for restock inventory and automatic customer notification dispatches.

### Phase 5: Billing, Subscription & Pricing Tiers
* **Goal:** Monetize the application.
* **Deliverables:**
  * Integrate Shopify Billing API (recurring subscription and usage-based billing).
  * Setup plans: **Free** (up to 10 returns/mo), **Growth** ($29/mo + usage fees), **Enterprise** custom limits.
  * Restrict UI dashboards based on active plan status.

### Phase 6: Analytics, Webhook Queues & Review Audit
* **Goal:** Harden infrastructure for high traffic and pass Shopify App Store review.
* **Deliverables:**
  * Migrate webhook processing to BullMQ / Redis to handle heavy black-friday load.
  * Build rich charts showing return reasons, return rates, and saved revenue (exchanges).
  * Conduct full GDPR compliance audit and submit the application for Shopify App Store review.
