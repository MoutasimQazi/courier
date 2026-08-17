import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFirestoreDb } from "../config/firebase.js";
import logger from "../utils/logger.js";
import { keyFromData } from "./syncState.js";

const pendingWrites = new Set();
const tmpDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tmp"
);
const developmentStorePath = path.join(tmpDirectory, "forwarding-development.json");
// Local test identities never reach Firestore, so their extracted insights used
// to be discarded outright — which meant every local sync re-ran the model over
// mail it had already read. They get the same file-backed treatment the
// forwarding mailboxes get, so the incremental path works offline too.
const developmentInsightsPath = path.join(tmpDirectory, "insights-development.json");
let developmentMailboxes = null;
let developmentInsights = null;

const isDevelopmentUser = (userId) => /^dev-[a-f\d-]{36}$/i.test(userId || "");

const loadJsonStore = async (storePath) => {
  try {
    return JSON.parse(await readFile(storePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
};

const saveJsonStore = async (storePath, contents) => {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(contents, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
};

const loadDevelopmentMailboxes = async () => {
  if (developmentMailboxes) return developmentMailboxes;
  developmentMailboxes = await loadJsonStore(developmentStorePath);
  return developmentMailboxes;
};

const saveDevelopmentMailboxes = () => saveJsonStore(developmentStorePath, developmentMailboxes);

const loadDevelopmentInsights = async () => {
  if (developmentInsights) return developmentInsights;
  developmentInsights = await loadJsonStore(developmentInsightsPath);
  return developmentInsights;
};

const saveDevelopmentInsights = () => saveJsonStore(developmentInsightsPath, developmentInsights);

// Every stored document is written with the key it was grouped under, so it can
// be merged with a freshly extracted one describing the same order. Documents
// written before that field existed are recovered from their contents instead,
// and anything that still cannot be identified keeps the id it was stored under
// rather than being dropped.
const storedSourceId = (documentId, data) => data?.sourceId || keyFromData(data) || documentId;

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
    if (isDevelopmentUser(userId)) {
      const store = await loadDevelopmentInsights();
      const owned = store[userId] ?? (store[userId] = {});
      for (const insight of insights) {
        owned[insight.sourceId] = { ...insight.data, sourceId: insight.sourceId };
      }
      await saveDevelopmentInsights();
      return;
    }
    await this.#writeInsights(userId, insights);
  }

  /**
   * Everything already extracted for this user, keyed the same way a fresh
   * extraction would be. A sync merges these with what it newly found so the
   * response stays the full picture even when nothing new arrived.
   */
  async getStoredInsights(userId) {
    if (isDevelopmentUser(userId)) {
      const store = await loadDevelopmentInsights();
      return Object.entries(store[userId] ?? {}).map(([sourceId, data]) => ({
        sourceId: storedSourceId(sourceId, data),
        data,
      }));
    }

    const db = getFirestoreDb();
    const user = db.collection("users").doc(userId);
    const [orders, subscriptions] = await Promise.all([
      user.collection("orders").get(),
      user.collection("subscriptions").get(),
    ]);

    return [...orders.docs, ...subscriptions.docs].map((document) => {
      const data = document.data();
      return { sourceId: storedSourceId(document.id, data), data };
    });
  }

  /**
   * Kept on the connected-account document rather than in a collection of its
   * own: a sync already reads that document, so the watermark costs no extra
   * read, and every writer of it uses merge so the two cannot collide.
   */
  async getAccountSyncState(userId, accountId) {
    if (isDevelopmentUser(userId)) return { lastSyncedAt: null, recentEmailIds: [] };

    const db = getFirestoreDb();
    const snapshot = await db
      .collection("users")
      .doc(userId)
      .collection("connectedAccounts")
      .doc(sanitizeDocumentId(accountId))
      .get();

    const data = snapshot.exists ? snapshot.data() : {};
    return {
      lastSyncedAt: data.lastSyncedAt ?? null,
      recentEmailIds: Array.isArray(data.recentEmailIds) ? data.recentEmailIds : [],
    };
  }

  async updateAccountSyncState(userId, accountId, state) {
    if (isDevelopmentUser(userId)) return;

    const db = getFirestoreDb();
    await db
      .collection("users")
      .doc(userId)
      .collection("connectedAccounts")
      .doc(sanitizeDocumentId(accountId))
      .set({
        lastSyncedAt: state.lastSyncedAt ?? null,
        recentEmailIds: state.recentEmailIds ?? [],
        updatedAt: new Date().toISOString(),
      }, { merge: true });
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
      // The document id is a one-way hash of the key, so the key itself has to
      // be a field for a later sync to be able to merge onto this record.
      writes.push(reference.set({ ...insight.data, sourceId: insight.sourceId }));
    }

    await Promise.all(writes);
  }

  async flush() {
    await Promise.allSettled([...pendingWrites]);
  }
}

export default new FirebaseService();
