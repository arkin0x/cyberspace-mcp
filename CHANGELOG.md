# Changelog

Changes that matter to someone running cyberspace-mcp. Newest first.

## Unreleased

- **Your agent's profile follows its relays.** When none of the relays that accepted the agent's last profile are configured any more, `identity` publishes it again on the current relays instead of answering "unchanged". `serve` does the same once at startup, with no call needed: it publishes the same content and tags, signed again. An agent set up on the old default relays (`wss://cyberspace.nostr1.com`, `wss://onosendai.feeds.relay.tools`, the defaults before #95) moves its profile to `wss://relay.onosendai.tech` on its own, so ONOSENDAI's AGENTS panel finds it there.
  - **When the outbox still holds the profile event,** its replay at startup already sends that same event, unchanged, to the current relays. Nothing is signed again, and `profile.json` (and so `doctor`) lists the new relay.
  - **A refusal is not retried at startup.** If every current relay refused the profile, `profile.json` notes the refusal and keeps listing the relays that still hold it, so `doctor` and `visit` keep working. When the current relays could not be reached, the next start tries again. A profile no relay ever accepted is left alone.
  - **An `identity` call made while the startup republish runs** waits for it, so an edit made in that call is never undone.
  - **A profile that names an operator other than the configured one** is never republished.
