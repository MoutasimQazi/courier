import { createHash } from "node:crypto";

import firebaseService from "./firebase.service.js";
import parserService from "./parser.service.js";
import unipileService from "./unipile.service.js";
import {
  merchantIdentity,
  mergeLedger,
  nextWatermark,
  oldestFailureDate,
  resolveWindow,
} from "./syncState.js";
import env from "../config/env.js";
import logger from "../utils/logger.js";

const MAX_PAGE_SIZE = 250;
// Belt and braces against a cursor that never advances.
const MAX_PAGES = 20;

const getHistoryStart = () => new Date(
  Date.now() - env.sync.historyDays * 24 * 60 * 60 * 1000
).toISOString();

const titleCase = (value) => {
  if (!value) return null;
  return String(value)
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const getValidationText = (parsed) => {
  const noise = /unsubscribe|email preferences|notification settings|manage (?:your )?(?:email|subscription)|privacy policy|view in browser/i;

  return `${parsed.subject ?? ""}\n${parsed.bodyText ?? ""}`
    .split("\n")
    .filter((line) => !noise.test(line))
    .join("\n");
};

// The model owns the classification: it reads the whole mail, and the prompt
// spells out the traps this used to guess at with keywords — a "subscription"
// in a footer or an unsubscribe link, a "monthly newsletter" that is a cadence
// and not a billing cycle, a promo that says "free delivery". Re-deciding that
// here with English regexes both duplicated the judgement and silently threw
// away correct calls on any mail that phrased things differently or wasn't in
// English. So these checks no longer look at wording at all — they only
// confirm the model came back with at least one concrete fact behind the
// category, which is what separates a real notice from a confident guess.
const hasOrderEvidence = (parsed) => Boolean(
  parsed.shipping?.trackingNumber
  || parsed.order?.orderNumber
  || parsed.shipping?.estimatedDelivery
  || (parsed.order?.amount != null && parsed.order?.currency)
);

// An emailed card ships nothing, so the parcel half of hasOrderEvidence can
// never fire for one. Its value, or the order it came from, is what makes it
// real rather than an advertisement for gift cards.
const hasGiftCardEvidence = (parsed) => Boolean(
  parsed.order?.orderNumber
  || parsed.shipping?.trackingNumber
  || (parsed.order?.amount != null && parsed.order?.currency)
);

const hasSubscriptionEvidence = (parsed) => Boolean(
  parsed.subscription?.renewalDate
  || parsed.subscription?.trialEndsAt
  || parsed.subscription?.billingCycle
  || (parsed.subscription?.amount != null && parsed.subscription?.currency)
  // A cancellation confirmation, and a "your free trial has started" notice,
  // usually state no amount, date or cycle — the status is the concrete fact in
  // those cases, so accept it on its own.
  || parsed.filter?.subscriptionStatus === "cancelled"
  || parsed.filter?.subscriptionStatus === "trial"
);

// Prefer the plan name the model read off the mail; fall back to the keyword
// scan only when it didn't find one.
const extractPlan = (parsed) => {
  if (parsed.subscription?.plan) return parsed.subscription.plan;

  const text = getValidationText(parsed);
  const match = text.match(/\b(basic|standard|premium|plus|pro|business|enterprise|family|individual|student)\s+(?:plan|subscription|membership)\b/i);
  return match ? titleCase(match[0]) : null;
};

const stableSourceId = (rawEmail) => {
  if (rawEmail.id) return String(rawEmail.id);

  return createHash("sha256")
    .update(JSON.stringify({
      accountId: rawEmail.account_id ?? null,
      providerId: rawEmail.provider_id ?? null,
      date: rawEmail.date ?? null,
      subject: rawEmail.subject ?? null,
    }))
    .digest("hex");
};

/**
 * Identity of the *thing* an email is about, not of the email.
 *
 * A parcel generates a stream of mail — shipped, in transit, out for delivery,
 * delivered — and a subscription generates one every billing period. Keying
 * documents by email id turned each of those into its own record, which is
 * where the repeated entries come from. Keying by the order or the service
 * instead collapses the stream onto one record that updates in place.
 *
 * Falls back to the email id when there is nothing stable to group on, so an
 * unidentifiable mail still gets stored rather than colliding with others.
 */
const insightKey = (parsed, rawEmail) => {
  // Identity comes from the brand domain where there is one, because the
  // model's merchant *name* varies between runs over the very same mail
  // ("Anthropic" / "Anthropic, PBC") and every variant would open its own
  // record. See merchantIdentity().
  const merchant = merchantIdentity(parsed);

  if (parsed.category === "subscription") {
    // One subscription per service. Renewals month after month are the same
    // subscription, so they must land on the same document.
    if (merchant) return `subscription:${merchant}`;
  } else {
    // The order number is the real identity; tracking number is the runner-up
    // because one order can ship as several parcels. A gift card is bought the
    // same way, so it keys the same way — under its own prefix, so a card and
    // an order that happen to share a reference stay separate records.
    const reference = parsed.order?.orderNumber ?? parsed.shipping?.trackingNumber;
    if (merchant && reference) {
      const kind = parsed.category === "gift_card" ? "gift_card" : "order";
      return `${kind}:${merchant}:${String(reference).trim().toLowerCase()}`;
    }
  }

  return stableSourceId(rawEmail);
};

/**
 * Collapse insights that describe the same order or subscription, keeping the
 * most recent email for each. Firestore writes with set(), so without this the
 * winner within a single sync would be whichever request happened to finish
 * last rather than whichever email is newest.
 */
// Scoped by type as well as merchant: an order and a gift card from the same
// shop could otherwise share an alias and collapse into each other.
const trackingAlias = (data) => `${data.type}:${merchantIdentity(data) ?? ""}`
  + `:${String(data.trackingId ?? "").trim().toLowerCase()}`;

// Both are a purchase that can arrive as a parcel, so both key on an order or
// tracking reference and both need the stream collapse below.
const isPurchase = (data) => data.type === "order" || data.type === "gift_card";

export const dedupeInsights = (insights) => {
  // Later updates about a parcel ("out for delivery", "delivered") often carry
  // only the tracking number, while the first mail carried the order number —
  // which would key them apart. Map each tracking number to the order key that
  // named it, so the whole stream lands on one record.
  const orderKeyByTracking = new Map();
  for (const { sourceId, data } of insights) {
    if (isPurchase(data) && data.orderId && data.trackingId) {
      orderKeyByTracking.set(trackingAlias(data), sourceId);
    }
  }

  const canonicalKey = ({ sourceId, data }) => (
    isPurchase(data) && !data.orderId && data.trackingId
      ? orderKeyByTracking.get(trackingAlias(data)) ?? sourceId
      : sourceId
  );

  const latest = new Map();
  for (const insight of insights) {
    const key = canonicalKey(insight);
    const current = latest.get(key);
    const isNewer = !current
      || String(insight.data.receivedAt ?? "") >= String(current.data.receivedAt ?? "");
    if (isNewer) latest.set(key, { ...insight, sourceId: key });
  }

  return [...latest.values()];
};

/**
 * The date by which the item has to go back.
 *
 * An email usually states one half of this: either a deadline ("returns until
 * 27 August") or a duration ("7 day returns"). The deadline is what a person
 * actually needs, so when only the duration is given it is counted forward from
 * the delivery date — the point a return window starts from.
 *
 * That derivation is flagged, because until the parcel is actually delivered
 * the delivery date is itself an estimate, and so is any deadline built on it.
 */
const returnDeadline = (parsed) => {
  const stated = parsed.returns?.returnBy ?? null;
  if (stated) return { returnBy: stated, estimated: false };

  const windowDays = parsed.returns?.windowDays ?? null;
  const delivery = parsed.shipping?.estimatedDelivery ?? null;
  if (!windowDays || !delivery) return { returnBy: null, estimated: false };

  // Parsed as UTC so adding days cannot shift the date across a timezone the
  // way a local-midnight parse would.
  const deadline = new Date(`${delivery}T00:00:00Z`);
  if (isNaN(deadline.getTime())) return { returnBy: null, estimated: false };

  deadline.setUTCDate(deadline.getUTCDate() + windowDays);
  return { returnBy: deadline.toISOString().slice(0, 10), estimated: true };
};

const toOrder = (parsed) => {
  const returns = returnDeadline(parsed);

  return {
    type: "order",
    merchant: parsed.merchant ?? null,
    merchantDomain: parsed.merchantDomain ?? null,
    // productUrl is where the item lives; imageUrl is its picture. serviceUrl and
    // logoUrl identify the company behind it. manageUrl is the order's own page
    // — where it is viewed, amended, or cancelled — which is a different
    // destination from the product and worth keeping apart from it.
    productUrl: parsed.productUrl ?? null,
    manageUrl: parsed.order?.manageUrl ?? null,
    serviceUrl: parsed.serviceUrl ?? null,
    logoUrl: parsed.logoUrl ?? null,
    // Drives the newest-wins collapse when several emails describe one order.
    receivedAt: parsed.receivedAt ?? null,
    emailId: parsed.emailId ?? null,
    // orderId is the reference the merchant assigned; orderName is what a person
    // would call the purchase. Keep them apart — one is for lookup, one is for
    // display, and they are never interchangeable.
    orderId: parsed.order?.orderNumber ?? null,
    orderName: parsed.order?.orderName ?? null,
    orderDate: parsed.order?.orderDate ?? null,
    trackingId: parsed.shipping?.trackingNumber ?? null,
    trackingUrl: parsed.shipping?.trackingUrl ?? null,
    carrier: parsed.shipping?.carrier ?? null,
    amount: parsed.order?.amount ?? null,
    currency: parsed.order?.currency ?? null,
    status: titleCase(parsed.shipping?.status),
    deliveryDate: parsed.shipping?.estimatedDelivery ?? null,
    // returnBy is the deadline itself; returnWindowDays is the period as the
    // mail worded it ("7 day returns"), kept so the window can still be shown
    // when there is no delivery date to count it from. Zero rather than null
    // when no period applies, so a client can show "0 days" without having to
    // decide what a missing number means.
    returnBy: returns.returnBy,
    returnWindowDays: parsed.returns?.windowDays ?? 0,
    returnByIsEstimated: returns.estimated,
    // What may be done with the item at all: sent back for a refund, exchanged
    // only, or neither. Null when the email never said.
    returnType: parsed.returns?.type ?? null,
    imageUrl: parsed.imageUrl ?? null,
    // Filter facet, stored raw (not title-cased) so the client can match on it.
    category: parsed.filter?.orderCategory ?? null,
    items: parsed.order?.items ?? [],
  };
};

/**
 * A gift card is a purchase, so it borrows the order fields that apply — who
 * it is from, what it cost, and the parcel fields a posted card still needs.
 *
 * What it deliberately does not carry: the return fields, because a card is not
 * sent back, and `category`, because gift cards are now a kind of their own
 * rather than one bucket inside orders. The redemption code is never stored —
 * the prompt refuses to return it, and nothing here would keep it if it did.
 */
// Whole months per cycle. Weekly is days, so it is handled separately.
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
// A weekly plan billed for two years is ~104 steps; the bound only exists so a
// bad date can never spin here.
const MAX_CYCLE_STEPS = 400;

const isoDay = (date) => date.toISOString().slice(0, 10);

/**
 * One billing cycle forward from a YYYY-MM-DD date.
 *
 * Month arithmetic is done on day 1 and then clamped, because setUTCMonth on a
 * 31st overflows: 31 January plus one month is 3 March in JavaScript, and the
 * charge would land in the wrong month every time.
 */
const advanceCycle = (day, cycle) => {
  const date = new Date(`${day}T00:00:00Z`);
  if (isNaN(date.getTime())) return null;

  if (cycle === "weekly") {
    date.setUTCDate(date.getUTCDate() + 7);
    return isoDay(date);
  }

  const months = CYCLE_MONTHS[cycle];
  if (!months) return null;

  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, lastOfMonth));
  return isoDay(date);
};

