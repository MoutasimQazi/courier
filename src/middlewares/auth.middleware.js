import { getFirebaseAuth } from "../config/firebase.js";
import env from "../config/env.js";

const unauthorized = (message) => {
  const error = new Error(message);
  error.statusCode = 401;
  error.errors = { field: "authorization" };
  return error;
};

const authenticate = async (req, res, next) => {
  try {
    const developmentUserId = req.headers["x-development-user-id"];
    const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
    if (
      env.nodeEnv !== "production"
      && isLoopback
      && typeof developmentUserId === "string"
      && /^dev-[a-f\d-]{36}$/i.test(developmentUserId)
    ) {
      req.user = { uid: developmentUserId, email: null, name: "Local test user" };
      return next();
    }

    const authorization = req.headers.authorization || "";
    const [scheme, token] = authorization.split(" ");

    if (scheme !== "Bearer" || !token) {
      throw unauthorized("A Firebase authentication token is required.");
    }

    const decoded = await getFirebaseAuth().verifyIdToken(token);
    req.user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      name: decoded.name ?? null,
    };

    return next();
  } catch (error) {
    if (error.statusCode === 401) return next(error);
    return next(unauthorized("Your login session is invalid or expired."));
  }
};

export default authenticate;
