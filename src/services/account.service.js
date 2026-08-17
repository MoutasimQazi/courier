import env from "../config/env.js";
import firebaseService from "./firebase.service.js";
import unipileService from "./unipile.service.js";

const configurationError = (message, field) => {
  const error = new Error(message);
  error.statusCode = 500;
  error.errors = { field };
  return error;
};

const connectionError = (message, statusCode, field = "connection") => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errors = { field };
  return error;
};

const normalizeAccountStatus = (account) => {
  const rawStatus = String(
    account?.sources?.[0]?.status
      ?? account?.status
      ?? account?.connection_status
      ?? ""
  ).toUpperCase();

  if (rawStatus === "OK" || rawStatus === "CONNECTED") return "connected";
  if (rawStatus === "CONNECTING" || rawStatus === "SYNCING") return "connecting";
  return "expired";
};

const toPublicConnection = (account) => ({
  mailbox: account.mailbox ?? null,
  provider: account.provider ?? null,
  status: account.status,
  connectedAt: account.connectedAt ?? null,
  updatedAt: account.updatedAt ?? null,
});

class AccountService {
  #getConnectionUrls() {
    if (!env.publicBaseUrl) {
      throw configurationError("PUBLIC_BASE_URL is required for mailbox connections.", "PUBLIC_BASE_URL");
    }
    if (!env.unipile.callbackSecret) {
      throw configurationError(
        "UNIPILE_CALLBACK_SECRET is required for mailbox connections.",
        "UNIPILE_CALLBACK_SECRET"
      );
    }

    const baseUrl = env.publicBaseUrl.replace(/\/$/, "");
    const frontendBaseUrl = (env.frontendBaseUrl || env.publicBaseUrl).replace(/\/$/, "");
    const callbackToken = encodeURIComponent(env.unipile.callbackSecret);

    return {
      notifyUrl: `${baseUrl}/api/connections/unipile-callback?token=${callbackToken}`,
      successRedirectUrl: `${frontendBaseUrl}/?connection=success`,
      failureRedirectUrl: `${frontendBaseUrl}/?connection=failed`,
    };
  }

  async createConnectionLink(user) {
    await firebaseService.ensureUser(user);

    return unipileService.createHostedAuthLink({
      userId: user.uid,
      ...this.#getConnectionUrls(),
    });
  }

  async createReconnectLink(user) {
    const accounts = await this.getAccounts(user.uid);
    if (accounts.length === 0) {
      throw connectionError("No mailbox is available to reconnect.", 409);
    }

    const account = accounts.find((item) => item.status !== "connected");
    if (!account) {
      throw connectionError("The mailbox connection is already active.", 409);
    }

    return {
      url: await unipileService.createHostedReconnectLink({
        accountId: account.accountId,
        userId: user.uid,
        ...this.#getConnectionUrls(),
      }),
      connection: toPublicConnection(account),
    };
  }

  async handleUnipileCallback(payload) {
    if (!payload || typeof payload !== "object") {
      const error = new Error("Invalid Unipile callback payload.");
      error.statusCode = 400;
      throw error;
    }

    const userId = typeof payload.name === "string" ? payload.name.trim() : "";
    const accountId = typeof payload.account_id === "string" ? payload.account_id.trim() : "";
    const status = typeof payload.status === "string" ? payload.status : "";

    if (!userId || !accountId || !["CREATION_SUCCESS", "RECONNECTED"].includes(status)) {
      const error = new Error("Incomplete Unipile callback payload.");
      error.statusCode = 400;
      error.errors = { fields: ["name", "account_id", "status"] };
      throw error;
    }

    await firebaseService.storeConnectedAccount(userId, {
      accountId,
      provider: payload.provider ?? null,
      status: "connected",
    });
  }

  async getAccounts(userId) {
    let [storedAccounts, unipileAccounts] = await Promise.all([
      firebaseService.getConnectedAccounts(userId),
      unipileService.getAccounts(),
    ]);

    // Hosted Auth stores the verified Firebase UID in Unipile's account name.
    // If the notify callback was temporarily unreachable, safely rebuild only
    // mappings whose provider-side name exactly matches the authenticated UID.
    const storedAccountIds = new Set(storedAccounts.map((account) => account.accountId));
    const recoverableAccounts = unipileAccounts.filter((account) => {
      return account.id
        && String(account.name ?? "").trim() === userId
        && !storedAccountIds.has(account.id);
    });

    if (recoverableAccounts.length > 0) {
      await Promise.all(
        recoverableAccounts.map((account) => firebaseService.storeConnectedAccount(userId, {
          accountId: account.id,
          provider: account.type ?? account.provider ?? null,
          status: normalizeAccountStatus(account),
        }))
      );
      storedAccounts = await firebaseService.getConnectedAccounts(userId);
    }

    const liveAccountsById = new Map(
      unipileAccounts
        .filter((account) => account.id)
        .map((account) => [account.id, account])
    );
    const staleAccounts = storedAccounts.filter(
      (account) => !liveAccountsById.has(account.accountId)
    );

    await Promise.all(
      staleAccounts.map((account) => {
        return firebaseService.deleteConnectedAccount(userId, account.accountId);
      })
    );

    return storedAccounts
      .filter((account) => liveAccountsById.has(account.accountId))
      .map((account) => {
        const liveAccount = liveAccountsById.get(account.accountId);
        return {
          ...account,
          mailbox: liveAccount.name ?? liveAccount.email ?? null,
          provider: account.provider ?? liveAccount.type ?? liveAccount.provider ?? null,
          status: normalizeAccountStatus(liveAccount),
        };
      });
  }

  async getConnectionStatus(userId) {
    const accounts = await this.getAccounts(userId);
    if (accounts.length === 0) {
      return {
        status: "not_connected",
        connections: [],
      };
    }

    const status = accounts.some((account) => account.status === "expired")
      ? "expired"
      : accounts.some((account) => account.status === "connecting")
        ? "connecting"
        : "connected";

    return {
      status,
      connections: accounts.map(toPublicConnection),
    };
  }

  async getPublicAccounts(userId) {
    const accounts = await this.getAccounts(userId);
    return accounts.map(toPublicConnection);
  }

  async disconnectAccounts(userId) {
    const accounts = await firebaseService.getConnectedAccounts(userId);
    if (accounts.length === 0) {
      return { status: "not_connected", disconnected: 0 };
    }

    for (const account of accounts) {
      try {
        await unipileService.deleteAccount(account.accountId);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
      await firebaseService.deleteConnectedAccount(userId, account.accountId);
    }

    return {
      status: "not_connected",
      disconnected: accounts.length,
    };
  }
}

export default new AccountService();
