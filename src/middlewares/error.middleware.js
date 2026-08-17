import logger from "../utils/logger.js";
import { errorResponse } from "../utils/response.js";

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = err.message || "Internal Server Error";

  logger.error(`${req.method} ${req.originalUrl} - ${message}`, {
    statusCode,
    stack: err.stack,
  });

  return errorResponse(res, message, statusCode, err.errors ?? null);
};

export default errorHandler;
