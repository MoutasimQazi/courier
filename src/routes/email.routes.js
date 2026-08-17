import express from "express";

import {
  getEmails,
  getEmailById,
  syncEmails,
} from "../controllers/email.controller.js";
import authenticate from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(authenticate);
router.get("/", getEmails);

router.get("/:id", getEmailById);

router.post("/sync", syncEmails);

export default router;
