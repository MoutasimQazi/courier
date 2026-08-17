import dotenv from "dotenv";

dotenv.config({ quiet: true });

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Unlike parsePositiveInteger, zero is a meaningful value here rather than a
// mistake: it is how an interval is switched off.
const parseInterval = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
};

const env = {
  port: parsePositiveInteger(process.env.PORT, 5010),
  nodeEnv: process.env.NODE_ENV || "development",
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || "",
  frontendBaseUrl: process.env.FRONTEND_BASE_URL?.trim() || "",
  unipile: {
    baseUrl: process.env.UNIPILE_BASE_URL?.trim() || "",
    apiKey: process.env.UNIPILE_API_KEY?.trim() || "",
    timeout: parsePositiveInteger(process.env.REQUEST_TIMEOUT, 10000),
    callbackSecret: process.env.UNIPILE_CALLBACK_SECRET?.trim() || "",
    webhookSecret: process.env.UNIPILE_WEBHOOK_SECRET?.trim() || "",
  },
  sync: {
    historyDays: parsePositiveInteger(process.env.SYNC_HISTORY_DAYS, 30),
    // Applies only to the first sync of an account, when there is no watermark
    // to work from and the whole history window has to be read cold.
    backfillLimit: parsePositiveInteger(process.env.SYNC_BACKFILL_LIMIT, 200),
    // Safety brake on incremental runs, which are normally bounded by "how much
    // new mail arrived" rather than by a cap.
    maxEmails: parsePositiveInteger(process.env.SYNC_MAX_EMAILS, 500),
    overlapMinutes: parsePositiveInteger(process.env.SYNC_OVERLAP_MINUTES, 360),
    ledgerSize: parsePositiveInteger(process.env.SYNC_LEDGER_SIZE, 500),
    concurrency: parsePositiveInteger(process.env.SYNC_CONCURRENCY, 10),
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID?.trim() || "",
    web: {
      apiKey: process.env.FIREBASE_WEB_API_KEY?.trim() || "",
      authDomain: process.env.FIREBASE_AUTH_DOMAIN?.trim() || "",
      appId: process.env.FIREBASE_APP_ID?.trim() || "",
    },
  },
  cpanel: {
    baseUrl: process.env.CPANEL_BASE_URL?.trim().replace(/\/$/, "") || "",
    username: process.env.CPANEL_USERNAME?.trim() || "",
    apiToken: process.env.CPANEL_API_TOKEN?.trim() || "",
    emailDomain: process.env.CPANEL_EMAIL_DOMAIN?.trim().toLowerCase() || "",
    timeout: parsePositiveInteger(process.env.CPANEL_REQUEST_TIMEOUT, 15000),
    mailboxQuotaMb: parsePositiveInteger(process.env.CPANEL_MAILBOX_QUOTA_MB, 100),
    mailboxPrefix: process.env.CPANEL_MAILBOX_PREFIX?.trim().toLowerCase() || "fwd",
    // Forwarded mail is extracted to JSON and then erased from the mailbox, so
    // the quota never fills and no message body is retained. This is a true
    // expunge with no Trash copy: once a sync completes, the stored insight is
    // the only surviving record of the email. Set false to keep the messages
    // and mark them read instead.
    deleteAfterSync: parseBoolean(process.env.CPANEL_DELETE_AFTER_SYNC, true),
    // How often the server sweeps every connected forwarding mailbox on its
    // own. Zero switches the sweep off and leaves syncing to the button.
    sweepMinutes: parseInterval(process.env.CPANEL_SYNC_INTERVAL_MINUTES, 15),
    imap: {
      host: process.env.CPANEL_IMAP_HOST?.trim() || "",
      port: parsePositiveInteger(process.env.CPANEL_IMAP_PORT, 993),
      secure: parseBoolean(process.env.CPANEL_IMAP_SECURE, true),
      syncLimit: parsePositiveInteger(process.env.CPANEL_IMAP_SYNC_LIMIT, 250),
    },
    smtp: {
      host: process.env.CPANEL_SMTP_HOST?.trim() || "",
      port: parsePositiveInteger(process.env.CPANEL_SMTP_PORT, 465),
      secure: parseBoolean(process.env.CPANEL_SMTP_SECURE, true),
    },
    credentialsKey: process.env.FORWARDING_CREDENTIALS_KEY?.trim() || "",
  },
};

export default env;
