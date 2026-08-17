/**
 * Periodic sweep of the forwarding mailboxes.
 *
 * Forwarded mail used to sit in its mailbox until somebody opened the page and
 * pressed Sync — which also meant it was never cleared, so the mailbox filled
 * toward its quota no matter how the extraction went. This runs the same sync
 * on a timer instead, so mail is read, stored and removed on its own.
 *
 * Deliberately an in-process timer rather than a cron entry: it needs the same
 * configuration and Firestore credentials the server already holds, and there
 * is nothing to schedule when the server is not running anyway. The cost is
 * that a recycled process restarts the interval — harmless, because a sweep
 * that never happened is picked up whole by the next one.
 */

import env from "../config/env.js";
import forwardingService from "./forwarding.service.js";
import logger from "../utils/logger.js";

let timer = null;
let running = false;

const tick = async () => {
  // A sweep that outlives its interval must not be started again underneath
  // itself: two runs over one mailbox would extract the same mail twice and
  // race each other to delete it.
  if (running) {
    logger.warn("Forwarding sweep is still running; skipping this interval.");
    return;
  }

  running = true;
  try {
    await forwardingService.syncAll();
  } catch (error) {
    // Never allowed to reject: an unhandled rejection here would take down the
    // server over a mail problem.
    logger.error("Forwarding sweep failed.", error);
  } finally {
    running = false;
  }
};

export const startForwardingScheduler = () => {
  if (timer) return timer;

  if (env.cpanel.sweepMinutes === 0) {
    logger.info("Forwarding sweep disabled (CPANEL_SYNC_INTERVAL_MINUTES=0).");
    return null;
  }

  if (!env.cpanel.imap.host) {
    logger.info("Forwarding sweep disabled: CPANEL_IMAP_HOST is not set.");
    return null;
  }

  timer = setInterval(tick, env.cpanel.sweepMinutes * 60 * 1000);
  // Must not be what keeps the process alive, or the server could never exit.
  timer.unref();

  logger.info(`Forwarding sweep scheduled every ${env.cpanel.sweepMinutes} minute(s).`);
  return timer;
};

export const stopForwardingScheduler = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};
