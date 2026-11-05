# Micro.blog proxy

This unofficial fork runs [Phanpy](https://github.com/cheeaun/phanpy) as a
Micro.blog client. Report problems here, not to Phanpy's maintainer.

Micro.blog doesn't offer the Mastodon client API that Phanpy is built on, so this
Cloudflare Worker presents that API and calls Micro.blog's own API behind it. The
same Worker serves the app, so both share one hostname.

Every user's Micro.blog token passes through the Worker. It keeps no state between
requests and must never log tokens, sign-in codes or query strings.

## Tests

```bash
npm run test:worker
```

These need no dependencies and don't touch the network.

## Deploy your own

Replace `HOST` with your Worker's hostname, such as
`phanpy.yourname.workers.dev`. The hostname is built into the app, so build again
if it changes.

```bash
npm ci
```

```bash
PHANPY_WEBSITE=https://HOST PHANPY_DEFAULT_INSTANCE=HOST PHANPY_CLIENT_NAME="Phanpy for Micro.blog" npm run build
```

```bash
npx wrangler deploy
```

## Known limits

- Thread nesting is inferred from mentions, because Micro.blog has no reply-to data.
- New posts, media uploads and follows aren't supported yet. Replies are.
- Notifications are mentions only and always look unread.
- Bookmarks of fediverse or external-blog posts open without their thread.
- Profiles only page back about 400 posts, and deep pages load slowly.
- Signing out doesn't revoke the token. Do that in your Micro.blog account settings.
