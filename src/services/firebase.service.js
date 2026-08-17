import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFirestoreDb } from "../config/firebase.js";
import logger from "../utils/logger.js";

const pendingWrites = new Set();
const developmentStorePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tmp",
  "forwarding-development.json"
);
let developmentMailboxes = null;

const isDevelopmentUser = (userId) => /^dev-[a-f\d-]{36}$/i.test(userId || "");

const loadDevelopmentMailboxes = async () => {
  if (developmentMailboxes) return developmentMailboxes;
  try {
    developmentMailboxes = JSON.parse(await readFile(developmentStorePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    developmentMailboxes = {};
  }
  return developmentMailboxes;
};

const saveDevelopmentMailboxes = async () => {
  await mkdir(path.dirname(developmentStorePath), { recursive: true });
  await writeFile(developmentStorePath, JSON.stringify(developmentMailboxes, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
};

const sanitizeDocumentId = (value) => {
  const source = String(value || "");
  return createHash("sha256").update(source).digest("hex");
};

class FirebaseService {
  #forwardingReference(db, userId) {
    return db.collection("users").doc(userId).collection("forwarding").doc("mailbox");
  }

  async ensureUser(user) {
    const db = getFirestoreDb();
    await db.collection("users").doc(user.uid).set({
      email: user.email ?? null,
      name: user.name ?? null,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  }

  async storeConnectedAccount(userId, account) {
    const db = getFirestoreDb();
    const documentId = sanitizeDocumentId(account.accountId);
    const reference = db
      .collection("users")
      .doc(userId)
      .collection("connectedAccounts")
      .doc(documentId);

    await reference.set({
      accountId: account.accountId,
      provider: account.provider ?? null,
      status: account.status ?? "connected",
      connectedAt: account.connectedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  }

  async deleteConnectedAccount(userId, accountId) {
    const db = getFirestoreDb();
    const documentId = sanitizeDocumentId(accountId);
    await db
      .collection("users")
      .doc(userId)
      .collection("connectedAccounts")
      .doc(documentId)
      .delete();
  }

  async getConnectedAccounts(userId) {
    const db = getFirestoreDb();
    const snapshot = await db
      .collection("users")
      .doc(userId)
      .collection("connectedAccounts")
      .get();

    return snapshot.docs.map((document) => document.data());
  }

  async userOwnsAccount(userId, accountId) {
    const accounts = await this.getConnectedAccounts(userId);
    return accounts.some((account) => account.accountId === accountId);
  }

  async findUserIdByAccountId(accountId) {
    const db = getFirestoreDb();
    const snapshot = await db
      .collectionGroup("connectedAccounts")
      .where("accountId", "==", accountId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].ref.parent.parent?.id ?? null;
  }

  async updateConnectedAccountStatus(userId, accountId, status) {
    const db = getFirestoreDb();
    const documentId = sanitizeDocumentId(accountId);
    await db
      .collection("users")
      .doc(userId)
      .collection("connectedAccounts")
      .doc(documentId)
      .set({
        status,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
  }

  storeInsights(userId, insights) {
    if (insights.length === 0) return Promise.resolve();

    const operation = this.#writeInsights(userId, insights)
      .catch((error) => {
        logger.error("Failed to persist email intelligence to Firestore.", error);
      })
      .finally(() => pendingWrites.delete(operation));

    pendingWrites.add(operation);
    return operation;
  }

  async storeInsightsAndWait(userId, insights) {
    if (insights.length === 0) return;
    if (isDevelopmentUser(userId)) return;
    await this.#writeInsights(userId, insights);
  }

  async getForwardingMailbox(userId) {
    if (isDevelopmentUser(userId)) {
      return (await loadDevelopmentMailboxes())[userId] ?? null;
    }
    const db = getFirestoreDb();
    const snapshot = await this.#forwardingReference(db, userId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async reserveForwardingMailbox(userId, mailbox) {
    if (isDevelopmentUser(userId)) {
      const mailboxes = await loadDevelopmentMailboxes();
      if (mailboxes[userId]) return { created: false, mailbox: mailboxes[userId] };
      mailboxes[userId] = mailbox;
      await saveDevelopmentMailboxes();
      return { created: true, mailbox };
    }
    const db = getFirestoreDb();
    const reference = this.#forwardingReference(db, userId);

    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        return { created: false, mailbox: snapshot.data() };
      }
      transaction.create(reference, mailbox);
      return { created: true, mailbox };
    });
  }

  async updateForwardingMailbox(userId, changes) {
    if (isDevelopmentUser(userId)) {
      const mailboxes = await loadDevelopmentMailboxes();
      mailboxes[userId] = { ...(mailboxes[userId] || {}), ...changes };
      await saveDevelopmentMailboxes();
      return mailboxes[userId];
    }
    const db = getFirestoreDb();
    const reference = this.#forwardingReference(db, userId);
    await reference.set(changes, { merge: true });
    const snapshot = await reference.get();
    return snapshot.data();
  }

  async deleteForwardingMailbox(userId) {
    if (isDevelopmentUser(userId)) {
      const mailboxes = await loadDevelopmentMailboxes();
      delete mailboxes[userId];
      await saveDevelopmentMailboxes();
      return;
    }
    const db = getFirestoreDb();
    await this.#forwardingReference(db, userId).delete();
  }

  async #writeInsights(userId, insights) {
    const db = getFirestoreDb();
    const writes = [];

    for (const insight of insights) {
      const documentId = sanitizeDocumentId(insight.sourceId);
      const collection = insight.data.type === "order" ? "orders" : "subscriptions";
      const reference = db.collection("users").doc(userId).collection(collection).doc(documentId);
      writes.push(reference.set(insight.data));
    }

    await Promise.all(writes);
  }

  async flush() {
    await Promise.allSettled([...pendingWrites]);
  }
}

export default new FirebaseService();
