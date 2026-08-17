import { randomBytes } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import env from "../config/env.js";
import logger from "../utils/logger.js";
import { decryptCredential, encryptCredential } from "../utils/credentialCipher.js";
import cpanelService from "./cpanel.service.js";
import firebaseService from "./firebase.service.js";
import { dedupeInsights, groupInsights, transformEmails } from "./email.service.js";

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

  /**
   * Reads the unhandled mail and hands back the connection.
   *
   * Deliberately does no extraction: that is minutes of model calls for a large
   * batch, and an IMAP socket held open across it trips the server's idle
   * timeout mid-run. Everything needed is pulled out first so the connection
   * can be closed before any of that starts.
   */
  async #readUnhandled(mailbox) {
    const client = createImapClient(mailbox);
    const messages = [];
    const preservedUids = [];
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

            // The Gmail confirmation mail is neither an order nor a
            // subscription, so it would otherwise be treated as junk and
            // removed — but getVerification() has to be able to find it later,
            // and it only arrives once. Never let it into the deletion set.
            if (extractGmailVerification(parsed)) {
              preservedUids.push(message.uid);
              continue;
            }

            messages.push({ uid: message.uid, rawEmail: toRawEmail(message, parsed, mailbox) });
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      if (client.usable) await client.logout().catch(() => {});
    }

    return { messages, preservedUids, scanned };
  }

  /**
   * Reconnects to remove the messages whose contents are now stored.
   *
   * This is a real expunge — no Trash copy, no way back — so it only ever runs
   * after the insight write has been confirmed. If the server refuses, the
   * messages are marked read instead: the mailbox keeps growing, which is
   * visible and fixable, whereas re-extracting them on every later sync would
   * quietly cost a model call each time.
   *
   * UIDs stay valid across the reconnect. If the mailbox were ever recreated
   * they would not, and the delete simply matches nothing and is reported.
   */
  async #consumeMessages(mailbox, processedUids, preservedUids) {
    if (processedUids.length === 0 && preservedUids.length === 0) return 0;

    const client = createImapClient(mailbox);
    let deleted = 0;

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Marked read, never deleted: this keeps the preserved verification
        // mail out of every later `seen: false` search without destroying it.
        if (preservedUids.length > 0) {
          await client.messageFlagsAdd(preservedUids, ["\\Seen"], { uid: true });
        }

        if (processedUids.length === 0) {
          // nothing to remove
        } else if (!env.cpanel.deleteAfterSync) {
          await client.messageFlagsAdd(processedUids, ["\\Seen"], { uid: true });
        } else {
          deleted = await this.#removeMessages(client, processedUids);
        }
      } finally {
        lock.release();
      }
    } finally {
      if (client.usable) await client.logout().catch(() => {});
    }

    return deleted;
  }

  async #removeMessages(client, uids) {
    try {
      // Returns false rather than throwing when the range resolves to nothing,
      // so a falsy result is just as much a failure to delete as an exception.
      if (await client.messageDelete(uids, { uid: true })) return uids.length;
      logger.warn(`The mail server did not delete ${uids.length} processed message(s).`);
    } catch (error) {
      logger.error(`Could not delete ${uids.length} processed message(s).`, error);
    }

    await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true }).catch(() => {});
    return 0;
  }

  async sync(userId) {
    const mailbox = await requireConnectedMailbox(userId);

    // 1. Read and disconnect.
    const { messages, preservedUids, scanned } = await this.#readUnhandled(mailbox);

    // 2. Extract with bounded concurrency. One at a time turned a batch of
    //    twenty into a minute of mostly waiting, which is what made the request
    //    outlive the browser's patience.
    const errors = [];
    const extracted = await transformEmails(messages.map(({ rawEmail }) => rawEmail), { errors });

    for (const { index, error } of errors) {
      logger.error(`Extraction failed for IMAP message ${messages[index]?.uid}.`, error);
    }

    const insights = extracted.filter(Boolean);

    // 3. Same collapse the Unipile sync does: a run of messages about one
    //    parcel or one subscription must store as a single record.
    //
    //    Awaited before a single message is removed. Once deletion runs this
    //    record is the only copy that exists, so a failed write has to leave the
    //    mailbox untouched and let the next sync try again.
    await firebaseService.storeInsightsAndWait(userId, dedupeInsights(insights));

    // A message whose extraction failed was never stored, so it must survive to
    // be retried — it is left both unread and undeleted.
    const failed = new Set(errors.map(({ index }) => index));
    const processedUids = messages
      .filter((_, index) => !failed.has(index))
      .map(({ uid }) => uid);

    const deleted = await this.#consumeMessages(mailbox, processedUids, preservedUids);

    const now = new Date().toISOString();
    await firebaseService.updateForwardingMailbox(userId, { lastSyncedAt: now, updatedAt: now });

    // Handled messages are gone from the mailbox, so a second sync scans nothing
    // and would answer with an empty list — indistinguishable from a broken run.
    // Reading back what is stored (the write above included) keeps the response
    // the full picture, the same way the Unipile sync does.
    const stored = await firebaseService.getStoredInsights(userId);

    return {
      ...groupInsights(stored),
      scanned,
      accepted: insights.length,
      failed: errors.length,
      deleted,
      retained: preservedUids.length,
    };
  }

  /**
   * Sweeps every connected forwarding mailbox. This is what the scheduler calls
   * so mail is processed and cleared without anyone pressing a button.
   *
   * Users are handled one after another rather than in parallel: each one
   * already extracts at full concurrency, and overlapping them would multiply
   * that against the same rate limit.
   */
  async syncAll() {
    if (!env.cpanel.imap.host) return { users: 0, scanned: 0, accepted: 0, deleted: 0 };

    const userIds = await firebaseService.listForwardingUserIds();
    const totals = { users: 0, scanned: 0, accepted: 0, deleted: 0 };

    for (const userId of userIds) {
      try {
        const result = await this.sync(userId);
        totals.users += 1;
        totals.scanned += result.scanned;
        totals.accepted += result.accepted;
        totals.deleted += result.deleted;
      } catch (error) {
        // One unreachable mailbox must not stop the rest of the sweep.
        logger.error(`Scheduled forwarding sync failed for user ${userId}.`, error);
      }
    }

    if (totals.scanned > 0) {
      logger.info(
        `Forwarding sweep: ${totals.scanned} message(s) across ${totals.users} mailbox(es), `
        + `${totals.accepted} stored, ${totals.deleted} removed.`
      );
    }

    return totals;
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
