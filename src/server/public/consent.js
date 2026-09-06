const root = document.querySelector("#app");
const status = document.querySelector("#status");
const login = document.querySelector("#login");
const setup = document.querySelector("#setup");
const consent = document.querySelector("#consent");
const authorizationId = root.dataset.authorizationId;
const publicSignup = root.dataset.publicSignup === "true";
const client = globalThis.supabase.createClient(
  root.dataset.supabaseUrl,
  root.dataset.supabaseKey,
  {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

function showError(error) {
  status.textContent = error?.message ?? "Authorization failed";
  status.className = "error";
}

function messageForAccountError(code) {
  if (code === "username_taken") return "That username is already taken.";
  if (code === "registration_closed") {
    return "New Synapse registrations are currently closed.";
  }
  if (code === "account_disabled") return "This Synapse account is disabled.";
  if (code === "invalid_account") {
    return "Choose a valid lowercase username and project alias.";
  }
  return "Synapse could not set up your account. Try again.";
}

async function accountRequest(session, method = "GET", body) {
  const response = await fetch("/auth/account", {
    method,
    headers: {
      authorization: `Bearer ${session.access_token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(messageForAccountError(result.error));
    error.code = result.error;
    throw error;
  }
  return result;
}

async function showConsent() {
  const { data: details, error } =
    await client.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !details)
    throw error ?? new Error("Invalid authorization request");
  if (!("authorization_id" in details)) {
    location.assign(details.redirect_url);
    return;
  }

  const clientName =
    details.client?.name ?? details.client?.client_name ?? "This agent";
  document.querySelector("#client-name").textContent = clientName;
  document.querySelector("#scopes").textContent =
    details.scope?.split(/\s+/).filter(Boolean).join(", ") ||
    "openid, email, profile";
  document.querySelector("h1").textContent = "Authorize Synapse";
  status.textContent =
    "Review this request. Your agent receives the same user permissions as you.";
  consent.hidden = false;
}

async function start() {
  const { data: sessionData, error: sessionError } =
    await client.auth.getSession();
  if (sessionError) throw sessionError;

  if (root.dataset.mode === "activate") {
    if (!sessionData.session) {
      throw new Error("The invitation link is invalid or expired");
    }
    document.querySelector("h1").textContent = "Invitation accepted";
    status.textContent =
      "Your email is confirmed. Return to Codex and connect Synapse when ready.";
    return;
  }

  if (root.dataset.mode === "callback") {
    if (!sessionData.session) {
      throw new Error("The sign-in link is invalid or expired");
    }
    location.replace("/authorize");
    return;
  }

  if (!sessionData.session) {
    document.querySelector("h1").textContent = "Sign in to Synapse";
    status.textContent = publicSignup
      ? "Use your email to sign in or create a Synapse account."
      : "Sign in with the email address that received your Synapse invitation.";
    login.hidden = false;
    return;
  }

  const account = await accountRequest(sessionData.session);
  if (account.status === "setup_required") {
    if (!publicSignup) {
      throw new Error("This email does not have a Synapse invitation.");
    }
    document.querySelector("h1").textContent = "Create your Synapse identity";
    status.textContent =
      "Choose the identity and project this agent will use in Synapse.";
    setup.hidden = false;
    return;
  }
  await showConsent();
}

document
  .querySelector("#login-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const email = new FormData(event.currentTarget).get("email");
      const { error } = await client.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: publicSignup,
          emailRedirectTo: `${location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      login.hidden = true;
      status.textContent = "Check your email for a one-time sign-in link.";
    } catch (error) {
      showError(error);
    }
  });

document
  .querySelector("#setup-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    try {
      button.disabled = true;
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) {
        throw error ?? new Error("Your sign-in session expired.");
      }
      const values = new FormData(form);
      await accountRequest(data.session, "POST", {
        username: String(values.get("username") ?? "")
          .trim()
          .toLowerCase(),
        project_alias: String(values.get("project_alias") ?? "")
          .trim()
          .toLowerCase(),
      });
      setup.hidden = true;
      await showConsent();
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  });

async function decide(decision) {
  try {
    document.querySelector("#approve").disabled = true;
    document.querySelector("#deny").disabled = true;
    const operation =
      decision === "approve"
        ? client.auth.oauth.approveAuthorization(authorizationId)
        : client.auth.oauth.denyAuthorization(authorizationId);
    const { data, error } = await operation;
    if (error || !data?.redirect_url) {
      throw error ?? new Error("Authorization decision failed");
    }
    // Supabase created this URL after validating the original OAuth request.
    location.assign(data.redirect_url);
  } catch (error) {
    showError(error);
  }
}

document
  .querySelector("#approve")
  .addEventListener("click", () => decide("approve"));
document.querySelector("#deny").addEventListener("click", () => decide("deny"));
start().catch(showError);
