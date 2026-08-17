import env from "../config/env.js";
import { successResponse } from "../utils/response.js";

export const getPublicConfig = (req, res) => {
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(req.hostname);
  return successResponse(res, {
    firebase: {
      apiKey: env.firebase.web.apiKey,
      authDomain: env.firebase.web.authDomain,
      projectId: env.firebase.projectId,
      appId: env.firebase.web.appId,
    },
    localDevelopment: env.nodeEnv !== "production" && isLoopback,
  });
};
