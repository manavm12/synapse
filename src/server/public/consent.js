const root = document.querySelector("#app");
const status = document.querySelector("#status");
const login = document.querySelector("#login");
const consent = document.querySelector("#consent");
const authorizationId = root.dataset.authorizationId;
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
    status.textContent =
      "Sign in with the email address that received your Synapse invitation.";
    login.hidden = false;
    return;
  }

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
  status.textContent =
    "Review this request. Your agent receives the same user permissions as you.";
  consent.hidden = false;
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
          shouldCreateUser: false,
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
