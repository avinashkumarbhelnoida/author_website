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
- `auth.js` — shared Supabase client + helpers (`akGetSession`, `akSignIn`,
  `akSignUp`, `akSignOut`, `akCallFunction`). Load it after the Supabase CDN script.
- `netlify/functions/` — serverless functions (Node, CommonJS):
  - `create-order.js` — validates the user, reads the real price from the DB, creates a Razorpay order
  - `verify-payment.js` — verifies the Razorpay signature, marks the purchase paid, grants library access
  - `get-read-url.js` — checks entitlement, returns a 120-second Supabase Storage signed URL
- `schema.sql` (v1) and `supabase/schema-v2.sql` (v2, current Digital Edition +
  library system). Run them manually in the Supabase SQL Editor.
- `images/` — `author/` and `books/` covers, each in `.avif`, `.webp` and `.jpg`.
- `netlify.toml` — publish dir is `.`, functions dir is `netlify/functions`;
  `/digital-books/*` is blocked.

## Security rules (must follow)
- `SUPABASE_SERVICE_ROLE_KEY` and `RAZORPAY_KEY_SECRET` may only be read inside
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
- Keep page titles in the form `<Page> — Avinash Kumar`.
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
