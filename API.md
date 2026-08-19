# Email Backend API

Base URL examples:

- Local: `http://localhost:5020`
- Production: your deployed HTTPS backend URL

## Authentication

Flutter-facing endpoints require:

```http
Authorization: Bearer <FIREBASE_ID_TOKEN>
Accept: application/json
```

The backend verifies the token with Firebase Admin and derives the UID. The client never sends a Firebase UID or Unipile account ID.

## Connection lifecycle

### Start

```http
POST /api/connections/start
Authorization: Bearer <FIREBASE_ID_TOKEN>
```

Success returns `data.url`. Open that URL in the system browser so Unipile can authorize Gmail, Outlook, or IMAP.

### Status

```http
GET /api/connections/status
Authorization: Bearer <FIREBASE_ID_TOKEN>
```

`data.status` is `not_connected`, `connecting`, `connected`, or `expired`. No Unipile account ID is returned.

Each connection may include its safe mailbox address, provider, status, and timestamps.

### Reconnect

```http
POST /api/connections/reconnect
Authorization: Bearer <FIREBASE_ID_TOKEN>
```

Success returns `data.url`. A `409` means no mailbox needs reconnection.

### Disconnect

```http
DELETE /api/connections
Authorization: Bearer <FIREBASE_ID_TOKEN>
```

This deletes the authenticated user's mapped accounts from Unipile and removes their Firestore mappings.

## Email intelligence

### Sync

```http
POST /api/emails/sync?limit=250
Authorization: Bearer <FIREBASE_ID_TOKEN>
```

The backend resolves account IDs from the verified UID's Firestore record. The response contains only:

```json
{
  "success": true,
  "orders": [],
  "subscriptions": [],
  "giftCards": [],
  "pagination": {
    "cursor": null
  }
}
```

Raw bodies, Gmail tokens, OTPs, and unrelated emails are not returned.

### Order records

Every entry in `orders` carries these fields. A field is `null` when the email
did not state it — never a guess.

| Field | Type | Notes |
| --- | --- | --- |
| `sourceId` | string | Stable identity of the *order*, not the email. Follow-up mail about the same parcel updates this record in place. |
| `type` | `"order"` | |
| `merchant`, `merchantDomain` | string | Brand name and the domain it was derived from. |
| `orderId`, `orderName` | string | The merchant's reference, and what a person would call the purchase. |
| `orderDate` | `YYYY-MM-DD` | |
| `items` | string[] | Product names, most prominent first, at most 10. |
| `amount`, `currency` | number, ISO code | |
| `status` | string | Title-cased shipping status: `Shipped`, `Out_for_delivery`, `Delivered`, … |
| `trackingId`, `trackingUrl`, `carrier` | string | |
| `deliveryDate` | `YYYY-MM-DD` | Estimated delivery. |
| `productUrl` | URL | The page for the item itself. |
| `manageUrl` | URL | The order's own page — view, amend, cancel, invoice. Separate from `productUrl`. |
| `serviceUrl`, `logoUrl`, `imageUrl` | URL | Merchant home page, brand logo, product picture. |
| `returnType` | `"returnable"` \| `"replaceable"` \| `"non_returnable"` \| `null` | A stated return period on its own reads as `returnable`. |
| `returnWindowDays` | number | **`0` when no return period applies** — never null. |
| `returnBy`, `returnByIsEstimated` | `YYYY-MM-DD`, boolean | The deadline, and whether it was counted forward from an estimated delivery rather than stated outright. |
| `category` | enum | `shopping`, `electronics`, `fashion`, `groceries`, `pharmacy`, `food`, `other`. |
| `receivedAt`, `emailId` | ISO timestamp, string | The email this version of the record came from. |

### Gift card records

Gift cards are their own kind, returned in `giftCards` rather than mixed into
`orders`, and stored in their own `giftCards` collection.

| Field | Type | Notes |
| --- | --- | --- |
| `sourceId` | string | `gift_card:<domain>:<reference>` — the prefix keeps a card and an order sharing a reference apart. |
| `type` | `"gift_card"` | |
| `merchant`, `merchantDomain` | string | The brand the card is spent at. |
| `orderId`, `orderName`, `orderDate` | string, string, `YYYY-MM-DD` | |
| `amount`, `currency` | number, ISO code | The card's face value, not the price paid for it. |
| `trackingId`, `trackingUrl`, `carrier`, `status`, `deliveryDate` | | A posted card is a parcel like any other. All null for an emailed card, which is the common case. |
| `manageUrl`, `productUrl`, `serviceUrl`, `logoUrl`, `imageUrl` | URL | |
| `receivedAt`, `emailId` | ISO timestamp, string | |

