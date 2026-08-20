-- Handoff tokens for the passkey fallback.
--
-- WebAuthn is unavailable in Telegram's in-app WebView on some platforms
-- (notably iOS WKWebView), so the ceremony has to move to the system
-- browser — which means leaving the context where Telegram's signed
-- initData exists. Something has to carry identity across that gap.
--
-- That something is a single-use, short-lived random token, never the
-- telegram_id. A URL is a weak place to carry identity: it lands in server
-- logs, browser history, Referer headers, and over shoulders. So what
-- travels there is worthless once spent (used_at) and worthless shortly
-- after issue (expires_at), which bounds the damage of a leak to a few
-- minutes and a single use.
create table if not exists public.wallet_handoff_tokens (
  token       text primary key,
  telegram_id text        not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.wallet_handoff_tokens enable row level security;
-- No anon policies: only API routes using the service role touch this.
-- A readable token table would hand out live credentials.

create index if not exists wallet_handoff_tokens_telegram_id
  on public.wallet_handoff_tokens (telegram_id);
