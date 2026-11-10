The dev signing key is **not stored in this repo**. It pins the unpacked extension ID via `manifest.json`'s
`"key"` field (public half only) so `chrome://extensions` assigns the same ID on every load.

Current ID: `cpngahcnffppbhanlckaljfodmnnlgln`. `rules.json` and `native-host/register*.sh` hardcode it — if you regenerate the key,
recompute the ID (sha256 of the DER public key, first 32 hex chars, mapped 0-9a-f -> a-p) and update them.

Keep the private key outside the repo (e.g. `~/.config/academicreader/dev_key.pem`). The previous key was
accidentally committed and has been retired (old ID `dplbidighoojohkjjcegfdfinffmdmdj`).
