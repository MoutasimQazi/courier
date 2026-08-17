import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

const appView = document.querySelector("#app-view");
const signOutButton = document.querySelector("#sign-out-button");
const signedInEmail = document.querySelector("#signed-in-email");
const accountList = document.querySelector("#account-list");
const connectionMessage = document.querySelector("#connection-message");
const connectButton = document.querySelector("#connect-button");
const fetchButton = document.querySelector("#fetch-button");
const buttonLabel = document.querySelector(".button-label");
const copyButton = document.querySelector("#copy-button");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const errorState = document.querySelector("#error-state");
const jsonOutput = document.querySelector("#json-output");
const jsonCode = jsonOutput.querySelector("code");
const summary = document.querySelector("#summary");
const orderCount = document.querySelector("#order-count");
const subscriptionCount = document.querySelector("#subscription-count");
const forwardingAddress = document.querySelector("#forwarding-address");
const forwardingMessage = document.querySelector("#forwarding-message");
const forwardingEnableButton = document.querySelector("#forwarding-enable-button");
const forwardingVerificationButton = document.querySelector("#forwarding-verification-button");
const forwardingSyncButton = document.querySelector("#forwarding-sync-button");
const forwardingDeleteButton = document.querySelector("#forwarding-delete-button");
const forwardingVerificationResult = document.querySelector("#forwarding-verification-result");

let auth;
let currentUser = null;
let latestJson = "";
let connectedAccounts = [];
let forwardingMailbox = null;
let localDevelopment = false;
let developmentUserId = null;

const getDevelopmentUserId = () => {
  const storageKey = "inbox-signal-development-user";
  let value = window.localStorage.getItem(storageKey);
  if (!/^dev-[a-f\d-]{36}$/i.test(value || "")) {
    value = `dev-${window.crypto.randomUUID()}`;
    window.localStorage.setItem(storageKey, value);
  }
  return value;
};

const getIdToken = async () => {
  if (!currentUser) throw new Error("Preparing your private session. Please try again.");
  return currentUser.getIdToken();
};

