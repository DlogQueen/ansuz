# Deploying BMDC

Two things get deployed, and they go to different kinds of host. Getting that
split wrong is the most common way this fails.

| What | Kind | Where |
|---|---|---|
| **The server** (`scripts/server.ts`) — webhooks, receptionist, scheduled jobs | Long-running process | Fly.io, Railway, Render, any VM |
| **The legal pages** at bytemedevstudio.com | Static files | Netlify, Vercel, Cloudflare Pages |
| **The database** | Managed | Supabase — already live |

## Why the server can't go on Vercel or Netlify

Both are excellent, and both are wrong for this process. It is not a set of
request handlers; it holds state between requests:

```
scripts/server.ts:270   new WebSocketServer({ server, path: '/api/perception' })
scripts/server.ts:297   setInterval(consolidateMemory, 15 min)
scripts/server.ts:321   setInterval(runCycle, BMDC_CYCLE_MINUTES)
```

Serverless platforms freeze or discard the process between invocations. The
webhook routes would work — they're ordinary POST handlers — but:

- the perception WebSocket can never stay open,
- memory consolidation never runs, so `long_term_memory` stays empty,
- the adapt cycle never fires, so the crew never does anything on its own.

None of that errors. It just silently doesn't happen, which is the same failure
shape as the two bugs in the book. **Use a container host.**

(You *could* refactor to serverless: webhooks as functions, the two intervals as
platform cron. That's a real architecture and a bigger change than it looks —
the cycle assumes it can run for minutes.)

## Deploying the server — Fly.io

`Dockerfile` and `fly.toml` are in the repo.

```sh
fly launch --no-deploy          # once; creates the app, keeps our fly.toml
```

Then the secrets. Every one of these is required for the crew or the
receptionist to work:

```sh
fly secrets set \
  SUPABASE_URL="https://pfxclpmrubuhsleiithq.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  LLM_PROVIDER="groq" \
  GROQ_API_KEY="..." \
  GROQ_MODEL="openai/gpt-oss-120b" \
  TWILIO_ACCOUNT_SID="AC..." \
  TWILIO_AUTH_TOKEN="..." \
  TWILIO_FROM_NUMBER="+1..." \
  STRIPE_SECRET_KEY="sk_test_..." \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  BMDC_PUBLIC_URL="https://bmdc.fly.dev"
```

```sh
fly deploy
fly logs                        # watch it boot
```

`BMDC_PUBLIC_URL` must be the exact URL Twilio will call. Twilio's signature is
computed over that string, so a mismatch — a trailing slash, `http` instead of
`https`, the wrong subdomain — rejects every inbound message and call.

### The one setting that matters

```toml
auto_stop_machines = false
min_machines_running = 1
```

Fly's default is to stop a machine when traffic goes quiet and restart it on the
next request. Excellent for a stateless app; wrong here. **A stopped machine
runs no `setInterval`.** Consolidation and the adapt cycle would simply never
fire, with nothing to indicate they hadn't.

Cost: one always-on `shared-cpu-1x` / 512MB machine, a few dollars a month.

### Railway, if you prefer a dashboard

Railway auto-detects the Dockerfile. Set the same variables in the Variables
tab. It doesn't idle-stop by default, so there's no equivalent trap — but check
that whatever plan you're on doesn't sleep the service.

## Deploying the legal pages

These are static and they need to be publicly reachable — A2P registration
follows the URLs. Netlify or Cloudflare Pages, both free.

The documents are Markdown in `docs/legal/`; render them however you like.
Whatever you use, the paths must match what the documents cross-reference:

```
bytemedevstudio.com/privacy
bytemedevstudio.com/sms-terms
bytemedevstudio.com/terms
bytemedevstudio.com/ai-disclosure
```

Fill in every `[BRACKET]` first — `grep -r '\[' docs/legal/`.

## Order of operations

1. **Deploy the server**, get its URL, set `BMDC_PUBLIC_URL` to it, redeploy.
2. **Point Twilio at it** — the number's messaging webhook at
   `{BMDC_PUBLIC_URL}/api/twilio/inbound`, its voice webhook at
   `{BMDC_PUBLIC_URL}/api/twilio/voice`.
3. **Add the Stripe endpoint** at `{BMDC_PUBLIC_URL}/api/stripe/webhook` for
   `checkout.session.completed`, and put the signing secret in secrets.
4. **Publish the legal pages.**
5. **Register A2P 10DLC.** Campaign review takes 10–15 days.
6. **Then** run a live campaign.

## Verifying the deploy

```sh
curl -X POST https://your-app.fly.dev/api/twilio/inbound -d "From=%2B1555&Body=hi"
```

**403 is the correct answer.** It means signature verification is live and
rejecting an unsigned request. A 200 would mean anyone can forge inbound
messages into your database.

If you get 403 but real Twilio traffic is also rejected, check the logs — the
server names the missing piece:

```
[bmdc] rejecting Twilio webhook — BMDC_PUBLIC_URL is not set, so the signed URL cannot be reconstructed
[bmdc] rejecting Twilio webhook — invalid X-Twilio-Signature on an inbound message
```

The second one with real traffic almost always means `BMDC_PUBLIC_URL` doesn't
exactly match what Twilio called.

Then:

```sh
fly ssh console -C "node dist/scripts/bmdc.js status"
```

which prints whether Twilio and Stripe are configured, whether webhooks can be
verified at all, and which model provider is live.

## Just testing first?

Skip all of it. Run locally and tunnel:

```sh
npm run server                                    # :8787
cloudflared tunnel --url http://localhost:8787    # prints an https URL
```

Set `BMDC_PUBLIC_URL` to that URL, point Twilio at it, and you have a working
end-to-end system in two minutes for free. The catch: the free tunnel URL
changes every restart, and both `BMDC_PUBLIC_URL` and the Twilio webhook config
have to be updated each time.

That's the right way to place the first real call and send the first real
message — the things that are still unverified.

## Things that will bite

**`BMDC_CYCLE_MINUTES` is off by default, deliberately.** Deploying does not
start the crew messaging people. Set it only when you want autonomous cycles,
and only after a `--dry-run` you've read.

**No deletion endpoint exists.** The privacy policy promises deletion on
request; today that's manual SQL. Fine at zero users.

**Secrets in `fly secrets` are not in `.env`.** The CLI commands
(`npm run bmdc`, `npm run receptionist`) read `.env` locally. Running them
against production means either `fly ssh console` or a local `.env` pointing at
the same Supabase project.

---

Copyright © 2026 Byte Me Studios (Ryleigh Maloy, Trey Maloy). All rights reserved.
