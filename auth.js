// auth.js — shared Supabase client + auth helpers for the site.
// Include after the Supabase CDN script:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="auth.js"></script>

// ---- Fill these in with your real project values (safe to expose — these
// are the PUBLIC url + anon key, not the service_role secret) ----
const SUPABASE_URL = "https://dmomlxlmfqlnyakqvyav.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HUv9Ba6XnziMxIdFRT6xFA_jpsimFXv";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function akGetSession() {
  const { data: { session } } = await sb.auth.getSession();
  return session;
}

async function akSignUp(name, email, password) {
  return sb.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
}

async function akSignIn(email, password) {
  return sb.auth.signInWithPassword({ email, password });
}

async function akSignOut() {
  await sb.auth.signOut();
  window.location.href = 'index.html';
}

// Call a Netlify function with the user's current access token attached.
async function akCallFunction(name, payload) {
  const session = await akGetSession();
  if (!session) throw new Error('NOT_LOGGED_IN');
  const res = await fetch(`/.netlify/functions/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
