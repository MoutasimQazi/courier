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
  "pagination": {
    "cursor": null
  }
}
```

Raw bodies, Gmail tokens, OTPs, and unrelated emails are not returned.

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
