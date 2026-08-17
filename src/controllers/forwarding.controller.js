import forwardingService from "../services/forwarding.service.js";
import { intelligenceResponse, successResponse } from "../utils/response.js";

export const enableForwarding = async (req, res, next) => {
  try {
    const result = await forwardingService.enable(req.user.uid);
    return successResponse(
      res,
      result.mailbox,
      result.created ? "Autoforwarding mailbox created." : "Autoforwarding mailbox already exists.",
      result.created ? 201 : 200
    );
  } catch (error) {
    return next(error);
  }
};

export const getForwardingStatus = async (req, res, next) => {
  try {
    const result = await forwardingService.status(req.user.uid);
    return successResponse(res, result.mailbox, result.mailbox ? "Mailbox status found." : "No mailbox configured.");
  } catch (error) {
    return next(error);
  }
};

export const syncForwarding = async (req, res, next) => {
  try {
    const result = await forwardingService.sync(req.user.uid);
    return intelligenceResponse(res, result.orders, result.subscriptions, undefined, {
      scanned: result.scanned,
      accepted: result.accepted,
    });
  } catch (error) {
    return next(error);
  }
};

export const getForwardingVerification = async (req, res, next) => {
  try {
    const result = await forwardingService.getVerification(req.user.uid);
    return successResponse(
      res,
      result,
      result.status === "verification_received"
        ? "Gmail forwarding verification received."
        : "Waiting for Gmail forwarding verification."
    );
  } catch (error) {
    return next(error);
  }
};

export const completeForwardingVerification = async (req, res, next) => {
  try {
    const result = await forwardingService.completeVerification(req.user.uid);
    return successResponse(res, result.mailbox, "Gmail forwarding marked as verified.");
  } catch (error) {
    return next(error);
  }
};

export const disableForwarding = async (req, res, next) => {
  try {
    const result = await forwardingService.disable(req.user.uid);
    return successResponse(res, result, result.removed ? "Autoforwarding mailbox removed." : "No mailbox was configured.");
  } catch (error) {
    return next(error);
  }
};