// Step forward until the date is past `after`, so a charge date becomes the
// *next* one rather than one that has already happened.
const advancePast = (day, cycle, after) => {
  let next = day;
  for (let i = 0; next && next <= after && i < MAX_CYCLE_STEPS; i += 1) {
    next = advanceCycle(next, cycle);
  }
  return next && next > after ? next : null;
};

/**
 * The date of the next charge.
 *
 * Most billing mail never prints one. A receipt says what was just taken and
 * how often it recurs, and a renewal notice often names the date the plan
 * *last* renewed — which is why every subscription came back with either a null
 * renewalDate or one already in the past, neither of which a person can act on.
 *
 * So the next charge is worked out from the last one plus the billing cycle,
 * anchored on whichever of these the email gave: the date it stated, the date
 * the payment was taken, or failing both, the day the mail arrived — a receipt
 * arrives when the charge is made, so that is a fair stand-in.
 *
 * Everything derived is flagged, and two cases are deliberately left alone: a
 * cancelled plan has no next charge, and a plan with no stated cycle cannot be
 * projected at all — a guessed date in the past is worse than an empty field.
 *
 * Rolling stops relative to the email's own date, not today's, so a record is
 * the same every time it is read rather than drifting under the client.
 */
const nextRenewal = (parsed) => {
  const stated = parsed.subscription?.renewalDate ?? null;
  const cycle = parsed.subscription?.billingCycle ?? null;
  const received = (parsed.receivedAt ?? "").slice(0, 10) || null;

  // Nothing recurs after a cancellation. Whatever date the mail gave is the
  // last one, and it is reported exactly as stated.
  if (parsed.filter?.subscriptionStatus === "cancelled") {
    return { renewalDate: stated, estimated: false };
  }

  if (stated) {
    if (!cycle || !received || stated > received) {
      return { renewalDate: stated, estimated: false };
    }
    // A stated date that has already passed is the previous renewal; the next
    // one is a whole number of cycles after it.
    const rolled = advancePast(stated, cycle, received);
    return rolled ? { renewalDate: rolled, estimated: true } : { renewalDate: stated, estimated: false };
  }

  // During a trial the next charge is the day the trial converts, which the
  // mail states far more often than it states a renewal date.
  const trialEndsAt = parsed.subscription?.trialEndsAt ?? null;
  if (trialEndsAt) return { renewalDate: trialEndsAt, estimated: true };

  const anchor = parsed.order?.orderDate ?? received;
  if (!anchor || !cycle) return { renewalDate: null, estimated: false };

  const projected = advancePast(anchor, cycle, received ?? anchor);
  return projected ? { renewalDate: projected, estimated: true } : { renewalDate: null, estimated: false };
};

