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

// Email a password-reset link (and code) to a registered reader. Supabase
// sends it; the link lands on reset-password.html, which must be listed under
// Authentication → URL Configuration → Redirect URLs in Supabase.
async function akSendPasswordReset(email) {
  return sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password.html`,
  });
}

// A small fixed "Signed in as <name>" tag in the top-right corner, sitting just
// below the page's sticky header, so readers always know they're logged in.
async function akShowSignedInBadge(headerSelector) {
  const session = await akGetSession();
  if (!session) return;
  const user = session.user;
  const name = user.user_metadata?.name || user.email;

  const style = document.createElement('style');
  style.textContent = `
    .ak-signed-in{
      position:fixed; right:16px; z-index:19; display:flex; align-items:center; gap:8px;
      max-width:calc(100vw - 32px); padding:7px 12px; text-decoration:none;
      background:rgba(10,11,13,.92); border:1px solid rgba(79,163,155,.5); border-radius:2px;
      font:11px 'IBM Plex Mono', monospace; letter-spacing:.06em; color:#A6A296;
    }
    .ak-signed-in b{font-weight:500; color:#E8E3D8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
    .ak-signed-in:before{content:""; flex:none; width:7px; height:7px; border-radius:50%; background:#4FA39B;}
    .ak-signed-in:hover{border-color:#4FA39B;}`;
  document.head.appendChild(style);

  const badge = document.createElement('a');
  badge.className = 'ak-signed-in';
  badge.href = 'my-library.html';
  badge.title = user.email;
  badge.append('Signed in as ');
  const b = document.createElement('b');
  b.textContent = name;
  badge.appendChild(b);
  document.body.appendChild(badge);

  const header = document.querySelector(headerSelector);
  const place = () => { badge.style.top = `${Math.max(header ? header.getBoundingClientRect().bottom : 0, 0) + 10}px`; };
  place();
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, { passive: true });
}
