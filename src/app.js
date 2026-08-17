import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { fileURLToPath } from "node:url";
import path from "node:path";

import env from "./config/env.js";
import errorHandler from "./middlewares/error.middleware.js";
import notFound from "./middlewares/notFound.middleware.js";
import accountRoutes from "./routes/account.routes.js";
import connectionRoutes from "./routes/connection.routes.js";
import emailRoutes from "./routes/email.routes.js";
import forwardingRoutes from "./routes/forwarding.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import { getPublicConfig } from "./controllers/config.controller.js";
import logger from "./utils/logger.js";
import { successResponse } from "./utils/response.js";

const app = express();
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://www.gstatic.com", "https://apis.google.com"],
      connectSrc: [
        "'self'",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://www.googleapis.com",
        "https://accounts.google.com",
        "https://*.googleapis.com",
      ],
      frameSrc: [
        "'self'",
        "https://accounts.google.com",
        ...(env.firebase.web.authDomain ? [`https://${env.firebase.web.authDomain}`] : []),
      ],
      imgSrc: ["'self'", "data:", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  morgan(env.nodeEnv === "production" ? "combined" : "dev", {
    stream: { write: (message) => logger.info(message.trim()) },
    skip: (req) => [
      "/api/accounts/unipile/callback",
      "/api/connections/unipile-callback",
    ].includes(req.path),
  })
);
app.use(express.static(publicDirectory));

app.get("/api/health", (req, res) => {
  return successResponse(res, { status: "ok" }, "Email Parser Backend is running.");
});

app.get("/api/config", getPublicConfig);
app.use("/api/accounts", accountRoutes);
app.use("/api/connections", connectionRoutes);
app.use("/api/emails", emailRoutes);
app.use("/api/forwarding", forwardingRoutes);
app.use("/api/webhooks/unipile", webhookRoutes);
app.use(notFound);
app.use(errorHandler);

export default app;