const toGiftCard = (parsed) => ({
  type: "gift_card",
  merchant: parsed.merchant ?? null,
  merchantDomain: parsed.merchantDomain ?? null,
  productUrl: parsed.productUrl ?? null,
  manageUrl: parsed.order?.manageUrl ?? null,
  serviceUrl: parsed.serviceUrl ?? null,
  logoUrl: parsed.logoUrl ?? null,
  receivedAt: parsed.receivedAt ?? null,
  emailId: parsed.emailId ?? null,
  orderId: parsed.order?.orderNumber ?? null,
  orderName: parsed.order?.orderName ?? null,
  orderDate: parsed.order?.orderDate ?? null,
  // The card's face value, not the price paid for it.
  amount: parsed.order?.amount ?? null,
  currency: parsed.order?.currency ?? null,
  // Null throughout for an emailed card, which is the common case.
  trackingId: parsed.shipping?.trackingNumber ?? null,
  trackingUrl: parsed.shipping?.trackingUrl ?? null,
  carrier: parsed.shipping?.carrier ?? null,
  status: titleCase(parsed.shipping?.status),
  deliveryDate: parsed.shipping?.estimatedDelivery ?? null,
  imageUrl: parsed.imageUrl ?? null,
});

const toSubscription = (parsed) => {
  const renewal = nextRenewal(parsed);

  return {
    type: "subscription",
    merchant: parsed.merchant ?? null,
    merchantDomain: parsed.merchantDomain ?? null,
    orderName: parsed.order?.orderName ?? null,
    imageUrl: parsed.imageUrl ?? null,
    // The service's own page, and a logo derived from its domain. manageUrl is
    // the billing page behind it — where the plan is changed or cancelled, which
    // is the one link a person actually needs from a renewal notice.
    serviceUrl: parsed.serviceUrl ?? null,
    manageUrl: parsed.subscription?.manageUrl ?? null,
    logoUrl: parsed.logoUrl ?? null,
    receivedAt: parsed.receivedAt ?? null,
    emailId: parsed.emailId ?? null,
    plan: extractPlan(parsed),
    amount: parsed.subscription?.amount ?? null,
    currency: parsed.subscription?.currency ?? null,
    billingCycle: parsed.subscription?.billingCycle ?? null,
    // The next charge, not the last one — worked out from the billing cycle when
    // the mail did not print a future date, and flagged when it was.
    renewalDate: renewal.renewalDate,
    renewalDateIsEstimated: renewal.estimated,
    trialEndsAt: parsed.subscription?.trialEndsAt ?? null,
    // How the charge is paid, and the only part of the card that is ever kept —
    // the last four digits, which is what a person recognises the card by.
    paymentType: parsed.subscription?.paymentType ?? null,
    cardLast4: parsed.subscription?.cardLast4 ?? null,
    // Filter facets, stored raw so the client can match on them.
    category: parsed.filter?.subscriptionCategory ?? null,
    subscriptionStatus: parsed.filter?.subscriptionStatus ?? null,
  };
};

