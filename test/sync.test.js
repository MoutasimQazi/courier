/**
 * Incremental sync tests.
 *
 *   npm test
 *
 * These cover the decisions that keep a repeat sync from re-extracting mail it
 * has already read: which window a run asks for, which emails it recognises as
 * done, where the watermark lands afterwards, and whether a stored record can
 * still be matched to a freshly extracted one describing the same thing.
 *
 * All pure — no network, no Firestore.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  keyFromData,
  mergeLedger,
  nextWatermark,
  oldestFailureDate,
  resolveWindow,
} from "../src/services/syncState.js";
import { dedupeInsights, groupInsights } from "../src/services/email.service.js";

const HISTORY_START = "2026-07-18T00:00:00.000Z";

describe("recovering the key of a stored record", () => {
  // If these drift out of step with insightKey() in email.service.js, a stored
  // order and a new email about that same order stop merging, and the response
  // grows a duplicate entry for every follow-up mail.
  it("keys an order by merchant and order number", () => {
    assert.equal(
      keyFromData({ type: "order", merchant: "Shop", orderId: "ORD-1", trackingId: "BD1" }),
      "order:shop:ord-1"
    );
  });

  it("falls back to the tracking number when there is no order number", () => {
    assert.equal(
      keyFromData({ type: "order", merchant: "Shop", orderId: null, trackingId: "BD1" }),
      "order:shop:bd1"
    );
  });

  it("keys a subscription by merchant alone, so renewals collapse", () => {
    assert.equal(
      keyFromData({ type: "subscription", merchant: "Netflix" }),
      "subscription:netflix"
    );
  });

  it("normalises case and surrounding space", () => {
    assert.equal(
      keyFromData({ type: "order", merchant: "  SHOP ", orderId: " Ord-1 " }),
      "order:shop:ord-1"
    );
  });

  it("returns null when there is nothing stable to group on", () => {
    assert.equal(keyFromData({ type: "order", merchant: "Shop" }), null);
    assert.equal(keyFromData({ type: "subscription", merchant: null }), null);
    assert.equal(keyFromData(null), null);
  });
});

describe("choosing the window to query", () => {
  it("reads the whole history window when there is no watermark", () => {
    const window = resolveWindow({ lastSyncedAt: null, historyStart: HISTORY_START });
    assert.equal(window.isBackfill, true);
    assert.equal(window.after, HISTORY_START);
  });

  it("starts before the watermark so late-delivered mail is not stepped over", () => {
    const window = resolveWindow({
      lastSyncedAt: "2026-08-17T12:00:00.000Z",
      historyStart: HISTORY_START,
      overlapMinutes: 360,
    });
    assert.equal(window.isBackfill, false);
    assert.equal(window.after, "2026-08-17T06:00:00.000Z");
  });

  it("never reaches back past the history window", () => {
    const window = resolveWindow({
      lastSyncedAt: "2026-07-18T01:00:00.000Z",
      historyStart: HISTORY_START,
      overlapMinutes: 360,
    });
    assert.equal(window.after, HISTORY_START);
  });

  it("treats an unparseable watermark as no watermark", () => {
    const window = resolveWindow({ lastSyncedAt: "not a date", historyStart: HISTORY_START });
    assert.equal(window.isBackfill, true);
    assert.equal(window.after, HISTORY_START);
  });
});

describe("the processed-email ledger", () => {
  it("keeps the newest ids and drops the oldest past the limit", () => {
    assert.deepEqual(mergeLedger(["c", "b", "a"], ["e", "d"], 4), ["e", "d", "c", "b"]);
  });

  it("does not record an id twice", () => {
    assert.deepEqual(mergeLedger(["b", "a"], ["b"], 10), ["b", "a"]);
  });

  it("drops empty entries rather than storing them", () => {
    assert.deepEqual(mergeLedger([], ["a", "", null, undefined], 10), ["a"]);
  });

  it("survives an account that has never synced", () => {
    assert.deepEqual(mergeLedger(undefined, ["a"], 10), ["a"]);
  });
});

describe("where the watermark lands", () => {
  const syncStartedAt = "2026-08-17T12:00:00.000Z";

  it("moves to the start of the run when everything succeeded", () => {
    assert.equal(nextWatermark({ syncStartedAt, oldestFailedAt: null }), syncStartedAt);
  });

  // The failure has not been read yet. Moving past it would mean it is never
  // tried again, and the email would be lost silently.
  it("rolls back to just before the oldest failure", () => {
    assert.equal(
      nextWatermark({ syncStartedAt, oldestFailedAt: "2026-08-17T09:30:00.000Z" }),
      "2026-08-17T09:29:59.000Z"
    );
  });

  it("does not move forward because of a failure dated in the future", () => {
    assert.equal(
      nextWatermark({ syncStartedAt, oldestFailedAt: "2026-08-18T00:00:00.000Z" }),
      syncStartedAt
    );
  });

  it("picks the earliest of several failures", () => {
    const oldest = oldestFailureDate([
      { date: "2026-08-17T11:00:00Z" },
      { date: "2026-08-17T09:30:00Z" },
      { date: "2026-08-17T10:00:00Z" },
    ]);
    assert.equal(oldest, "2026-08-17T09:30:00.000Z");
  });

  it("ignores failures with no usable date", () => {
    assert.equal(oldestFailureDate([{ date: "nonsense" }, { date: null }, undefined]), null);
    assert.equal(oldestFailureDate([]), null);
  });
});

describe("merging stored records with a fresh sync", () => {
  const order = (receivedAt, status) => ({
    sourceId: "order:shop:ord-1",
    data: {
      type: "order", merchant: "Shop", orderId: "ORD-1", receivedAt, status,
    },
  });

  it("keeps the newer email when a stored order is updated", () => {
    const merged = dedupeInsights([
      order("2026-08-13T07:00:00Z", "Shipped"),
      order("2026-08-15T07:00:00Z", "Delivered"),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].data.status, "Delivered");
  });

  // getEmails concatenates as [...stored, ...fresh] and relies on this: a
  // re-read of the same email must replace the stored copy, not be discarded.
  it("prefers the fresh copy when the timestamps are identical", () => {
    const stored = order("2026-08-13T07:00:00Z", "Shipped");
    const fresh = order("2026-08-13T07:00:00Z", "Delivered");
    const merged = dedupeInsights([stored, fresh]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].data.status, "Delivered");
  });

  it("leaves unrelated records alone", () => {
    const merged = dedupeInsights([
      order("2026-08-13T07:00:00Z", "Shipped"),
      {
        sourceId: "subscription:netflix",
        data: { type: "subscription", merchant: "Netflix", receivedAt: "2026-08-14T07:00:00Z" },
      },
    ]);
    assert.equal(merged.length, 2);
  });
});

describe("the shape handed back to the client", () => {
  // A response mixes records read from storage with ones extracted seconds ago.
  // Only the stored ones carry sourceId in their document, so without this the
  // field would appear on some entries and not others, and a client keying off
  // it would break the first time new mail arrived.
  it("stamps sourceId on every entry, stored or fresh", () => {
    const { orders, subscriptions } = groupInsights([
      {
        sourceId: "order:shop:ord-1",
        data: { type: "order", merchant: "Shop", sourceId: "order:shop:ord-1" },
      },
      {
        sourceId: "subscription:netflix",
        data: { type: "subscription", merchant: "Netflix" },
      },
    ]);

    assert.equal(orders[0].sourceId, "order:shop:ord-1");
    assert.equal(subscriptions[0].sourceId, "subscription:netflix");
  });

  // dedupeInsights rewrites the wrapper's key when it collapses a parcel's
  // stream onto one record. The entry must report the key it is stored under,
  // not the one it was built with.
  it("reports the canonical key after a merge, not the original", () => {
    const merged = dedupeInsights([
      {
        sourceId: "order:shop:ord-1",
        data: {
          type: "order", merchant: "Shop", orderId: "ORD-1",
          trackingId: "BD1", receivedAt: "2026-08-13T07:00:00Z",
        },
      },
      {
        sourceId: "e-later-email",
        data: {
          type: "order", merchant: "Shop", orderId: null,
          trackingId: "BD1", receivedAt: "2026-08-15T07:00:00Z", status: "Delivered",
        },
      },
    ]);

    const { orders } = groupInsights(merged);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, "Delivered");
    assert.equal(orders[0].sourceId, "order:shop:ord-1");
  });
});
