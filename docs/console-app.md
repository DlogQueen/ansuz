# The Receptionist console app

An Android app that shows you what your receptionist did: today's numbers,
every call with its full transcript, the diary, and messages nobody has handled
yet.

**It does not answer calls.** It cannot — Twilio delivers a call by making an
HTTP request to a server, and a phone in your pocket has no address Twilio can
reach. The server answers; this app reads from it. If the server is not
deployed, the app has nothing to show and says so rather than sitting blank.

## What you need first

1. The server deployed somewhere with a public HTTPS address
   ([`docs/deploy.md`](deploy.md)).
2. `RECEPTIONIST_CONSOLE_TOKEN` set on that server to a long random string.
   Generate one with `openssl rand -base64 32`.
3. A business created (`npm run receptionist -- add …`), so there is something
   to look at.

If the token is not set, the console API is **disabled**, not open. That is
deliberate: it returns call transcripts and callers' phone numbers, so a deploy
that forgets the variable should serve nothing rather than everything.

## Installing it

The APK is not on the Play Store, so Android will ask you to allow installing
from your browser or files app the first time. That prompt is expected.

1. Copy `app-release.apk` to the phone.
2. Open it, allow the install when asked.
3. Open **Receptionist**, go to **Setup**, and enter:
   - **Server address** — `https://your-app.fly.dev`, no trailing slash
   - **Console token** — the same value as `RECEPTIONIST_CONSOLE_TOKEN`
   - **Business** — the slug, e.g. `smiles`
4. Tap **Save and test**. It lists the businesses on that server, so a typo in
   the slug is visible immediately rather than looking like "no data".

The app refuses a plain `http://` address for anything but localhost, because
the token would cross the network in the clear.

## What each tab shows

| Tab | |
|---|---|
| **Today** | Calls, booked, messages, escalated. Escalations go red when above zero — those are the ones a person needs to look at. |
| **Calls** | Unhandled messages first, then recent calls. Tap any call to read the transcript. |
| **Diary** | Upcoming appointments, grouped by day in the business's timezone. |
| **Setup** | Server, token, business. **Forget** wipes the token from the phone. |

## The API it reads

All read-only, all requiring `Authorization: Bearer <token>`:

| Route | |
|---|---|
| `GET /api/console/ping` | Confirms token and lists businesses |
| `GET /api/console/summary?business=<slug>` | Counts plus the next few appointments |
| `GET /api/console/calls?business=<slug>&limit=25` | Recent calls with transcripts |
| `GET /api/console/appointments?business=<slug>` | Upcoming appointments |
| `GET /api/console/messages?business=<slug>` | Unhandled messages |

There is no write endpoint. The app cannot cancel an appointment, edit hours or
change a business — deliberately, for now. A read-only surface that leaks is
embarrassing; a write surface that leaks lets someone empty your diary.

CORS is restricted to the app's own origins (`https://localhost`,
`capacitor://localhost`, and `http://localhost:<port>` for development) rather
than `*`.

## Rebuilding it

```sh
cd app
npm install
npx cap sync android
cd android && ./gradlew assembleRelease
```

Needs the Android SDK (platform 35, build-tools 35.0.0) and `local.properties`
pointing at it, plus `keystore.properties` and the keystore itself.

### About the keystore

`app/android/release.keystore` and `keystore.properties` are **not in git**, and
must not be. Android identifies an app by its signature: anyone holding the
keystore and its password can publish an update that phones will accept as a
genuine update to yours.

The other half of that matters too — **if you lose the keystore, you cannot ever
update this app again.** Not "it's difficult": installed copies will refuse an
APK signed by a different key, and the Play Store will refuse the upload. Back
it up somewhere you will still have in five years, alongside the password.

## Honest limits

- **Android only.** The same web layer would build for iOS, but that needs a Mac
  and an Apple developer account.
- **No push notifications.** An escalated call does not buzz your phone yet; you
  see it when you open the app. Push needs Firebase and a server-side sender.
- **Read-only**, as above.
- **Polling, not live.** It refreshes when you open a tab, pull the refresh
  button, or return to the app — not by itself while sitting open.