// Pure mapping step, kept separate from the model call so the batch path can
// parse with bounded concurrency and then shape the results synchronously.
const buildInsight = (rawEmail, parsed) => {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const sourceId = insightKey(parsed, rawEmail);

  if (parsed.category === "subscription" && hasSubscriptionEvidence(parsed)) {
    return { sourceId, data: toSubscription(parsed) };
  }

  if (parsed.category === "courier" && hasOrderEvidence(parsed)) {
    return { sourceId, data: toOrder(parsed) };
  }

  if (parsed.category === "gift_card" && hasGiftCardEvidence(parsed)) {
    return { sourceId, data: toGiftCard(parsed) };
  }

  return null;
};

/**
 * Async: the parser calls out to the extraction model, so every caller must
 * await this. Resolves to null when the mail is neither an order nor a
 * subscription, and rejects when extraction itself failed — callers decide
 * whether that means "skip and retry later" or "fail the request".
 */
export const transformEmail = async (rawEmail, options = {}) => {
  const parsed = await parserService.parse(rawEmail, options);
  return buildInsight(rawEmail, parsed);
};

/**
 * Batch counterpart to transformEmail.
 *
 * Extraction is one model call per email, so a caller with a hundred messages
 * must not await them one at a time — that is minutes of wall clock for work
 * that is almost entirely waiting. Returns an array aligned with the input, so
 * the caller can still tell which of its own messages each result belongs to,
 * with null for mail that is neither an order nor a subscription *and* for mail
 * that failed. Failures are pushed to `errors` with their index rather than
 * rejecting, so one unreachable API call cannot lose the whole batch.
 */
