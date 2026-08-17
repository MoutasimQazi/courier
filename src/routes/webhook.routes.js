import express from "express";

import {
  handleAccountStatusWebhook,
  handleNewEmailWebhook,
} from "../controllers/webhook.controller.js";

const router = express.Router();

router.post("/email", handleNewEmailWebhook);
router.post("/account-status", handleAccountStatusWebhook);

export default router;
