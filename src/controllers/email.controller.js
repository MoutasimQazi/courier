import emailService from "../services/email.service.js";
import { intelligenceResponse } from "../utils/response.js";

const badRequest = (message, field) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.errors = { field };
  return error;
};

const requiredString = (value, field) => {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`${field} is required.`, field);
  }
  return value.trim();
};

const getRequestOptions = (req) => {
  const options = {
    userId: req.user.uid,
  };

  if (req.query.cursor !== undefined) {
    options.cursor = requiredString(req.query.cursor, "cursor");
  }

  if (req.query.limit !== undefined) {
    const limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      throw badRequest("limit must be an integer between 1 and 250.", "limit");
    }
    options.limit = limit;
  }

  return options;
};

export const getEmails = async (req, res, next) => {
  try {
    const options = getRequestOptions(req);
    const result = await emailService.getEmails(options);
    return intelligenceResponse(res, result.orders, result.subscriptions, result.cursor, result.diagnostics);
  } catch (error) {
    return next(error);
  }
};

export const getEmailById = async (req, res, next) => {
  try {
    const options = getRequestOptions(req);
    const result = await emailService.getEmailById({
      id: requiredString(req.params.id, "id"),
      userId: options.userId,
    });
    return intelligenceResponse(res, result.orders, result.subscriptions);
  } catch (error) {
    return next(error);
  }
};

export const syncEmails = async (req, res, next) => {
  try {
    const options = getRequestOptions(req);
    const result = await emailService.syncEmails(options);
    return intelligenceResponse(res, result.orders, result.subscriptions, result.cursor, result.diagnostics);
  } catch (error) {
    return next(error);
  }
};
