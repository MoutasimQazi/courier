import { timingSafeEqual } from "node:crypto";

import env from "../config/env.js";
import emailService from "../services/email.service.js";
import firebaseService from "../services/firebase.service.js";
import { errorResponse, successResponse } from "../utils/response.js";

const secretMatches = (suppliedSecret) => {
  const expected = Buffer.from(env.unipile.webhookSecret);
  const supplied = Buffer.from(suppliedSecret);
  return expected.length > 0
    && expected.length === supplied.length
    && timingSafeEqual(expected, supplied);
};

const authenticateWebhook = (req, res) => {
  const suppliedSecret = String(req.get("Unipile-Auth") || "");
  if (!secretMatches(suppliedSecret)) {
    errorResponse(res, "Invalid Unipile webhook secret.", 401);
    return false;
  }
  return true;
};

export const handleNewEmailWebhook = async (req, res, next) => {
  if (!authenticateWebhook(req, res)) return;

  try {
    const result = await emailService.processWebhookEmail(req.body);
    return successResponse(res, result, "Unipile email webhook processed.");
  } catch (error) {
    return next(error);
  }
};

export const handleAccountStatusWebhook = async (req, res, next) => {
  if (!authenticateWebhook(req, res)) return;

  try {
    const statusPayload = req.body?.AccountStatus;
    const accountId = typeof statusPayload?.account_id === "string"
      ? statusPayload.account_id.trim()
      : "";
    const rawStatus = typeof statusPayload?.message === "string"
      ? statusPayload.message.trim().toUpperCase()
      : "";

    if (!accountId || !rawStatus) {
      return errorResponse(
        res,
        "The account status webhook is missing account_id or message.",
        400
      );
    }

    const userId = await firebaseService.findUserIdByAccountId(accountId);
    if (!userId) {
      return successResponse(
        res,
        { processed: false, reason: "account_not_mapped" },
        "Account status webhook ignored."
      );
    }

    const status = rawStatus === "OK" ? "connected" : "expired";
    await firebaseService.updateConnectedAccountStatus(userId, accountId, status);
    return successResponse(
      res,
      { processed: true, status },
      "Account status webhook processed."
    );
  } catch (error) {
    return next(error);
  }
};
