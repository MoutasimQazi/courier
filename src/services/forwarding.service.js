import { randomBytes } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import env from "../config/env.js";
import logger from "../utils/logger.js";
import { decryptCredential, encryptCredential } from "../utils/credentialCipher.js";
import cpanelService from "./cpanel.service.js";
import firebaseService from "./firebase.service.js";
import { dedupeInsights, transformEmail } from "./email.service.js";

const publicMailbox = (mailbox) => mailbox ? {
  email: mailbox.email,
  status: mailbox.status,
  createdAt: mailbox.createdAt ?? null,
  updatedAt: mailbox.updatedAt ?? null,
  lastSyncedAt: mailbox.lastSyncedAt ?? null,
  gmailForwardingStatus: mailbox.gmailForwardingStatus ?? "not_started",
} : null;

const requireImapConfiguration = () => {
  if (!env.cpanel.imap.host) {
    const error = new Error("CPANEL_IMAP_HOST is required for forwarding synchronization.");
    error.statusCode = 503;
    throw error;
  }
};

const createImapClient = (mailbox) => {
  const client = new ImapFlow({
    host: env.cpanel.imap.host,
    port: env.cpanel.imap.port,
    secure: env.cpanel.imap.secure,
    connectionTimeout: env.cpanel.timeout,
    greetingTimeout: env.cpanel.timeout,
    socketTimeout: Math.max(env.cpanel.timeout * 2, 30000),
    auth: { user: mailbox.email, pass: decryptCredential(mailbox.encryptedPassword) },
    logger: false,
  });
  // ImapFlow also emits connection errors. A listener prevents a transient
  // mail-server timeout from terminating the entire Express process.
  client.on("error", () => {});
  return client;
};

const requireConnectedMailbox = async (userId) => {
  requireImapConfiguration();
  const mailbox = await firebaseService.getForwardingMailbox(userId);
  if (!mailbox || mailbox.status !== "connected") {
    const error = new Error("Enable an autoforwarding mailbox before continuing.");
    error.statusCode = 409;
    throw error;
  }
  return mailbox;
};

