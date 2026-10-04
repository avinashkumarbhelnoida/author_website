# Avinash Kumar — Author Website

Personal author site with a paid "Digital Edition" store and a private
reader library. Hosted on Netlify, backed by Supabase and Razorpay.

## Structure
- `*.html` at the repo root are the pages, served as-is (no build step,
  no framework). Each page has its own inline `<style>` / `<script>`.
  - `index.html` — home page (books, about, etc.)
  - `invisible-threads.html` — book page with "Buy Digital Edition" (Razorpay Checkout)
  - `my-library.html` — the logged-in reader's purchased books
  - `reader.html` — opens a purchased book via a short-lived signed URL
  - `admin.html` — admin tools
  - `author-story.html`, `why-books.html` — content pages
  - `journal-<door>.html` — the six Journal "doors" (consciousness, dreams-intuition, perception-reality,
    memory-emotion, coincidence, human-behaviour), linked from the home page's Journal section
  - `404.html` — not-found page (Netlify serves it automatically; use root-relative links)
  - `checkout.html` — cart checkout: sign in, then one Razorpay payment for every book in the cart
- `auth.js` — shared Supabase client + helpers (`akGetSession`, `akSignIn`,
  `akSignUp`, `akSignOut`, `akCallFunction`). Load it after the Supabase CDN script.
- `netlify/functions/` — serverless functions (Node, CommonJS):
  - `create-order.js` — validates the user, reads real prices from the DB, refuses books already owned,
    creates ONE Razorpay order for one or more books (`bookSlugs`), one `purchases` row per book
  - `verify-payment.js` — verifies the Razorpay signature, marks the order's purchases paid, grants library access
  - `razorpay-webhook.js` — Razorpay's server-to-server `payment.captured` / `order.paid` events; same
    fulfilment as verify-payment, for buyers who close the tab. Checks `X-Razorpay-Signature` and the amount.
  - `get-read-url.js` — checks entitlement, returns a 120-second Supabase Storage signed URL
- `netlify/lib/fulfill.js` — shared "mark paid + add to library" logic (outside `functions/` so it isn't deployed as one)
- `schema.sql` (v1), `supabase/schema-v2.sql` (v2, current Digital Edition +
  library system) and `supabase/schema-v3-security.sql` (admin-only access via
  `is_admin()` = `profiles.role = 'admin'`; readers can't change their own role).
  Run them manually in the Supabase SQL Editor.
- Cart: `localStorage['akCart']` = `[{slug, title, priceInr, priceUsd}]`, display only —
  prices are always re-read from `books_catalog` by `create-order`.
- `images/logo/` — AK monogram: nav mark (`logo-128.png`) and favicons linked from every page.
- `images/` — `author/` and `books/` covers, each in `.avif`, `.webp` and `.jpg`.
  Back covers (`<book>-back-<width>.*`) are cropped from the wraparound `<book>-700.jpg`; the hero shows
  front + back of the book matching each tagline (`heroBooks` / `book:` in `index.html`).
- `netlify.toml` — publish dir is `.`, functions dir is `netlify/functions`;
  `/digital-books/*` is blocked.

## Security rules (must follow)
- `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` may only be read inside
  `netlify/functions/*.js` via `process.env`. Never put them in any HTML or
  browser JS, and never hard-code them anywhere.
- The Supabase URL + anon/publishable key in `auth.js` and `RAZORPAY_KEY_ID` are
  public and OK to ship to the browser.
- Never commit a real `.env` file; `.env.example` holds placeholders only.
- Functions must never trust the client: always validate the Bearer token,
  look up prices from the DB, and verify payment signatures server-side.
- Book files live in a private Supabase bucket. Never add public links to them.

## Conventions
- Images: name as `<book-slug>-<width>.{avif,webp,jpg}` and use a `<picture>`
  with avif + webp sources and a jpg `<img>` fallback, with `width`, `height`,
  `alt`, and `loading="lazy"` (use `eager` only for above-the-fold images).
- Keep page titles in the form `<Page> — Avinash Kumar`, and include the favicon `<link>`s from `index.html`.
- Admin rights come from `profiles.role = 'admin'`, never from just being signed in.
- Keep pages mobile-friendly; check layouts at phone width.
- Match the existing plain HTML/CSS/vanilla JS style. Don't add frameworks or a
  build step unless asked.

## Running locally
- Static pages: open the HTML files or run any static server.
- With functions: `npm install` then `npx netlify-cli dev`
  (needs the env vars from `.env.example` set in Netlify or a local `.env`).

## Deploying
Netlify deploys automatically from GitHub. Work on a branch, open a PR
(Netlify builds a deploy preview), then merge to go live.
