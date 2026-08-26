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
  unless you've actually formed an entity under it; if it's an LLC, say so.
- `[BUSINESS ADDRESS]` — a real mailing address. Required by CAN-SPAM for
  email, and expected by carriers for SMS registration. A registered agent's
  address or a PO box is normal here; a home address is not required.
- `[CONTACT EMAIL]` — a monitored address. `privacy@` and `support@` are
  conventional and worth setting up.
- `[STATE]` / `[COUNTY]` — the governing jurisdiction for disputes.
- `[WEBSITE]` — where these will actually live.

## The order that matters

1. **Publish the privacy policy and SMS terms at real URLs first.** A2P
   registration asks for them and will not proceed without them.
2. **Register the A2P 10DLC campaign** with Twilio. Expect it to take days, not
   minutes, and expect the sample messages to need the opt-out line.
3. **Then** run a live campaign.

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

Copyright © 2026 Byte Me Studios (Ryleigh Maloy, Trey Maloy). All rights reserved.
