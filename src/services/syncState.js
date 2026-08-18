/**
 * Pure helpers behind the incremental sync.
 *
 * A sync used to re-read the same 30-day window on every request and re-run the
 * extraction model over every email in it, so two clicks in a row cost twice and
 * returned identical data. The fix is a per-account watermark plus a ledger of
 * email ids already processed; everything that decides *which* emails a run has
 * to pay for lives here, with no I/O, so it can be tested on its own.
 */

const isoOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Legal suffixes a company writes after its name — and which the extraction
 * model includes or drops depending on how a given email happened to word it.
 * "Anthropic" and "Anthropic, PBC" are one service, so the suffix is cut off
 * before a name is ever used as identity.
 */
const LEGAL_SUFFIX = /[\s,]+(?:inc|llc|l\.l\.c|ltd|limited|pbc|plc|gmbh|ug|bv|b\.v|nv|n\.v|sa|s\.a|sas|srl|spa|ag|oy|ab|as|aps|pte|pty|co|corp|corporation|company|holdings|group|technologies|labs)\.?$/i;

const normaliseMerchantName = (value) => {
  let name = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

  // "Foo Technologies, Inc." carries two of them, so strip until none is left.
  // Bounded, because a name that is *only* suffixes must not reduce to "".
  for (let pass = 0; pass < 3; pass += 1) {
    const trimmed = name.replace(LEGAL_SUFFIX, "").trim();
    if (!trimmed || trimmed === name) break;
    name = trimmed;
  }

  return name.replace(/[.,]+$/, "").trim();
};

/**
 * Which *service* a record belongs to.
 *
 * The merchant name is free text the model reads off the mail, and it is not
 * stable: the same Anthropic receipt came back as "Anthropic" one sync and
 * "Anthropic, PBC" the next, which keyed the two extractions apart and left a
 * duplicate subscription behind. The domain behind the brand is derived from
 * the service URL or the sender rather than written by the model, so it says
 * the same thing every time — it is the identity, and the cleaned-up name is
 * only the fallback for mail with no usable domain.
 */
export const merchantIdentity = (data) => {
  const domain = String(data?.merchantDomain ?? "").trim().toLowerCase();
  if (domain) return domain;

  return normaliseMerchantName(data?.merchant) || null;
};

/**
 * The insight key for an already-stored document.
 *
 * Mirrors insightKey() in email.service.js, but reads the flattened shape that
 * toOrder()/toSubscription() write rather than the parser's nested output. The
 * two must agree: a stored order and a freshly extracted one describing the
 * same parcel have to produce the same key, or the merge would treat them as
 * separate records and the response would show duplicates.
 *
 * Returns null when the stored document has nothing stable to group on — the
 * caller falls back to the id it was stored under.
 */
export const keyFromData = (data) => {
  if (!data || typeof data !== "object") return null;
  const merchant = merchantIdentity(data);

  if (data.type === "order") {
    const reference = data.orderId ?? data.trackingId;
    if (merchant && reference) {
      return `order:${merchant}:${String(reference).trim().toLowerCase()}`;
    }
    return null;
  }

  return merchant ? `subscription:${merchant}` : null;
};

/**
 * The time window a run has to ask the provider for.
 *
 * With no watermark this is a first run, so it backfills the whole history
 * window. Otherwise it starts a little *before* the watermark: a mail can be
 * delivered after a sync has already passed its timestamp, and querying from
 * the watermark exactly would step over it forever. The overlap is what makes
 * that safe, and the ledger is what makes it free — re-offered emails are
 * recognised and never reach the model.
 */
export const resolveWindow = ({ lastSyncedAt, historyStart, overlapMinutes = 0 }) => {
  const watermark = isoOrNull(lastSyncedAt);
  if (!watermark) return { after: historyStart, isBackfill: true };

  const overlapped = new Date(
    new Date(watermark).getTime() - overlapMinutes * 60 * 1000
  ).toISOString();

  // Never reach back further than the history window the product promises.
  return { after: overlapped < historyStart ? historyStart : overlapped, isBackfill: false };
};

/**
 * Newest-first ledger of processed email ids, trimmed to a fixed size.
 *
 * Only has to cover the overlap window, not all of history — anything older is
 * excluded by `after` before the ledger is ever consulted.
 */
export const mergeLedger = (existingIds = [], newIds = [], limit = 500) => {
  const merged = [];
  for (const id of [...newIds, ...existingIds]) {
    const value = typeof id === "string" ? id : String(id ?? "");
    if (!value || merged.includes(value)) continue;
    merged.push(value);
    if (merged.length >= limit) break;
  }
  return merged;
};

/**
 * Where the watermark lands after a run.
 *
 * Normally the moment the run started — anything that arrives later is by
 * definition new. But an email whose extraction *failed* has not been dealt
 * with, and moving the watermark past it would drop it silently. So a failure
 * pulls the watermark back to just before the oldest one, and the next run
 * re-reads from there. That re-read is nearly free: every email in between is
 * in the ledger already, so only the failures are paid for again.
 */
export const nextWatermark = ({ syncStartedAt, oldestFailedAt = null }) => {
  const failed = isoOrNull(oldestFailedAt);
  if (!failed) return syncStartedAt;

  const justBefore = new Date(new Date(failed).getTime() - 1000).toISOString();
  return justBefore < syncStartedAt ? justBefore : syncStartedAt;
};

/**
 * The earliest received date among the emails that failed extraction, or null
 * when they all succeeded.
 */
export const oldestFailureDate = (failedEmails = []) => {
  let oldest = null;
  for (const email of failedEmails) {
    const date = isoOrNull(email?.date);
    if (date && (!oldest || date < oldest)) oldest = date;
  }
  return oldest;
};
