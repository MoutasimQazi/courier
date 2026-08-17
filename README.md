# Email Intelligence Backend

Multi-user Express application that lets each Firebase-authenticated user connect one or more Gmail, Microsoft, or IMAP mailboxes through Unipile Hosted Auth. The backend retrieves mailbox data, extracts courier and subscription intelligence, and stores results beneath the authenticated Firebase user.

## Flow

`Firebase sign-in -> Unipile Hosted Auth -> account ID stored in Firestore -> user mailbox sync -> deterministic parser -> Firestore`

Users never enter Unipile account IDs. Unipile returns the ID to the protected callback and the backend stores it under the Firebase UID.

## Requirements

- Node.js 22 or newer
- Firebase project with Authentication and Cloud Firestore enabled
- Firebase web application configuration
- Firebase Admin service-account credentials
- Unipile DSN and access token
- Public HTTPS URL for the Unipile callback

The Unipile access token needs:

- Messaging: Read
- Accounts: Read
- Accounts: Write

## Firebase setup

1. In Firebase Console, open **Authentication -> Sign-in method**.
2. Enable **Email/Password** and/or **Google**.
3. In **Project settings -> General**, create/select a Web app and copy its configuration.
4. Add both `localhost` and the production domain to Authentication's authorized domains.
5. Keep the Firebase Admin JSON file private and configure its absolute path using `GOOGLE_APPLICATION_CREDENTIALS`.

## Configuration

Copy `.env.example` to `.env`.

```env
PORT=5020
NODE_ENV=development
PUBLIC_BASE_URL=https://email-api.example.com
UNIPILE_BASE_URL=https://your-dsn.unipile.com:port/api/v1
UNIPILE_API_KEY=your_access_token
UNIPILE_CALLBACK_SECRET=a_long_random_value
UNIPILE_WEBHOOK_SECRET=a_different_long_random_value
REQUEST_TIMEOUT=60000
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_WEB_API_KEY=your_web_api_key
FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
FIREBASE_APP_ID=your_web_app_id
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/firebase-service-account.json
```

`PUBLIC_BASE_URL` must be publicly reachable by Unipile. A localhost callback requires a secure tunnel during development.

For local testing, use `npm run local`. It starts a fresh Cloudflare quick tunnel,
passes its temporary public URL to the Node process, and shuts the tunnel down
when the backend stops. This avoids manually replacing `PUBLIC_BASE_URL` after
each computer restart. Production continues to use `npm start` and the permanent
URL configured in `.env`.

Generate `UNIPILE_CALLBACK_SECRET` as a long random value. Never expose it, the Unipile API key, `.env`, or Firebase Admin JSON in client code or deployment archives.

## API

Public:

- `GET /api/health`
- `GET /api/config`
- `POST /api/connections/unipile-callback`
- `POST /api/webhooks/unipile/email`
- `POST /api/webhooks/unipile/account-status`
- `POST /api/accounts/unipile/callback` — authenticated using the callback secret

Firebase-authenticated:

- `POST /api/connections/start`
- `GET /api/connections/status`
- `POST /api/connections/reconnect`
- `DELETE /api/connections`
- `GET /api/accounts`
- `POST /api/accounts/connect`
- `GET /api/emails`
- `GET /api/emails/:id`
- `POST /api/emails/sync`

Protected requests require:

```http
Authorization: Bearer FIREBASE_ID_TOKEN
```

The old `x-user-id` header is no longer accepted.

Flutter must not send a Firebase UID or Unipile account ID. The backend derives the UID from the verified Firebase token and resolves account IDs from Firestore.

See [API.md](./API.md) for the Flutter contract and webhook setup.

## Firestore model

```text
users/{firebaseUid}
users/{firebaseUid}/connectedAccounts/{stableHash}
users/{firebaseUid}/orders/{stableHash}
users/{firebaseUid}/subscriptions/{stableHash}
```

## Commands

```bash
npm install
npm run check
npm run dev
```
# cPanel autoforwarding mailboxes

This optional Node.js/Express feature runs beside the existing Unipile integration. It creates one private cPanel mailbox for each authenticated Firebase user. The user forwards order and subscription emails to that generated address, and the backend reads unseen messages over IMAP and passes them through the existing deterministic extractor.

All endpoints require `Authorization: Bearer <Firebase ID token>`:

- `POST /api/forwarding/enable` creates a mailbox once or returns the user's existing mailbox.
- `GET /api/forwarding/status` reports whether that user has a mailbox.
- `GET /api/forwarding/verification` safely returns an official Gmail forwarding confirmation link/code received by that user's mailbox.
- `POST /api/forwarding/verification/complete` records that the authenticated user completed Google's confirmation page.
- `POST /api/forwarding/sync` reads unseen mail, stores accepted orders/subscriptions, and returns only parsed JSON.
- `DELETE /api/forwarding` removes the cPanel mailbox and its Firestore mapping.

Generated mailbox passwords are encrypted with AES-256-GCM before Firestore storage and are never included in API responses. Configure the `CPANEL_*` and `FORWARDING_CREDENTIALS_KEY` variables shown in `.env.example`. The feature uses the Firestore path `users/{uid}/forwarding/mailbox`; existing Unipile account mappings and endpoints are unchanged.
