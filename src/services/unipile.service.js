import unipileClient from "../config/unipile.js";
import env from "../config/env.js";

const createServiceError = (message, statusCode, errors = null) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errors = errors;
  return error;
};

const assertConfiguration = (accountId) => {
  const required = [
    [env.unipile.baseUrl, "UNIPILE_BASE_URL", "Missing Unipile base URL."],
    [env.unipile.apiKey, "UNIPILE_API_KEY", "Missing Unipile API key."],
    [accountId, "accountId", "Missing Unipile account ID."],
  ];

  for (const [value, field, message] of required) {
    if (!value) throw createServiceError(message, 500, { field });
  }
};

const mapUnipileError = (error, fallbackMessage) => {
  if (error.statusCode) return error;

  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
    return createServiceError("Unipile request timed out.", 504);
  }

  if (!error.response) {
    return createServiceError("Unable to connect to Unipile.", 503);
  }

  const upstreamStatus = error.response.status;
  const statusCode = upstreamStatus === 404 ? 404 : upstreamStatus >= 500 ? 502 : upstreamStatus;
  const responseData = error.response.data;
  const message = responseData?.message || responseData?.title || fallbackMessage;
  return createServiceError(message, statusCode, responseData ?? null);
};

const validateListResponse = (data) => {
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : null;
  if (!items) throw createServiceError("Unipile returned an invalid email list response.", 502);
  return { items, cursor: data?.cursor ?? null };
};

const getUnipileApiRoot = () => {
  try {
    const url = new URL(env.unipile.baseUrl);
    url.pathname = url.pathname.replace(/\/api\/v1\/?$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
};

class UnipileService {
  async getAccounts() {
    if (!env.unipile.baseUrl || !env.unipile.apiKey) {
      throw createServiceError("Unipile is not configured.", 500);
    }

    try {
      const response = await unipileClient.get("/accounts");
      const accounts = Array.isArray(response.data?.items)
        ? response.data.items
        : Array.isArray(response.data)
          ? response.data
          : null;

      if (!accounts) {
        throw createServiceError("Unipile returned an invalid account list response.", 502);
      }

      return accounts;
    } catch (error) {
      throw mapUnipileError(error, "Failed to retrieve Unipile accounts.");
    }
  }

  async getAccount(accountId) {
    assertConfiguration(accountId);

    try {
      const response = await unipileClient.get(`/accounts/${encodeURIComponent(accountId)}`);
      return response.data;
    } catch (error) {
      throw mapUnipileError(error, "Failed to retrieve the Unipile account.");
    }
  }

  async createHostedAuthLink({
    userId,
    notifyUrl,
    successRedirectUrl,
    failureRedirectUrl,
  }) {
    if (!env.unipile.baseUrl || !env.unipile.apiKey) {
      throw createServiceError("Unipile is not configured.", 500);
    }

    const apiUrl = getUnipileApiRoot();
    if (!apiUrl) {
      throw createServiceError("UNIPILE_BASE_URL is invalid.", 500);
    }

    try {
      const response = await unipileClient.post("/hosted/accounts/link", {
        type: "create",
        providers: ["GOOGLE", "OUTLOOK", "MAIL"],
        api_url: apiUrl,
        expiresOn: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        notify_url: notifyUrl,
        success_redirect_url: successRedirectUrl,
        failure_redirect_url: failureRedirectUrl,
        name: userId,
      });

      const url = response.data?.url;
      if (!url) {
        throw createServiceError("Unipile did not return a Hosted Auth URL.", 502);
      }

      return url;
    } catch (error) {
      throw mapUnipileError(error, "Unable to create the mailbox connection link.");
    }
  }

  async createHostedReconnectLink({
    accountId,
    userId,
    notifyUrl,
    successRedirectUrl,
    failureRedirectUrl,
  }) {
    assertConfiguration(accountId);

    const apiUrl = getUnipileApiRoot();
    if (!apiUrl) {
      throw createServiceError("UNIPILE_BASE_URL is invalid.", 500);
    }

    try {
      const response = await unipileClient.post("/hosted/accounts/link", {
        type: "reconnect",
        reconnect_account: accountId,
        api_url: apiUrl,
        expiresOn: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        notify_url: notifyUrl,
        success_redirect_url: successRedirectUrl,
        failure_redirect_url: failureRedirectUrl,
        name: userId,
      });

      const url = response.data?.url;
      if (!url) {
        throw createServiceError("Unipile did not return a reconnect URL.", 502);
      }

      return url;
    } catch (error) {
      throw mapUnipileError(error, "Unable to create the mailbox reconnection link.");
    }
  }

  async deleteAccount(accountId) {
    assertConfiguration(accountId);

    try {
      await unipileClient.delete(`/accounts/${encodeURIComponent(accountId)}`);
    } catch (error) {
      throw mapUnipileError(error, "Failed to delete the Unipile account.");
    }
  }

  async getEmails({ accountId, cursor, limit, after, before } = {}) {
    assertConfiguration(accountId);

    try {
      const response = await unipileClient.get("/emails", {
        params: {
          account_id: accountId,
          ...(cursor ? { cursor } : {}),
          ...(limit ? { limit } : {}),
          ...(after ? { after } : {}),
          ...(before ? { before } : {}),
        },
      });
      return validateListResponse(response.data);
    } catch (error) {
      throw mapUnipileError(error, "Failed to fetch emails from Unipile.");
    }
  }

  async getEmailById(id, accountId) {
    assertConfiguration(accountId);

    try {
      const response = await unipileClient.get(`/emails/${encodeURIComponent(id)}`, {
        params: { account_id: accountId },
      });

      if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
        throw createServiceError("Unipile returned an invalid email response.", 502);
      }

      return response.data;
    } catch (error) {
      throw mapUnipileError(error, "Failed to fetch email from Unipile.");
    }
  }
}

export default new UnipileService();