export const transformEmails = async (rawEmails, { concurrency, errors = [], ...options } = {}) => {
  // Everything else — signal, model, fetchImpl — belongs to the extractor and
  // has to reach it. Destructuring only the two fields this function uses would
  // silently drop the caller's cancellation signal.
  const parsed = await parserService.parseMany(rawEmails, {
    ...options,
    concurrency: concurrency ?? env.sync.concurrency,
    errors,
  });

  const failed = new Set(errors.map(({ index }) => index));
  return rawEmails.map((rawEmail, index) => (
    failed.has(index) ? null : buildInsight(rawEmail, parsed[index])
  ));
};

// The key travels on the wrapper, not inside `data`, and dedupeInsights can
// reassign it when it collapses a parcel's stream onto one record. Stamping it
// on here — rather than at build time — is what keeps every entry's sourceId
// identical to the one it is stored under, whether it came from the cache or
// from an extraction moments ago.
export const groupInsights = (insights) => {
  const withKey = ({ sourceId, data }) => ({ ...data, sourceId });

  return {
    orders: insights.filter(({ data }) => data.type === "order").map(withKey),
    subscriptions: insights.filter(({ data }) => data.type === "subscription").map(withKey),
    giftCards: insights.filter(({ data }) => data.type === "gift_card").map(withKey),
  };
};

class EmailService {
  async #getAccountInsights({ userId, accountId, limit, refresh } = {}) {
    const startedAt = Date.now();
    const syncStartedAt = new Date().toISOString();

