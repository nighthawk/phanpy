# Micro.blog proxy

This unofficial fork of [Phanpy](https://github.com/cheeaun/phanpy) adds Micro.blog
accounts. Mastodon accounts work as usual and can be used alongside them. Report
problems here, not to Phanpy's maintainer.

Micro.blog doesn't offer the Mastodon client API that Phanpy is built on, so this
Cloudflare Worker presents that API and calls Micro.blog's own API behind it. The
same Worker serves the app, so both share one hostname.

Every user's Micro.blog token passes through the Worker, which must never log
tokens, sign-in codes or query strings. The only thing it stores is each user's read
positions, in Cloudflare KV under their username, so notifications can show what's new. Mastodon accounts
talk to their own servers directly, so their tokens never reach it.

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

Set `MICROBLOG_ALLOWED_USERS` in `wrangler.jsonc` to the Micro.blog usernames that may
sign in, separated by commas, or leave it empty to allow anyone. It doesn't affect
Mastodon accounts.

## Known limits

- Thread nesting is inferred from mentions, because Micro.blog has no reply-to data.
- Everything published is public, because Micro.blog has no private posts. Private
  mentions, followers-only posts, content warnings, polls and scheduling are refused
  rather than sent without them.
- Replies can't include images, and uploads are limited to JPEG, PNG and GIF.
- New posts go to the account's default blog, with no way to choose another.
- Posts can't be edited.
- Direct messages don't appear, because Micro.blog's API has no route for them.
- Notifications are mentions only.
- Search finds people and posts, but not hashtags, and can't look up a post by URL.
- Bookmarks of fediverse or external-blog posts open without their thread.
- Profiles only page back about 400 posts, and deep pages load slowly.
- Signing out doesn't revoke the token. Do that in your Micro.blog account settings.
- The allowlist is only checked at sign-in, and someone it refuses sees no message.
  Their new token also stays valid until they revoke it in those settings.
