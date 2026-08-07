Dev-only signing key, pinned via `manifest.json`'s `"key"` field so `chrome://extensions` assigns the
same extension ID (`dplbidighoojohkjjcegfdfinffmdmdj`) every time this is loaded unpacked. `rules.json`'s
static DNR redirect rules hardcode that ID as their `regexSubstitution` target, so the two must stay in
sync — if you ever regenerate `dev_key.pem`, recompute the ID and update `rules.json` to match.

This key is never used to publish to the Chrome Web Store (a real publish uses a Web Store-managed key)
— it exists purely so local unpacked loads are reproducible across machines/rebuilds.
