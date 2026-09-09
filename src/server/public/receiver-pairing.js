import { installEmailSubmission } from "./email-submission.js";

const root = document.querySelector("#app");
const status = document.querySelector("#status");
const login = document.querySelector("#login");
const consent = document.querySelector("#consent");
const client = globalThis.supabase.createClient(
  root.dataset.supabaseUrl,
  root.dataset.supabaseKey,
  {
    auth: {
      flowType: "implicit",
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

installEmailSubmission({
  form: document.querySelector("#login-form"),
  panel: login,
  status,
  showError: fail,
  async submit(email) {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo:
          `${location.origin}/auth/activate?receiver_pairing=` +
          encodeURIComponent(root.dataset.pairingId),
      },
    });
    if (error) throw error;
    return { cooldownSeconds: 60 };
  },
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
    if (!response.ok)
      throw new Error(
        "This pairing cannot be approved. Check that this browser uses the same Synapse account as Codex.",
      );
    consent.hidden = true;
    document.querySelector("h1").textContent = "Receiver enabled";
    status.textContent =
      "Return to Codex. Synapse will finish connecting automatically.";
  } catch (error) {
    fail(error);
    button.disabled = false;
  }
});

start().catch(fail);