const decodeHtmlEntities = (value) => String(value || "")
  .replace(/&amp;/gi, "&")
  .replace(/&#x3D;|&#61;/gi, "=")
  .replace(/&quot;/gi, '"');

const extractGmailVerification = (parsed) => {
  const sender = parsed.from?.value?.[0]?.address?.toLowerCase() || "";
  const subject = parsed.subject || "";
  const content = decodeHtmlEntities(`${parsed.text || ""}\n${parsed.html || ""}`);
  const isOfficialSender = sender === "forwarding-noreply@google.com" || sender.endsWith("@google.com");
  const isForwardingMessage = /gmail forwarding confirmation|forwarding confirmation|confirmation code/i.test(`${subject}\n${content}`);

  if (!isOfficialSender || !isForwardingMessage) return null;

  const urls = content.match(/https:\/\/[^\s<>'"]+/gi) || [];
  let confirmationUrl = null;
  for (const candidate of urls) {
    try {
      const url = new URL(candidate.replace(/[).,;]+$/, ""));
      if (url.hostname === "mail-settings.google.com") {
        confirmationUrl = url.toString();
        break;
      }
    } catch {
      // Ignore malformed URLs in the message.
    }
  }

  const codeMatch = content.match(/(?:confirmation|verification)\s+code\s*[:\-]?\s*(\d{6,})/i);
  const confirmationCode = codeMatch?.[1] || null;
  if (!confirmationUrl && !confirmationCode) return null;

  return {
    status: "verification_received",
    provider: "gmail",
    confirmationUrl,
    confirmationCode,
    receivedAt: parsed.date?.toISOString() || null,
  };
};

const toAddress = (address) => ({
  display_name: address?.name || null,
  identifier: address?.address || null,
});

const toRawEmail = (message, parsed, mailbox) => ({
  id: `cpanel:${mailbox.email}:${message.uid}`,
  account_id: mailbox.email,
  provider_id: { message_id: parsed.messageId || null },
  date: (parsed.date || message.internalDate || new Date()).toISOString(),
  subject: parsed.subject || "",
  body: parsed.html || parsed.text || "",
  body_plain: parsed.text || "",
  from_attendee: toAddress(parsed.from?.value?.[0]),
  to_attendees: (parsed.to?.value || []).map(toAddress),
});

class ForwardingService {
  async reconcileCreatingMailbox(userId, mailbox) {
    if (!mailbox || mailbox.status !== "creating") return mailbox;

    const createdAt = Date.parse(mailbox.createdAt || "");
    const creationIsStale = !Number.isFinite(createdAt) || Date.now() - createdAt > 60_000;
    if (!creationIsStale) return mailbox;

    if (await cpanelService.mailboxExists(mailbox.email)) {
      return firebaseService.updateForwardingMailbox(userId, {
        status: "connected",
        updatedAt: new Date().toISOString(),
      });
    }

    await firebaseService.deleteForwardingMailbox(userId);
    return null;
  }

  async enable(userId) {
    cpanelService.validateConfiguration();
    const existing = await this.reconcileCreatingMailbox(
      userId,
      await firebaseService.getForwardingMailbox(userId)
    );
    if (existing?.status === "connected") {
      return { created: false, mailbox: publicMailbox(existing) };
    }
    if (existing?.status === "creating") {
      const error = new Error("Mailbox creation is already in progress. Please try again shortly.");
      error.statusCode = 409;
      throw error;
    }

    const localPart = `${env.cpanel.mailboxPrefix}-${randomBytes(10).toString("hex")}`;
    const password = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const mailbox = {
      localPart,
      email: `${localPart}@${env.cpanel.emailDomain}`,
      encryptedPassword: encryptCredential(password),
      status: "creating",
      createdAt: now,
      updatedAt: now,
    };

    const reserved = await firebaseService.reserveForwardingMailbox(userId, mailbox);
    if (!reserved.created) {
      return { created: false, mailbox: publicMailbox(reserved.mailbox) };
    }

    try {
      await cpanelService.createMailbox(localPart, password);
      const connected = await firebaseService.updateForwardingMailbox(userId, {
        status: "connected",
        updatedAt: new Date().toISOString(),
      });
      return { created: true, mailbox: publicMailbox(connected) };
    } catch (error) {
      await firebaseService.deleteForwardingMailbox(userId).catch(() => {});
      throw error;
    }
  }

  async status(userId) {
    const mailbox = await this.reconcileCreatingMailbox(
      userId,
      await firebaseService.getForwardingMailbox(userId)
    );
    return { mailbox: publicMailbox(mailbox) };
  }

  async sync(userId) {
    const mailbox = await requireConnectedMailbox(userId);
    const client = createImapClient(mailbox);
    const insights = [];
    const processedUids = [];
    let scanned = 0;

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const unseen = await client.search({ seen: false }, { uid: true });
        const selected = unseen.slice(0, env.cpanel.imap.syncLimit);

        if (selected.length > 0) {
          for await (const message of client.fetch(selected, {
            uid: true,
            source: true,
            internalDate: true,
          }, { uid: true })) {
            scanned += 1;
            const parsed = await simpleParser(message.source);

            // Leave a message unread when extraction fails so the next sync
            // retries it, instead of marking it \Seen and losing it. One bad
            // message must not stop the rest of the batch either.
            let insight;
            try {
              insight = await transformEmail(toRawEmail(message, parsed, mailbox));
            } catch (error) {
              logger.error(`Extraction failed for IMAP message ${message.uid}.`, error);
              continue;
            }

            if (insight) insights.push(insight);
            processedUids.push(message.uid);
          }
        }

        // Same collapse the Unipile sync does: a run of messages about one
        // parcel or one subscription must store as a single record.
        await firebaseService.storeInsightsAndWait(userId, dedupeInsights(insights));
        for (const uid of processedUids) {
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        }
      } finally {
        lock.release();
      }
    } finally {
      if (client.usable) await client.logout().catch(() => {});
    }

    const now = new Date().toISOString();
    await firebaseService.updateForwardingMailbox(userId, { lastSyncedAt: now, updatedAt: now });
    return {
      orders: insights.filter(({ data }) => data.type === "order").map(({ data }) => data),
      subscriptions: insights.filter(({ data }) => data.type === "subscription").map(({ data }) => data),
      scanned,
      accepted: insights.length,
    };
  }

  async getVerification(userId) {
    const mailbox = await requireConnectedMailbox(userId);
    const client = createImapClient(mailbox);
    let verification = null;

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const messageCount = client.mailbox.exists || 0;
        if (messageCount > 0) {
          const firstSequence = Math.max(1, messageCount - 49);
          const sequenceRange = `${firstSequence}:*`;
          for await (const message of client.fetch(sequenceRange, {
            uid: true,
            source: true,
          })) {
            const parsed = await simpleParser(message.source);
            verification = extractGmailVerification(parsed);
            if (verification) {
              await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
              break;
            }
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      if (client.usable) await client.logout().catch(() => {});
    }

    if (verification) {
      await firebaseService.updateForwardingMailbox(userId, {
        gmailForwardingStatus: "verification_received",
        updatedAt: new Date().toISOString(),
      });
      return verification;
    }

    return {
      status: "waiting_for_verification",
      provider: "gmail",
      confirmationUrl: null,
      confirmationCode: null,
      receivedAt: null,
    };
  }

  async completeVerification(userId) {
    const mailbox = await requireConnectedMailbox(userId);
    if (mailbox.gmailForwardingStatus !== "verification_received"
      && mailbox.gmailForwardingStatus !== "verified") {
      const error = new Error("Receive the Gmail verification email before marking verification complete.");
      error.statusCode = 409;
      throw error;
    }

    const updated = await firebaseService.updateForwardingMailbox(userId, {
      gmailForwardingStatus: "verified",
      gmailVerifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { mailbox: publicMailbox(updated) };
  }

  async disable(userId) {
    const mailbox = await firebaseService.getForwardingMailbox(userId);
    if (!mailbox) return { removed: false };

    const deletion = await cpanelService.deleteMailbox(mailbox.localPart);
    await firebaseService.deleteForwardingMailbox(userId);
    return {
      removed: true,
      mailboxAlreadyMissing: deletion.alreadyMissing,
    };
  }
}

export default new ForwardingService();
