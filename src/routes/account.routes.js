import express from "express";

import {
  createConnectionLink,
  getConnectedAccounts,
  handleUnipileCallback,
} from "../controllers/account.controller.js";
import authenticate from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/unipile/callback", handleUnipileCallback);
router.get("/", authenticate, getConnectedAccounts);
router.post("/connect", authenticate, createConnectionLink);

export default router;