    // A full refresh deliberately forgets both the watermark and the ledger, so
    // the whole window is read again — needed after a prompt or schema change,
    // when previously stored extractions are no longer what the code produces.
    const state = refresh === "full"
      ? { lastSyncedAt: null, recentEmailIds: [] }
      : await firebaseService.getAccountSyncState(userId, accountId);

    const { after, isBackfill } = resolveWindow({
      lastSyncedAt: state.lastSyncedAt,
      historyStart: getHistoryStart(),
      overlapMinutes: env.sync.overlapMinutes,
    });

    // A first run has to read the history window cold, so it is capped to keep
    // that one request affordable. Later runs are bounded by how much new mail
    // actually arrived, and the ceiling is only there to contain a corrupted
    // watermark.
    const ceiling = isBackfill ? env.sync.backfillLimit : env.sync.maxEmails;

    const alreadyProcessed = new Set(state.recentEmailIds);
    const items = [];
    const seenEmailIds = new Set();
    const pageSize = limit ?? MAX_PAGE_SIZE;
    let nextCursor;
    let pages = 0;
    let skipped = 0;

    do {
      const result = await unipileService.getEmails({
        accountId,
        cursor: nextCursor,
        limit: pageSize,
        after,
      });

      pages += 1;

      for (const item of result.items) {
        if (items.length >= ceiling) break;

        const id = stableSourceId(item);
        if (seenEmailIds.has(id)) continue;
        seenEmailIds.add(id);

        // The overlap window deliberately re-offers mail a previous run already
        // read. Recognising it here is the whole point of the ledger: it costs
        // a set lookup instead of a model call.
        if (alreadyProcessed.has(id)) {
          skipped += 1;
          continue;
        }

        items.push(item);
      }

      nextCursor = result.cursor;
      // A cursor that never advances, or pages of nothing but already-seen
      // mail, would spin here forever without a page ceiling.
    } while (nextCursor && items.length < ceiling && pages < MAX_PAGES);

    if (pages >= MAX_PAGES) {
      logger.warn(`Sync for account ${accountId} stopped at the ${MAX_PAGES}-page ceiling.`);
    }

    // One model call per email, so cap the fan-out rather than mapping over the
    // whole page at once. Failures are collected instead of thrown: a single
    // unreachable API call should not lose an entire account's sync.
    const errors = [];
    const parsed = await parserService.parseMany(items, {
      concurrency: env.sync.concurrency,
      errors,
    });

    for (const { emailId, error } of errors) {
      logger.error(`Extraction failed for email ${emailId ?? "(unknown)"}.`, error);
    }

    const failedIndexes = new Set(errors.map(({ index }) => index));
    const extracted = items
      .map((item, index) => (failedIndexes.has(index) ? null : buildInsight(item, parsed[index])))
      .filter(Boolean);

    // Only emails that were actually dealt with may enter the ledger. An email
    // whose extraction failed has not been read yet, so remembering it would
    // mean never trying it again — the ledger records "done", not "seen".
    const processedIds = items
      .filter((_, index) => !failedIndexes.has(index))
      .map((item) => stableSourceId(item));

    // Several emails routinely describe one order or one subscription; keep the
    // newest of each so the caller sees one entry per thing, not per email.
    const insights = dedupeInsights(extracted);

