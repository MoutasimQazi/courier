import { createHash } from "node:crypto";

import firebaseService from "./firebase.service.js";
import parserService from "./parser.service.js";
import unipileService from "./unipile.service.js";
import logger from "../utils/logger.js";

const EMAIL_HISTORY_DAYS = 30;
const MAX_PAGE_SIZE = 250;
const PARSE_CONCURRENCY = 10;
// Hard ceiling on emails parsed per sync request, across all pages. Extraction
// is one model call each, so this is what decides how long a sync takes.
const MAX_EMAILS_PER_SYNC = 200;
// Belt and braces against a cursor that never advances.
const MAX_PAGES = 20;

const getHistoryStart = () => new Date(
  Date.now() - EMAIL_HISTORY_DAYS * 24 * 60 * 60 * 1000
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

const hasSubscriptionEvidence = (parsed) => Boolean(
  parsed.subscription?.renewalDate
  || parsed.subscription?.trialEndsAt
  || parsed.subscription?.billingCycle
  || (parsed.subscription?.amount != null && parsed.subscription?.currency)
  // A cancellation confirmation usually states no amount, date or cycle — the
  // status is the concrete fact in that case, so accept it on its own.
  || parsed.filter?.subscriptionStatus === "cancelled"
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
  const merchant = (parsed.merchant ?? "").trim().toLowerCase();

  if (parsed.category === "courier") {
    // The order number is the real identity; tracking number is the runner-up
    // because one order can ship as several parcels.
    const reference = parsed.order?.orderNumber ?? parsed.shipping?.trackingNumber;
    if (merchant && reference) {
      return `order:${merchant}:${String(reference).trim().toLowerCase()}`;
    }
  } else if (merchant) {
    // One subscription per service. Renewals month after month are the same
    // subscription, so they must land on the same document.
    return `subscription:${merchant}`;
  }

  return stableSourceId(rawEmail);
};

/**
 * Collapse insights that describe the same order or subscription, keeping the
 * most recent email for each. Firestore writes with set(), so without this the
 * winner within a single sync would be whichever request happened to finish
 * last rather than whichever email is newest.
 */
const trackingAlias = (data) => `${String(data.merchant ?? "").trim().toLowerCase()}`
  + `:${String(data.trackingId ?? "").trim().toLowerCase()}`;

export const dedupeInsights = (insights) => {
  // Later updates about a parcel ("out for delivery", "delivered") often carry
  // only the tracking number, while the first mail carried the order number —
  // which would key them apart. Map each tracking number to the order key that
  // named it, so the whole stream lands on one record.
  const orderKeyByTracking = new Map();
  for (const { sourceId, data } of insights) {
    if (data.type === "order" && data.orderId && data.trackingId) {
      orderKeyByTracking.set(trackingAlias(data), sourceId);
    }
  }

  const canonicalKey = ({ sourceId, data }) => (
    data.type === "order" && !data.orderId && data.trackingId
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

const toOrder = (parsed) => ({
  type: "order",
  merchant: parsed.merchant ?? null,
  merchantDomain: parsed.merchantDomain ?? null,
  // productUrl is where the item lives; imageUrl is its picture. serviceUrl and
  // logoUrl identify the company behind it.
  productUrl: parsed.productUrl ?? null,
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
  imageUrl: parsed.imageUrl ?? null,
  // Filter facet, stored raw (not title-cased) so the client can match on it.
  category: parsed.filter?.orderCategory ?? null,
  items: parsed.order?.items ?? [],
});

const toSubscription = (parsed) => ({
  type: "subscription",
  merchant: parsed.merchant ?? null,
  merchantDomain: parsed.merchantDomain ?? null,
  orderName: parsed.order?.orderName ?? null,
  imageUrl: parsed.imageUrl ?? null,
  // The service's own page, and a logo derived from its domain.
  serviceUrl: parsed.serviceUrl ?? null,
  logoUrl: parsed.logoUrl ?? null,
  receivedAt: parsed.receivedAt ?? null,
  emailId: parsed.emailId ?? null,
  plan: extractPlan(parsed),
  amount: parsed.subscription?.amount ?? null,
  currency: parsed.subscription?.currency ?? null,
  billingCycle: parsed.subscription?.billingCycle ?? null,
  renewalDate: parsed.subscription?.renewalDate ?? null,
  trialEndsAt: parsed.subscription?.trialEndsAt ?? null,
  // Filter facets, stored raw so the client can match on them.
  category: parsed.filter?.subscriptionCategory ?? null,
  subscriptionStatus: parsed.filter?.subscriptionStatus ?? null,
});

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

const groupInsights = (insights) => ({
  orders: insights.filter(({ data }) => data.type === "order").map(({ data }) => data),
  subscriptions: insights.filter(({ data }) => data.type === "subscription").map(({ data }) => data),
});

class EmailService {
  async #getAccountInsights({ accountId, cursor, limit } = {}) {
    const items = [];
    const seenEmailIds = new Set();
    const after = getHistoryStart();
    const pageSize = limit ?? MAX_PAGE_SIZE;
    let nextCursor = cursor;
    let pages = 0;

    const startedAt = Date.now();

    // `limit` is a page size, so this loop used to walk every page in the
    // 30-day window with no ceiling. Each email costs a model call, so the
    // total is what has to be bounded — otherwise a busy mailbox makes the
    // request run for minutes and the client gives up before it answers.
    do {
      const result = await unipileService.getEmails({
        accountId,
        cursor: nextCursor,
        limit: pageSize,
        after,
      });

      pages += 1;

      for (const item of result.items) {
        if (items.length >= MAX_EMAILS_PER_SYNC) break;

        const id = stableSourceId(item);
        if (!seenEmailIds.has(id)) {
          seenEmailIds.add(id);
          items.push(item);
        }
      }

      nextCursor = result.cursor;
      // A cursor that never advances, or pages of nothing but already-seen
      // mail, would spin here forever without a page ceiling.
    } while (nextCursor && items.length < MAX_EMAILS_PER_SYNC && pages < MAX_PAGES);

    if (pages >= MAX_PAGES) {
      logger.warn(`Sync for account ${accountId} stopped at the ${MAX_PAGES}-page ceiling.`);
    }

    // One model call per email, so cap the fan-out rather than mapping over the
    // whole page at once. Failures are collected instead of thrown: a single
    // unreachable API call should not lose an entire account's sync.
    const errors = [];
    const parsed = await parserService.parseMany(items, { concurrency: PARSE_CONCURRENCY, errors });

    for (const { emailId, error } of errors) {
      logger.error(`Extraction failed for email ${emailId ?? "(unknown)"}.`, error);
    }

    const extracted = items
      .map((item, index) => buildInsight(item, parsed[index]))
      .filter(Boolean);

    // Several emails routinely describe one order or one subscription; keep the
    // newest of each so the caller sees one entry per thing, not per email.
    const insights = dedupeInsights(extracted);

    logger.info(
      `Sync for account ${accountId}: ${items.length} email(s) scanned, `
      + `${extracted.length} insight(s) -> ${insights.length} after merging duplicates, `
      + `${errors.length} failure(s), ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );

    return {
      insights,
      cursor: null,
      // Extraction failures are non-fatal by design, which means a totally
      // broken model call looks identical to "no relevant mail" — both return
      // an empty list. Report the counts so the two can be told apart.
      stats: {
        scanned: items.length,
        // Pre-merge count answers "did extraction work"; merged answers "how
        // many things did the user actually get". Both matter when diagnosing.
        extracted: extracted.length,
        merged: insights.length,
        failed: errors.length,
        firstError: errors.length ? String(errors[0].error?.message ?? errors[0].error) : null,
      },
    };
  }

  async getEmails({ userId, cursor, limit } = {}) {
    const accounts = await firebaseService.getConnectedAccounts(userId);
    if (accounts.length === 0) {
      const error = new Error("Connect a mailbox before fetching email intelligence.");
      error.statusCode = 409;
      error.errors = { field: "connectedAccount" };
      throw error;
    }

    const results = await Promise.all(accounts.map((account) => {
      return this.#getAccountInsights({
        accountId: account.accountId,
        cursor,
        limit,
      });
    }));
    // Merge again across accounts: the same order can arrive in two mailboxes.
    const insights = dedupeInsights(results.flatMap((result) => result.insights));

    firebaseService.storeInsights(userId, insights);

    const diagnostics = results.reduce((total, { stats }) => ({
      accounts: total.accounts + 1,
      scanned: total.scanned + stats.scanned,
      extracted: total.extracted + stats.extracted,
      failed: total.failed + stats.failed,
      firstError: total.firstError ?? stats.firstError,
    }), { accounts: 0, scanned: 0, extracted: 0, failed: 0, firstError: null });

    // Counted after the cross-account merge, so it matches what is returned.
    diagnostics.merged = insights.length;

    if (diagnostics.failed > 0) {
      logger.warn(
        `Sync finished with ${diagnostics.failed}/${diagnostics.scanned} extraction failure(s). `
        + `First error: ${diagnostics.firstError}`
      );
    } else if (diagnostics.scanned === 0) {
      logger.warn("Sync found no emails at all — check the account connection and the 30-day window.");
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
    if (!insight) {
      return { processed: false, reason: "not_order_or_subscription" };
    }

    await firebaseService.storeInsights(userId, [insight]);
    return {
      processed: true,
      type: insight.data.type,
    };
  }
}

export default new EmailService();
