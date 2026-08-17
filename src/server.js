import { createServer } from "node:http";

import app from "./app.js";
import env from "./config/env.js";
import firebaseService from "./services/firebase.service.js";
import {
  startForwardingScheduler,
  stopForwardingScheduler,
} from "./services/forwardingScheduler.js";
import logger from "./utils/logger.js";

const server = createServer(app);
let isShuttingDown = false;

server.once("error", (error) => {
  if (error.code === "EADDRINUSE") {
    logger.error(`Port ${env.port} is already in use. Stop the existing server or set a different PORT in .env.`);
  } else {
    logger.error("HTTP server failed to start.", error);
  }

  process.exitCode = 1;
});

server.listen(env.port, () => {
  logger.success(`Server started successfully on http://localhost:${env.port}`);
  startForwardingScheduler();
});

const shutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`${signal} received. Closing HTTP server.`);
  // Stopped first so a sweep cannot start while the server is winding down.
  stopForwardingScheduler();
  server.close(async (error) => {
    if (error) {
      logger.error("Failed to close HTTP server cleanly.", error);
      process.exitCode = 1;
      return;
    }

    await firebaseService.flush();
    logger.info("HTTP server closed.");
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
