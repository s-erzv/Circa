# Circa — web

Next.js app + Telegram bot for Circa's arisan Mini App.

## Development

```bash
pnpm install
pnpm dev        # Next.js app (Mini App + API routes)
pnpm run bot    # Telegram bot, long-polling
```

The Mini App needs an HTTPS tunnel (e.g. `ngrok http 3000`) pointed at the
dev server — Telegram Mini Apps require HTTPS, and the bot's `web_app`
buttons will not load `localhost`. Set `NEXT_PUBLIC_APP_URL` in `.env` to
the tunnel URL and restart `pnpm dev` after changing it.

## Migrations

SQL files under `migrations/` are applied manually via the Supabase SQL
Editor, in numeric order. They are idempotent (`if not exists` /
`add column if not exists` throughout) so re-running an already-applied
migration is a no-op.

## Tests

```bash
pnpm test
```
