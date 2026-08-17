import dotenv from "dotenv";

dotenv.config({ quiet: true });

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
