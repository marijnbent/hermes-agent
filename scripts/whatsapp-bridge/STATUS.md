# WhatsApp Status publishing

Status publishing is disabled by default and is intended only for Molletje's bot bridge on port 3001. The personal archive bridge on port 3000 remains disabled. No service unit, live config, restart, or publication was performed.

Enable it in the profile-scoped config (not `.env`):

```bash
hermes config set platforms.whatsapp.extra.status_publishing_enabled true
```

Request JSON uses `text`, explicit contact-only `audience` (`number@s.whatsapp.net`), `idempotencyKey`, and optional `style` (`backgroundColor` `#RRGGBB`, `font` 0–5). Text is bounded to 4096 characters and sent unchanged.

Each idempotency key is durably bound to its exact payload under the bridge session's sibling `status/journal.jsonl`. Pending, timeout, disconnect, and missing-provider-id outcomes are uncertain and are never resent with the same key. Reusing a key with a different payload returns 409. Use a new key only when an intentional duplicate/override is acceptable. A successful response means provider acknowledgement, not viewer visibility; GET `/status/:key` provides exact journal readback.

Terminal client:

```bash
node whatsapp-status.mjs --bridge http://127.0.0.1:3001 \
  --audience 31612345678@s.whatsapp.net --text 'hello' --key run-2026-10-06-01
```

The client validates locally and accepts only `http://127.0.0.1:3001`, Molletje's bot bridge. The journal retains up to 1024 keys without eviction; at capacity, new publications fail closed with 507 until explicit maintenance. Never clear keys for a Status that could still be retried.

After enabling the configuration, an external-shell gateway reload is required. Do not restart the owning gateway from its own assistant turn. Verify `/health` reports `statusPublishingEnabled: true` on port 3001 and disabled/absent on personal port 3000 before publishing. A limited-audience live test and phone visibility check are separate acceptance steps.