const apiRequest = async (url, options = {}) => {
  const useDevelopmentIdentity = localDevelopment && url.startsWith("/api/forwarding");
  const performRequest = async (forceRefresh = false) => {
    if (!currentUser && !useDevelopmentIdentity) {
      throw new Error("Preparing your Firebase session. Please try again.");
    }
    const token = useDevelopmentIdentity ? null : await currentUser.getIdToken(forceRefresh);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options.timeout ?? 15000);
    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(useDevelopmentIdentity ? { "X-Development-User-Id": developmentUserId } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("The backend did not respond in time. A sync over a large mailbox can take a few minutes — check the server log for progress.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  };

  let response = await performRequest(false);
  if (response.status === 401) {
    response = await performRequest(true);
  }
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    throw new Error(payload.message || "The request failed.");
  }
  return payload;
};

const setLoading = (loading) => {
  fetchButton.disabled = loading || connectedAccounts.length === 0;
  connectButton.disabled = loading;
  buttonLabel.textContent = loading ? "Fetching…" : "Fetch intelligence";
  loadingState.hidden = !loading;
  if (loading) {
    emptyState.hidden = true;
    errorState.hidden = true;
    jsonOutput.hidden = true;
    summary.hidden = true;
    copyButton.disabled = true;
  }
};

const showError = (message) => {
  errorState.textContent = message;
  errorState.hidden = false;
  emptyState.hidden = true;
  jsonOutput.hidden = true;
  summary.hidden = true;
};

const renderAccounts = () => {
  accountList.replaceChildren();

  if (connectedAccounts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "account-empty";
    empty.textContent = "No mailbox connected yet.";
    accountList.append(empty);
    fetchButton.disabled = true;
    return;
  }

  for (const account of connectedAccounts) {
    const row = document.createElement("div");
    row.className = "account-row";

    const marker = document.createElement("span");
    marker.className = "account-marker";
    marker.textContent = "✓";

    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = account.provider || "Email mailbox";
    const subtitle = document.createElement("small");
    subtitle.textContent = account.status || "connected";
    details.append(title, subtitle);

    row.append(marker, details);
    accountList.append(row);
  }

  fetchButton.disabled = false;
};

const loadAccounts = async () => {
  const payload = await apiRequest("/api/accounts");
  connectedAccounts = Array.isArray(payload.data) ? payload.data : [];
  renderAccounts();
  return connectedAccounts;
};

const renderForwardingMailbox = () => {
  forwardingAddress.textContent = forwardingMailbox
    ? `${forwardingMailbox.email} — ${forwardingMailbox.status}`
    : "No forwarding address created yet.";
  forwardingEnableButton.disabled = Boolean(forwardingMailbox);
  forwardingVerificationButton.disabled = forwardingMailbox?.status !== "connected";
  forwardingSyncButton.disabled = forwardingMailbox?.status !== "connected";
  forwardingDeleteButton.disabled = !forwardingMailbox;
  if (forwardingMailbox?.gmailForwardingStatus === "verified") {
    forwardingMessage.textContent = "✓ Gmail forwarding verified. You can now enable forwarding in Gmail settings.";
    forwardingVerificationButton.textContent = "Gmail forwarding verified";
    forwardingVerificationButton.disabled = true;
  } else {
    forwardingVerificationButton.textContent = "Check Gmail verification";
  }
};

const loadForwardingStatus = async () => {
  const payload = await apiRequest("/api/forwarding/status");
  forwardingMailbox = payload.data || null;
  renderForwardingMailbox();
};

const showIntelligence = (payload) => {
  latestJson = JSON.stringify(payload, null, 2);
  jsonCode.textContent = latestJson;
  orderCount.textContent = Array.isArray(payload.orders) ? payload.orders.length : 0;
  subscriptionCount.textContent = Array.isArray(payload.subscriptions) ? payload.subscriptions.length : 0;
  summary.hidden = false;
  jsonOutput.hidden = false;
  errorState.hidden = true;
  emptyState.hidden = true;
  copyButton.disabled = false;
};

const handleConnectionReturn = async () => {
  const state = new URLSearchParams(window.location.search).get("connection");
  if (!state) return;

  window.history.replaceState({}, "", window.location.pathname);
  connectionMessage.textContent = state === "success"
    ? "Mailbox authenticated. Finishing the connection…"
    : "Mailbox connection was not completed.";

  if (state !== "success") return;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const accounts = await loadAccounts();
    if (accounts.length > 0) {
      connectionMessage.textContent = "Mailbox connected successfully.";
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }

  connectionMessage.textContent = "Authentication completed, but the callback is still pending. Refresh shortly.";
};

const initialize = async () => {
  try {
    const response = await fetch("/api/config", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    const config = payload?.data?.firebase;
    localDevelopment = payload?.data?.localDevelopment === true;
    developmentUserId = localDevelopment ? getDevelopmentUserId() : null;

    if (!response.ok || !config?.apiKey || !config?.authDomain || !config?.projectId || !config?.appId) {
      throw new Error("Firebase web configuration is incomplete.");
    }

    auth = getAuth(initializeApp(config));
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        appView.hidden = true;
        try {
          await signInAnonymously(auth);
        } catch (error) {
          if (localDevelopment) {
            currentUser = null;
            appView.hidden = false;
            signedInEmail.textContent = "Stable local forwarding test session ready";
            connectionMessage.textContent = "Firebase is unavailable. cPanel forwarding testing remains available.";
            connectedAccounts = [];
            renderAccounts();
            loadForwardingStatus().catch((requestError) => { forwardingMessage.textContent = requestError.message; });
          } else {
            appView.hidden = false;
            connectionMessage.textContent = error.message || "Unable to start a private session.";
          }
        }
        return;
      }

      currentUser = user;
      appView.hidden = false;
      signedInEmail.textContent = "Private session ready";
      connectionMessage.textContent = "";

      loadAccounts()
        .then(handleConnectionReturn)
        .catch((error) => { connectionMessage.textContent = error.message; });

      loadForwardingStatus()
        .catch((error) => {
          forwardingAddress.textContent = "Could not load forwarding status.";
          forwardingMessage.textContent = error.message;
          renderForwardingMailbox();
        });
    });
  } catch (error) {
    appView.hidden = false;
    connectionMessage.textContent = error.message;
  }
};

signOutButton.addEventListener("click", async () => {
  if (localDevelopment && !currentUser) {
    window.location.reload();
    return;
  }
  await signOut(auth);
  connectedAccounts = [];
  renderAccounts();
});

connectButton.addEventListener("click", async () => {
  connectionMessage.textContent = "";
  connectButton.disabled = true;
  try {
    const payload = await apiRequest("/api/accounts/connect", { method: "POST" });
    window.location.assign(payload.data.url);
  } catch (error) {
    connectionMessage.textContent = error.message;
    connectButton.disabled = false;
  }
});

