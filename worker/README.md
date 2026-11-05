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

```bash
npm ci
```

```bash
npm run build
```

```bash
npx wrangler deploy
```

## Known limits

- Thread nesting is inferred from mentions, because Micro.blog has no reply-to data.
- New posts, media uploads and follows aren't supported yet. Replies are.
- Everything published is public, because Micro.blog has no private posts. Private
  mentions, followers-only posts, content warnings, polls and scheduling are refused
  rather than sent without them.
- Direct messages don't appear, because Micro.blog's API has no route for them.
- Notifications are mentions only and always look unread.
- Bookmarks of fediverse or external-blog posts open without their thread.
- Profiles only page back about 400 posts, and deep pages load slowly.
- Signing out doesn't revoke the token. Do that in your Micro.blog account settings.
