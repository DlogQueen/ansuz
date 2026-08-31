# Legal — Byte Me Studios

The public-facing policies BMDC and the Receptionist require in order to
operate legally, plus notes on why each one exists.

**These are drafts written against what this system actually does.** They are
not generic boilerplate — the data inventory in the privacy policy is the real
inventory, and the sharing disclosures name the real processors. That makes
them a much better starting point than a template, and it does not make them
reviewed by a lawyer. Have an attorney read them before you publish, especially
the arbitration and liability sections in the Terms.

## The documents

| File | Why it exists |
|---|---|
| `privacy-policy.md` | Legally required in most jurisdictions once you hold personal data. Also required by Twilio, Stripe, and A2P 10DLC registration. |
| `sms-terms.md` | **Required for Twilio A2P 10DLC approval.** Carriers reject campaigns without a public opt-in policy. |
| `terms-of-service.md` | Governs the paid products. Sets payment, refund, and liability terms. |
| `ai-disclosure.md` | AI identification, call transcripts, and automated decision-making. Increasingly required; already required by our own charter. |

## Fill these in before publishing

Every document contains bracketed placeholders. Search for `[` across the
folder — nothing should ship with a bracket left in it.

- `[LEGAL ENTITY]` — the registered name. "Byte Me Studios" is a trade name
  unless an entity has actually been formed under it. With an LLC, use its exact
  registered name. Without one, the business is legally its owner, so the line
  reads "<legal name>, doing business as Byte Me Studios" — and it has to be the
  name on the owner's ID and tax records, because A2P registration checks it
  against them and a mismatch is the most common rejection. This is the only
  place a personal name appears; the copyright notice, the site footer, and the
  book byline all read "Byte Me Studios" alone.
- `[BUSINESS ADDRESS]` — a real mailing address. Required by CAN-SPAM for
  email, and expected by carriers for SMS registration. A registered agent's
  address or a PO box is normal here; a home address is not required.
- `[CONTACT EMAIL]` — a monitored address. `privacy@` and `support@` are
  conventional and worth setting up.
- `[STATE]` / `[COUNTY]` — the governing jurisdiction for disputes.
- `[SUPPORT PHONE]` — a number in the SMS terms that reaches a human.
- `[N]` — message frequency cap, and the refund window in the Terms.

The website is set: **bytemedevstudio.com**. The canonical URLs the documents
already cross-reference are:

| Document | URL |
|---|---|
| Privacy Policy | `https://bytemedevstudio.com/privacy` |
| SMS Terms | `https://bytemedevstudio.com/sms-terms` |
| Terms of Service | `https://bytemedevstudio.com/terms` |
| AI Disclosure | `https://bytemedevstudio.com/ai-disclosure` |

These paths are referenced from inside the documents, so if you publish at
different paths, update the cross-references too.

Suggested addresses at the domain: `privacy@bytemedevstudio.com` and
`support@bytemedevstudio.com`.

## Publishing them

The pages on the site are **generated from these files**:

```sh
npm run build:site
```

That renders `privacy-policy.md`, `sms-terms.md`, `terms-of-service.md` and
`ai-disclosure.md` into `site/privacy.html`, `site/sms-terms.html`,
`site/terms.html` and `site/ai-disclosure.html`, wrapped in the site template
and reachable at the canonical URLs above.

Edit the markdown, never the HTML — the HTML is overwritten on every build.
Any placeholder left unfilled renders in red on the live page, and the build
prints a list of what is still outstanding.

## The order that matters

1. **Publish the privacy policy and SMS terms at real URLs first.** A2P
   registration asks for them and will not proceed without them.
2. **Register the A2P 10DLC campaign** with Twilio, at
   [console.twilio.com](https://console.twilio.com) → Messaging → Regulatory
   Compliance. Brand approval is usually minutes; **campaign review takes 10-15
   days.** Sample messages must include the opt-out line or the campaign is
   rejected. If there's no EIN yet, the Sole Proprietor path skips the tax ID
   at the cost of much lower throughput.
3. **Then** run a live campaign.

The two-week campaign review is the real constraint. Start it before you need
it.

Doing this in the other order means building the whole funnel and then
discovering the number can't send.

## What the privacy policy commits you to

Read it before publishing, because it contains promises the code has to keep:

- **Opt-outs are permanent.** That's already true in code
  (`setLeadConsent` refuses to reverse an opt-out), and the policy states it.
- **Message content goes to an AI provider.** This is disclosed explicitly.
  Most privacy policies in this space quietly omit it; omitting it is the kind
  of thing that becomes a problem later.
- **Deletion on request.** There is currently no implemented deletion path.
  If someone emails asking to be deleted, that is manual SQL today. Build the
  endpoint before volume makes that unworkable.

---

Copyright © 2026 Byte Me Studios. All rights reserved.
