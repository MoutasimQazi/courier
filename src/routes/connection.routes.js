import express from "express";

import {
  createConnectionLink,
  disconnectAccounts,
  getConnectionStatus,
  handleUnipileCallback,
  reconnectAccount,
} from "../controllers/account.controller.js";
import authenticate from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/unipile-callback", handleUnipileCallback);
router.post("/start", authenticate, createConnectionLink);
router.get("/status", authenticate, getConnectionStatus);
router.post("/reconnect", authenticate, reconnectAccount);
router.delete("/", authenticate, disconnectAccounts);

export default router;
