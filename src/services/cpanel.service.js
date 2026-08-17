import axios from "axios";

import env from "../config/env.js";

const configurationError = (message) => {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
};

const requireConfiguration = () => {
  const missing = [
    ["CPANEL_BASE_URL", env.cpanel.baseUrl],
    ["CPANEL_USERNAME", env.cpanel.username],
    ["CPANEL_API_TOKEN", env.cpanel.apiToken],
    ["CPANEL_EMAIL_DOMAIN", env.cpanel.emailDomain],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw configurationError(`Missing cPanel configuration: ${missing.join(", ")}.`);
  }
};

const request = async (operation, params) => {
  requireConfiguration();

  try {
    const response = await axios.get(`${env.cpanel.baseUrl}/execute/Email/${operation}`, {
      params,
      timeout: env.cpanel.timeout,
      headers: {
        Authorization: `cpanel ${env.cpanel.username}:${env.cpanel.apiToken}`,
        Accept: "application/json",
      },
    });
    const result = response.data;

    if (result?.status !== 1) {
      const message = result?.errors?.filter(Boolean).join(" ")
        || result?.messages?.filter(Boolean).join(" ")
        || `cPanel could not complete ${operation}.`;
      const error = new Error(message);
      error.statusCode = 502;
      throw error;
    }

    return result.data;
  } catch (error) {
    if (error.statusCode) throw error;
    const wrapped = new Error(error.response?.data?.errors?.join(" ") || error.message || "cPanel request failed.");
    wrapped.statusCode = error.response?.status === 401 || error.response?.status === 403 ? 502 : 503;
    throw wrapped;
  }
};

const isMissingMailboxError = (error) => {
  return error?.statusCode === 502
    && /do not have an email account named|email account .* does not exist|account not found/i.test(
      String(error.message || "")
    );
};

class CpanelService {
  validateConfiguration() {
    requireConfiguration();
  }

  async createMailbox(localPart, password) {
    return request("add_pop", {
      email: localPart,
      domain: env.cpanel.emailDomain,
      password,
      quota: env.cpanel.mailboxQuotaMb,
    });
  }

  async deleteMailbox(localPart) {
    try {
      const result = await request("delete_pop", {
        email: localPart,
        domain: env.cpanel.emailDomain,
      });
      return { deleted: true, alreadyMissing: false, result };
    } catch (error) {
      // Deletion is intentionally idempotent. The Firebase mapping must still
      // be removable when an administrator already deleted the cPanel mailbox.
      if (isMissingMailboxError(error)) {
        return { deleted: false, alreadyMissing: true, result: null };
      }
      throw error;
    }
  }

  async mailboxExists(email) {
    const mailboxes = await request("list_pops", {});
    return Array.isArray(mailboxes)
      && mailboxes.some((mailbox) => String(mailbox?.email || "").toLowerCase() === email.toLowerCase());
  }
}

export default new CpanelService();