fetchButton.addEventListener("click", async () => {
  setLoading(true);
  try {
    // A sync runs one model extraction per email, so it takes far longer than a
    // normal API call — the default 15s abort was cutting it off mid-run.
    const payload = await apiRequest("/api/emails/sync?limit=250", { method: "POST", timeout: 180000 });
    showIntelligence(payload);
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
});

forwardingEnableButton.addEventListener("click", async () => {
  forwardingMessage.textContent = "Creating a private mailbox in cPanel...";
  forwardingEnableButton.disabled = true;
  try {
    const payload = await apiRequest("/api/forwarding/enable", { method: "POST" });
    forwardingMailbox = payload.data;
    renderForwardingMailbox();
    forwardingMessage.textContent = "Created. Forward a test order email to this address.";
  } catch (error) {
    forwardingMessage.textContent = error.message;
    renderForwardingMailbox();
  }
});

forwardingSyncButton.addEventListener("click", async () => {
  forwardingMessage.textContent = "Reading unseen forwarded emails through IMAP...";
  forwardingSyncButton.disabled = true;
  try {
    // Same reason the mailbox sync needs it: one model call per message means a
    // real batch runs far longer than the 15s default, and aborting here does
    // not stop the server — it finishes and deletes the mail regardless.
    const payload = await apiRequest("/api/forwarding/sync", { method: "POST", timeout: 180000 });
    showIntelligence(payload);
    forwardingMessage.textContent = `Scanned ${payload.metadata?.scanned ?? 0}; `
      + `accepted ${payload.metadata?.accepted ?? 0}; removed ${payload.metadata?.deleted ?? 0}.`;
  } catch (error) {
    forwardingMessage.textContent = error.message;
  } finally {
    renderForwardingMailbox();
  }
});

forwardingVerificationButton.addEventListener("click", async () => {
  forwardingMessage.textContent = "Checking the generated mailbox for Gmail verification...";
  forwardingVerificationButton.disabled = true;
  forwardingVerificationResult.hidden = true;
  forwardingVerificationResult.replaceChildren();

  try {
    const payload = await apiRequest("/api/forwarding/verification", { timeout: 45000 });
    const verification = payload.data;
    if (verification.status !== "verification_received") {
      forwardingMessage.textContent = "Verification email has not arrived yet. Wait briefly and try again.";
      return;
    }

    forwardingMessage.textContent = "Gmail verification received.";
    const label = document.createElement("strong");
    label.textContent = "Confirmation available";
    forwardingVerificationResult.append(label);

    if (verification.confirmationCode) {
      const code = document.createElement("p");
      code.textContent = `Code: ${verification.confirmationCode}`;
      forwardingVerificationResult.append(code);
    }

    if (verification.confirmationUrl) {
      const link = document.createElement("a");
      link.href = verification.confirmationUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open official Google confirmation link";
      forwardingVerificationResult.append(link);

      const completeButton = document.createElement("button");
      completeButton.type = "button";
      completeButton.className = "verification-complete-button";
      completeButton.textContent = "I confirmed it on Google";
      completeButton.addEventListener("click", async () => {
        completeButton.disabled = true;
        try {
          const completed = await apiRequest("/api/forwarding/verification/complete", { method: "POST" });
          forwardingMailbox = completed.data;
          forwardingVerificationResult.hidden = true;
          renderForwardingMailbox();
        } catch (error) {
          forwardingMessage.textContent = error.message;
          completeButton.disabled = false;
        }
      });
      forwardingVerificationResult.append(completeButton);
    }
    forwardingVerificationResult.hidden = false;
  } catch (error) {
    forwardingMessage.textContent = error.message;
  } finally {
    renderForwardingMailbox();
  }
});

forwardingDeleteButton.addEventListener("click", async () => {
  if (!window.confirm("Remove this test mailbox from cPanel?")) return;
  forwardingMessage.textContent = "Removing mailbox...";
  forwardingDeleteButton.disabled = true;
  try {
    await apiRequest("/api/forwarding", { method: "DELETE" });
    forwardingMailbox = null;
    forwardingVerificationResult.hidden = true;
    forwardingVerificationResult.replaceChildren();
    renderForwardingMailbox();
    forwardingMessage.textContent = "Forwarding mailbox removed.";
  } catch (error) {
    forwardingMessage.textContent = error.message;
    renderForwardingMailbox();
  }
});

copyButton.addEventListener("click", async () => {
  if (!latestJson) return;
  await navigator.clipboard.writeText(latestJson);
  copyButton.textContent = "Copied";
  window.setTimeout(() => {
    copyButton.textContent = "Copy JSON";
  }, 1400);
});

initialize();
