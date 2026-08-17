import { timingSafeEqual } from "node:crypto";

import env from "../config/env.js";
import accountService from "../services/account.service.js";
import { errorResponse, successResponse } from "../utils/response.js";

const callbackTokenMatches = (suppliedToken) => {
  const expected = Buffer.from(env.unipile.callbackSecret);
  const supplied = Buffer.from(suppliedToken);
  return expected.length > 0
    && expected.length === supplied.length
    && timingSafeEqual(expected, supplied);
};

export const createConnectionLink = async (req, res, next) => {
  try {
    const url = await accountService.createConnectionLink(req.user);
    return successResponse(res, { url }, "Mailbox connection link created.");
  } catch (error) {
    return next(error);
  }
};

export const getConnectedAccounts = async (req, res, next) => {
  try {
    const accounts = await accountService.getPublicAccounts(req.user.uid);
    return successResponse(res, accounts, "Connected mailboxes retrieved.");
  } catch (error) {
    return next(error);
  }
};

export const getConnectionStatus = async (req, res, next) => {
  try {
    const status = await accountService.getConnectionStatus(req.user.uid);
    return successResponse(res, status, "Mailbox connection status retrieved.");
  } catch (error) {
    return next(error);
  }
};

export const reconnectAccount = async (req, res, next) => {
  try {
    const result = await accountService.createReconnectLink(req.user);
    return successResponse(res, result, "Mailbox reconnection link created.");
  } catch (error) {
    return next(error);
  }
};

export const disconnectAccounts = async (req, res, next) => {
  try {
    const result = await accountService.disconnectAccounts(req.user.uid);
    return successResponse(res, result, "Mailbox connection removed.");
  } catch (error) {
    return next(error);
  }
};

export const handleUnipileCallback = async (req, res, next) => {
  try {
    const suppliedToken = String(req.query.token || "");
    if (!callbackTokenMatches(suppliedToken)) {
      return errorResponse(res, "Invalid callback token.", 401);
    }

    await accountService.handleUnipileCallback(req.body);
    return successResponse(res, null, "Mailbox connection saved.");
  } catch (error) {
    return next(error);
  }
};