Covers a gift card, voucher, e-gift certificate, or store credit — bought or
received, physical or emailed. There are deliberately no return fields (a card
is not sent back) and no `category` (the kind *is* the category). The redemption
code is never extracted or stored: it is a bearer credential, and the prompt
refuses to return it.

An offer *of* a gift card ("win a ₹500 voucher") is marketing and is not
captured, and a gift card bought as one line of a larger order stays with that
order.

### Subscription records

| Field | Type | Notes |
| --- | --- | --- |
| `sourceId` | string | Stable identity of the *service*. Every renewal updates one record. |
| `type` | `"subscription"` | |
| `merchant`, `merchantDomain` | string | |
| `orderName`, `plan` | string | The service and plan in plain words. |
| `amount`, `currency` | number, ISO code | |
| `billingCycle` | `weekly` \| `monthly` \| `quarterly` \| `yearly` | |
| `renewalDate` | `YYYY-MM-DD` | The **next** charge. Derived from the billing cycle when the email printed no future date; see below. |
| `renewalDateIsEstimated` | boolean | True when the date was worked out rather than stated. |
| `trialEndsAt` | `YYYY-MM-DD` | |
| `subscriptionStatus` | `"active"` \| `"trial"` \| `"cancelled"` \| `null` | `trial` means a free trial that has not yet been charged; it becomes `active` once it converts. |
| `paymentType` | enum \| `null` | `card`, `upi`, `netbanking`, `wallet`, `paypal`, `apple_pay`, `google_pay`, `bank_transfer`, `other`. |
| `cardLast4` | string \| `null` | The last four digits only — never more, whatever the email printed. |
| `manageUrl` | URL | The billing page: change or cancel the plan, update the payment method. Never an unsubscribe link. |
| `serviceUrl`, `logoUrl`, `imageUrl` | URL | |
| `category` | enum | `entertainment`, `ai_tools`, `designing_tools`, `productivity`, `music_and_video`, `other`. |
| `receivedAt`, `emailId` | ISO timestamp, string | |

Filter free trials on `subscriptionStatus === "trial"`; `trialEndsAt` carries the
date when the email gave one.

**How `renewalDate` is worked out.** Most billing mail never prints a future
date: a receipt says what was just taken, and a renewal notice often names the
date the plan *last* renewed. So the next charge is projected from the last one
plus the billing cycle, anchored on the first of these the email gave — the date
it stated, the date the payment was taken, or the day the mail arrived. A stated
date already in the past is rolled forward by whole cycles. During a trial, the
next charge is `trialEndsAt`.

Two cases stay empty on purpose: a **cancelled** plan has no next charge (its
stated date is reported as-is, unrolled), and a plan with **no known billing
cycle** cannot be projected — a guessed date in the past is worse than a blank
field. Rolling stops at the email's own date, not today's, so a record reads the
same every time rather than drifting.

### One email

```http
GET /api/emails/<emailId>
Authorization: Bearer <FIREBASE_ID_TOKEN>
```

The backend searches only mailboxes owned by the verified UID. Do not send `accountId`.

## Server-to-server endpoints

Flutter must not call these endpoints.

### Hosted Auth callback

```http
POST /api/connections/unipile-callback?token=<UNIPILE_CALLBACK_SECRET>
```

### New email webhook

```http
POST /api/webhooks/unipile/email
Unipile-Auth: <UNIPILE_WEBHOOK_SECRET>
Content-Type: application/json
```

Register an Unipile Email webhook with callback URL `<PUBLIC_BASE_URL>/api/webhooks/unipile/email` and custom header `Unipile-Auth`.

Only `mail_received` is processed. The backend maps `account_id` to a Firebase UID, fetches the complete email, parses it, and stores only order/subscription data.

### Account status webhook

```http
POST /api/webhooks/unipile/account-status
Unipile-Auth: <UNIPILE_WEBHOOK_SECRET>
Content-Type: application/json
```

Register an Unipile Account Status webhook with the same custom header. `OK` becomes `connected`; other lifecycle messages become `expired`.

## Error format

```json
{
  "success": false,
  "message": "Description of the problem.",
  "errors": null
}
```

Common codes: `400`, `401`, `404`, `409`, `502`, `503`, and `504`.