    logger.info(
      `Sync for account ${accountId}: ${items.length} new email(s) scanned `
      + `(${skipped} already processed, ${isBackfill ? "backfill" : "incremental"} from ${after}), `
      + `${extracted.length} insight(s) -> ${insights.length} after merging duplicates, `
      + `${errors.length} failure(s), ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );

    return {
      accountId,
      insights,
      state: {
        lastSyncedAt: nextWatermark({
          syncStartedAt,
          oldestFailedAt: oldestFailureDate(errors.map(({ index }) => items[index])),
        }),
        recentEmailIds: mergeLedger(state.recentEmailIds, processedIds, env.sync.ledgerSize),
      },
      // Extraction failures are non-fatal by design, which means a totally
      // broken model call looks identical to "no relevant mail" — both return
      // an empty list. Report the counts so the two can be told apart.
      stats: {
        scanned: items.length,
        skipped,
        backfill: isBackfill,
        // The watermark only describes mail newer than this run. A first run
        // that filled its cap leaves older mail in the window unread, and no
        // later sync will reach back for it — raise SYNC_BACKFILL_LIMIT and
        // re-run with ?refresh=full to pick it up.
        backfillTruncated: isBackfill && items.length >= ceiling,
        // Pre-merge count answers "did extraction work"; merged answers "how
        // many things did the user actually get". Both matter when diagnosing.
        extracted: extracted.length,
        merged: insights.length,
        failed: errors.length,
        firstError: errors.length ? String(errors[0].error?.message ?? errors[0].error) : null,
      },
    };
  }

  async getEmails({ userId, limit, refresh } = {}) {
    const accounts = await firebaseService.getConnectedAccounts(userId);

    // What previous syncs already extracted. Without this a run that finds no
    // new mail would answer with an empty list, which reads as a broken sync
    // rather than as "nothing has changed".
    const stored = await firebaseService.getStoredInsights(userId);

    if (accounts.length === 0) {
      // Insights also arrive through the forwarding mailbox, which has no
      // connected account behind it — and that mail is deleted once extracted,
      // so this store is the only copy. Refusing to serve it because no Unipile
      // account is linked would make it unreachable.
      if (stored.length === 0) {
        const error = new Error("Connect a mailbox before fetching email intelligence.");
        error.statusCode = 409;
        error.errors = { field: "connectedAccount" };
        throw error;
      }

      const insights = dedupeInsights(stored);
      // Collapsed here means collapsed in storage too, otherwise every read
      // would have to keep re-merging the same leftovers.
      await firebaseService.pruneRelocatedInsights(userId, stored, insights);

      return {
        ...groupInsights(insights),
        cursor: null,
        diagnostics: {
          accounts: 0,
          scanned: 0,
          skipped: 0,
          extracted: 0,
          failed: 0,
          backfill: false,
          backfillTruncated: false,
          firstError: null,
          merged: insights.length,
          cached: stored.length,
          written: 0,
        },
      };
    }

    // A full refresh rebuilds every record from the mail itself, so it starts
    // from nothing rather than merging onto what is already there.
    const baseline = refresh === "full" ? [] : stored;

    const results = await Promise.all(accounts.map((account) => {
      return this.#getAccountInsights({
        userId,
        accountId: account.accountId,
        limit,
        refresh,
      });
    }));
    // Merge again across accounts: the same order can arrive in two mailboxes.
    const fresh = dedupeInsights(results.flatMap((result) => result.insights));

    // Stored first: dedupeInsights breaks ties in favour of whatever it sees
    // last, so a re-read of the same email replaces the stored copy rather than
    // being discarded by it.
    const insights = dedupeInsights([...baseline, ...fresh]);

    // Rewriting every record on every sync would make a no-op click cost a full
    // collection write, so only the records this run actually changed are sent.
    const storedByKey = new Map(baseline.map((insight) => [insight.sourceId, insight]));
    const changed = insights.filter((insight) => {
      const previous = storedByKey.get(insight.sourceId);
      return !previous
        || String(insight.data.receivedAt ?? "") !== String(previous.data.receivedAt ?? "");
    });

    // Awaited, and before the watermarks move. If this throws, the watermarks
    // stay where they are and the next sync reads the same mail again — the
    // alternative is advancing past emails whose insights were never stored.
    await firebaseService.storeInsightsAndWait(userId, changed);

    // Records whose key was recomputed on read have just been written at their
    // canonical id; the documents they used to live at are now leftovers, and
    // stay a duplicate in storage until they are removed.
    await firebaseService.pruneRelocatedInsights(userId, stored, insights);

    await Promise.all(results.map((result) => {
      return firebaseService.updateAccountSyncState(userId, result.accountId, result.state);
    }));

    const diagnostics = results.reduce((total, { stats }) => ({
      accounts: total.accounts + 1,
      scanned: total.scanned + stats.scanned,
      skipped: total.skipped + stats.skipped,
      extracted: total.extracted + stats.extracted,
      failed: total.failed + stats.failed,
      backfill: total.backfill || stats.backfill,
      backfillTruncated: total.backfillTruncated || stats.backfillTruncated,
      firstError: total.firstError ?? stats.firstError,
    }), {
      accounts: 0,
      scanned: 0,
      skipped: 0,
      extracted: 0,
      failed: 0,
      backfill: false,
      backfillTruncated: false,
      firstError: null,
    });

    // Counted after the cross-account merge, so it matches what is returned.
    diagnostics.merged = insights.length;
    diagnostics.cached = baseline.length;
    diagnostics.written = changed.length;

    if (diagnostics.backfillTruncated) {
      logger.warn(
        `Backfill filled its ${env.sync.backfillLimit}-email cap, so older mail in the `
        + `${env.sync.historyDays}-day window was not read. Raise SYNC_BACKFILL_LIMIT and `
        + `re-run with ?refresh=full to reach it.`
      );
    }

    if (diagnostics.failed > 0) {
      logger.warn(
        `Sync finished with ${diagnostics.failed}/${diagnostics.scanned} extraction failure(s). `
        + `First error: ${diagnostics.firstError}`
      );
    } else if (diagnostics.scanned === 0 && diagnostics.skipped === 0 && stored.length === 0) {
      logger.warn(
        `Sync found no emails at all — check the account connection and the `
        + `${env.sync.historyDays}-day window.`
      );
    }

    return {
      ...groupInsights(insights),
      cursor: null,
      diagnostics,
    };
  }

  async getEmailById({ id, userId }) {
    const accounts = await firebaseService.getConnectedAccounts(userId);
    if (accounts.length === 0) {
      const error = new Error("Connect a mailbox before requesting email intelligence.");
      error.statusCode = 409;
      error.errors = { field: "connectedAccount" };
      throw error;
    }

    let rawEmail = null;
    for (const account of accounts) {
      try {
        rawEmail = await unipileService.getEmailById(id, account.accountId);
        break;
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }

    if (!rawEmail) {
      const error = new Error("Email not found in the authenticated user's mailboxes.");
      error.statusCode = 404;
      throw error;
    }

    const insight = await transformEmail(rawEmail);
    const insights = insight ? [insight] : [];

    firebaseService.storeInsights(userId, insights);

    return groupInsights(insights);
  }

  async syncEmails(options = {}) {
    return this.getEmails(options);
  }

  async processWebhookEmail(payload) {
    if (payload?.event !== "mail_received") {
      return { processed: false, reason: "event_ignored" };
    }

    const accountId = typeof payload.account_id === "string"
      ? payload.account_id.trim()
      : "";
    const emailId = typeof payload.email_id === "string"
      ? payload.email_id.trim()
      : "";

    if (!accountId || !emailId) {
      const error = new Error("The Unipile email webhook is missing account_id or email_id.");
      error.statusCode = 400;
      error.errors = { fields: ["account_id", "email_id"] };
      throw error;
    }

    const userId = await firebaseService.findUserIdByAccountId(accountId);
    if (!userId) {
      return { processed: false, reason: "account_not_mapped" };
    }

    const rawEmail = await unipileService.getEmailById(emailId, accountId);
    const insight = await transformEmail(rawEmail);

    if (insight) {
      await firebaseService.storeInsightsAndWait(userId, [insight]);
    }

    // Recorded whether or not it produced an insight: the next manual sync must
    // not spend another model call re-reading mail this webhook already paid
    // for, and "it was not an order" is just as much a settled answer.
    await this.#rememberProcessedEmail(userId, accountId, rawEmail);

    if (!insight) {
      return { processed: false, reason: "not_order_or_subscription" };
    }

    return {
      processed: true,
      type: insight.data.type,
    };
  }

  /**
   * Adds one email to an account's ledger without moving its watermark — the
   * webhook proves this single mail was handled, not that everything up to now
   * has been.
   */
  async #rememberProcessedEmail(userId, accountId, rawEmail) {
    try {
      const state = await firebaseService.getAccountSyncState(userId, accountId);
      await firebaseService.updateAccountSyncState(userId, accountId, {
        lastSyncedAt: state.lastSyncedAt,
        recentEmailIds: mergeLedger(
          state.recentEmailIds,
          [stableSourceId(rawEmail)],
          env.sync.ledgerSize
        ),
      });
    } catch (error) {
      // Losing the ledger entry only costs one duplicated extraction later; it
      // must never turn a successfully handled webhook into a failure.
      logger.warn(`Could not record processed email for account ${accountId}: ${error.message}`);
    }
  }
}

export default new EmailService();
