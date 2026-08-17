import express from "express";

import {
  disableForwarding,
  completeForwardingVerification,
  enableForwarding,
  getForwardingStatus,
  getForwardingVerification,
  syncForwarding,
} from "../controllers/forwarding.controller.js";
import authenticate from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(authenticate);
router.post("/enable", enableForwarding);
router.get("/status", getForwardingStatus);
router.get("/verification", getForwardingVerification);
router.post("/verification/complete", completeForwardingVerification);
router.post("/sync", syncForwarding);
router.delete("/", disableForwarding);

export default router;
