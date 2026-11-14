# auto-assign-reviewer

Cloudflare Worker that requests a review from `REVIEWER` on newly opened pull requests in repositories matching `ALLOWED_REPOS` (configured in `wrangler.jsonc`), acting as the GitHub App [assignicorn](https://github.com/apps/assignicorn).

Webhook URL: `https://auto-assign-reviewer.dsh.workers.dev`

## GitHub App settings

- Webhook URL: the URL above, with the secret from `fnox -P cloud get GITHUB_WEBHOOK_SECRET`
- Permissions: Pull requests (read and write)
- Events: Pull request

Pull requests opened by `dependabot[bot]` are skipped, as are those opened by `REVIEWER`, since GitHub rejects review requests for the author.

## Development

```sh
bun install
mise run test
mise run typecheck
mise run deploy
mise run secrets:push   # uploads GITHUB_WEBHOOK_SECRET and GITHUB_APP_PRIVATE_KEY from fnox.cloud.toml
```

`GITHUB_APP_PRIVATE_KEY` must be PKCS#8. Convert the key GitHub downloads with `openssl pkcs8 -topk8 -nocrypt -in app.pem`.
