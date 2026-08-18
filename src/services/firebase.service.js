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
// be merged with a freshly extracted one describing the same order.
//
// The key is *recomputed* from the contents rather than read back from the
// field, because the rules that build it get fixed — grouping a subscription by
// its brand domain instead of the model's wording of the merchant name, for
// one. Documents written under a superseded rule have to answer to the current
// key or they would sit alongside the record they belong to for ever, which is
// exactly the duplicate this is here to prevent. The stored field is the
// fallback for records with nothing stable to group on, and the id they were
// stored under is the last resort, so nothing is ever dropped.
const storedSourceId = (documentId, data) => keyFromData(data) || data?.sourceId || documentId;

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
      return Object.entries(store[userId] ?? {}).map(([documentId, data]) => ({
        sourceId: storedSourceId(documentId, data),
        // Where this record physically lives, which is not where its current
        // key says it belongs once that key has been recomputed. Carried so
        // pruneRelocatedInsights can find the copy left behind.
        documentId,
        collection: data?.type === "order" ? "orders" : "subscriptions",
        data,
      }));
    }

    const db = getFirestoreDb();
    const user = db.collection("users").doc(userId);
    const [orders, subscriptions] = await Promise.all([
      user.collection("orders").get(),
      user.collection("subscriptions").get(),
    ]);

    const entries = [
      ...orders.docs.map((document) => ({ document, collection: "orders" })),
      ...subscriptions.docs.map((document) => ({ document, collection: "subscriptions" })),
    ];

    return entries.map(({ document, collection }) => {
      const data = document.data();
      return {
        sourceId: storedSourceId(document.id, data),
        documentId: document.id,
        collection,
        data,
      };
    });
  }

  /**
   * Delete the documents that duplicates left behind.
   *
   * A document's id is a hash of the key it was written under, so a record
   * whose key has been recomputed no longer answers to the id it is stored at:
   * the merged version is written to the canonical id and the old one would
   * linger for ever, resurfacing as a duplicate for any reader that does not
   * recompute. This removes strictly those — a stored document is only deleted
   * once the record it collapsed into has been written at its canonical id, so
   * a record that simply was not re-extracted this run is left untouched.
   */
  async pruneRelocatedInsights(userId, stored = [], kept = []) {
    if (stored.length === 0 || kept.length === 0) return 0;

    const keptBySourceId = new Map(kept.map((insight) => [insight.sourceId, insight]));
    // In the file-backed store a record is filed under the key itself; in
    // Firestore under a hash of it.
    const canonicalId = isDevelopmentUser(userId)
      ? (sourceId) => sourceId
      : sanitizeDocumentId;

    const relocated = stored.filter((entry) => {
      const survivor = keptBySourceId.get(entry.sourceId);
      return survivor && canonicalId(survivor.sourceId) !== entry.documentId;
    });
    if (relocated.length === 0) return 0;

    if (isDevelopmentUser(userId)) {
      const store = await loadDevelopmentInsights();
      const owned = store[userId] ?? (store[userId] = {});
      for (const entry of relocated) {
        const survivor = keptBySourceId.get(entry.sourceId);
        owned[survivor.sourceId] = { ...survivor.data, sourceId: survivor.sourceId };
        delete owned[entry.documentId];
      }
      await saveDevelopmentInsights();
      return relocated.length;
    }

    const db = getFirestoreDb();
    // Written before deleted, in that order: an interruption in between costs a
    // stale copy that the next run prunes again, where the reverse would lose
    // the record outright.
    await this.#writeInsights(
      userId,
      relocated.map((entry) => keptBySourceId.get(entry.sourceId))
    );
    await Promise.all(relocated.map((entry) => (
      db.collection("users").doc(userId)
        .collection(entry.collection).doc(entry.documentId)
        .delete()
    )));

    logger.info(`Pruned ${relocated.length} duplicate insight document(s) for ${userId}.`);
    return relocated.length;
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

  /**
   * Every user with a connected forwarding mailbox, for the scheduled sweep.
   *
   * Queried without a `where` clause and filtered here instead: a filtered
   * collection-group query needs an index enabled for that field across the
   * group, and a missing one fails at runtime rather than at deploy. The
   * document count is one per user, so reading them all costs little.
   */
  async listForwardingUserIds() {
    const db = getFirestoreDb();
    const snapshot = await db.collectionGroup("forwarding").get();

    return snapshot.docs
      .filter((document) => document.data()?.status === "connected")
      .map((document) => document.ref.parent.parent?.id)
      .filter(Boolean);
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
