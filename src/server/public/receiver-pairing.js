const root = document.querySelector("#app");
const status = document.querySelector("#status");
const login = document.querySelector("#login");
const consent = document.querySelector("#consent");
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

function fail(error) {
  status.textContent = error?.message ?? "Receiver pairing failed";
  status.className = "error";
}

async function start() {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    login.hidden = false;
    status.textContent = "Sign in with your Synapse account.";
    return;
  }
  const response = await fetch("/auth/account", {
    headers: { authorization: `Bearer ${data.session.access_token}` },
  });
  const account = await response.json().catch(() => ({}));
  if (!response.ok || account.status !== "ready") {
    throw new Error("A configured, active Synapse account is required.");
  }
  document.querySelector("#identity").textContent =
    `@${account.username} / ${account.project_alias}`;
  consent.hidden = false;
  status.textContent = "Review what enabling this receiver allows.";
}

document
  .querySelector("#login-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const email = new FormData(event.currentTarget).get("email");
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: location.href },
      });
      if (error) throw error;
      login.hidden = true;
      status.textContent = "Check your email for a one-time sign-in link.";
    } catch (error) {
      fail(error);
    }
  });

document.querySelector("#approve").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw error ?? new Error("Sign-in expired");
    const response = await fetch(
      `/auth/receiver-pairings/${root.dataset.pairingId}/approve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${data.session.access_token}` },
      },
    );
    if (!response.ok) throw new Error("This pairing cannot be approved.");
    consent.hidden = true;
    document.querySelector("h1").textContent = "Receiver enabled";
    status.textContent = "Return to the terminal to finish connecting.";
  } catch (error) {
    fail(error);
    button.disabled = false;
  }
});

start().catch(fail);
