import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import env from "../config/env.js";

const getKey = () => {
  const source = env.cpanel.credentialsKey;
  let key = null;

  if (/^[a-f\d]{64}$/i.test(source)) {
    key = Buffer.from(source, "hex");
  } else if (source) {
    key = Buffer.from(source, "base64");
  }

  if (!key || key.length !== 32) {
    const error = new Error(
      "FORWARDING_CREDENTIALS_KEY must be a 32-byte key encoded as base64 or 64 hexadecimal characters."
    );
    error.statusCode = 503;
    throw error;
  }

  return key;
};

export const encryptCredential = (value) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ["v1", iv, tag, ciphertext]
    .map((part) => Buffer.isBuffer(part) ? part.toString("base64url") : part)
    .join(":");
};

export const decryptCredential = (value) => {
  const [version, ivValue, tagValue, ciphertextValue] = String(value || "").split(":");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    const error = new Error("Stored forwarding mailbox credentials are invalid.");
    error.statusCode = 500;
    throw error;
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getKey(),
      Buffer.from(ivValue, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    const error = new Error("Unable to decrypt the forwarding mailbox credentials.");
    error.statusCode = 500;
    throw error;
  }
};
