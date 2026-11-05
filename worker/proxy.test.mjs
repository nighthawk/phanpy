import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleProxy } from './proxy.mjs';

const ORIGIN = 'https://phanpy.example.workers.dev';

const post = (id, username, html = '<p>Hi</p>', extra = {}) => ({
  id: String(id),
  content_html: html,
  url: `https://micro.blog/${username}/${id}`,
  date_published: `2026-11-05T00:00:${String(id).padStart(2, '0')}+00:00`,
  author: {
    name: username,
    url: `https://${username}.example`,
    avatar: `https://cdn.example/${username}.jpg`,
    _microblog: { username },
  },
  _microblog: { ...extra },
});

// Answers `METHOD /path` from a table, so tests state exactly what upstream returns.
function stubUpstream(routes = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, url, init });
    const route = routes[key];
    if (!route) return new Response('Not found', { status: 404 });
    const result = typeof route === 'function' ? route(url, init) : route;
    return result instanceof Response ? result : Response.json(result);
  };
  return { fetch, calls };
}

const request = (path, { token, ...init } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

test('leaves app paths for the static assets', async () => {
  const { fetch } = stubUpstream();
  assert.equal(await handleProxy(request('/'), { fetch }), null);
  assert.equal(
    await handleProxy(request('/assets/main.js'), { fetch }),
    null,
  );
  assert.equal(
    await handleProxy(request('/.well-known/host-meta'), { fetch }),
    null,
  );
});

test('instance metadata names the host it was requested on', async () => {
  const { fetch } = stubUpstream();
  const res = await handleProxy(request('/api/v2/instance'), { fetch });
  const body = await res.json();
  assert.equal(body.domain, 'phanpy.example.workers.dev');
  assert.equal(body.uri, 'phanpy.example.workers.dev');
});

test('nodeinfo identifies the server as Micro.blog on this host', async () => {
  const { fetch } = stubUpstream();
  const discovery = await handleProxy(request('/.well-known/nodeinfo'), {
    fetch,
  });
  const { links } = await discovery.json();
  assert.equal(links[0].href, `${ORIGIN}/nodeinfo/2.0`);

  const info = await handleProxy(request('/nodeinfo/2.0'), { fetch });
  assert.equal((await info.json()).software.name, 'microdotblog');
});

test('app registration uses this host as the IndieAuth client', async () => {
  const { fetch } = stubUpstream();
  const res = await handleProxy(
    request('/api/v1/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'client_name=Phanpy&redirect_uris=https%3A%2F%2Fapp.example%2F',
    }),
    { fetch },
  );
  const body = await res.json();
  assert.equal(body.client_id, `${ORIGIN}/`);
  assert.equal(body.redirect_uri, 'https://app.example/');
  assert.ok(body.client_secret, 'Phanpy re-registers without a secret');
});

test('authorize redirects to IndieAuth with PKCE and supported scopes', async () => {
  const { fetch } = stubUpstream();
  const query = new URLSearchParams({
    client_id: `${ORIGIN}/`,
    redirect_uri: `${ORIGIN}/`,
    scope: 'read write follow push',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
  });
  const res = await handleProxy(request(`/oauth/authorize?${query}`), {
    fetch,
  });
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('Location'));
  assert.equal(target.origin + target.pathname, 'https://micro.blog/indieauth/auth');
  assert.equal(target.searchParams.get('client_id'), `${ORIGIN}/`);
  assert.equal(target.searchParams.get('code_challenge'), 'abc');
  assert.equal(target.searchParams.get('scope'), 'read write follow');
  assert.ok(target.searchParams.get('state'), 'IndieAuth requires state');
});

test('token exchange forwards the code and returns a Mastodon token', async () => {
  const { fetch, calls } = stubUpstream({
    'POST /indieauth/token': { access_token: 'minted', me: 'https://x/' },
  });
  const res = await handleProxy(
    request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `code=c1&client_id=${encodeURIComponent(ORIGIN)}&redirect_uri=${encodeURIComponent(ORIGIN)}&code_verifier=v1&client_secret=unused`,
    }),
    { fetch },
  );
  const body = await res.json();
  assert.equal(body.access_token, 'minted');
  assert.equal(body.token_type, 'Bearer');
  const sent = new URLSearchParams(calls[0].init.body);
  assert.equal(sent.get('code'), 'c1');
  assert.equal(sent.get('code_verifier'), 'v1');
  assert.equal(sent.get('client_secret'), null);
});

test('token exchange passes upstream rejection through', async () => {
  const { fetch } = stubUpstream({
    'POST /indieauth/token': () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
  });
  const res = await handleProxy(
    request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=bad',
    }),
    { fetch },
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_grant');
});

test('home timeline maps paging and adds a next link', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/timeline': { items: [post(9, 'ann'), post(5, 'bob')] },
  });
  const res = await handleProxy(
    request('/api/v1/timelines/home?limit=2&max_id=10', { token: 'tok' }),
    { fetch },
  );
  const body = await res.json();
  assert.deepEqual(body.map((s) => s.account.acct), ['ann', 'bob']);
  assert.equal(calls[0].url.searchParams.get('count'), '2');
  assert.equal(calls[0].url.searchParams.get('before_id'), '10');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.match(res.headers.get('Link'), /max_id=5>; rel="next"$/);
});

test('an upstream 401 reaches Phanpy as a 401', async () => {
  const { fetch } = stubUpstream({
    'GET /posts/timeline': () => new Response('No', { status: 401 }),
  });
  const res = await handleProxy(
    request('/api/v1/timelines/home', { token: 'expired' }),
    { fetch },
  );
  assert.equal(res.status, 401);
});

test('a status and its context come from the conversation', async () => {
  const items = [post(2, 'bob', '<p><a href="x">@ann</a> yes</p>'), post(1, 'ann')];
  const { fetch } = stubUpstream({
    'GET /posts/conversation': { items },
  });
  const status = await handleProxy(request('/api/v1/statuses/2'), { fetch });
  assert.equal((await status.json()).in_reply_to_id, '1');
  const context = await handleProxy(request('/api/v1/statuses/2/context'), {
    fetch,
  });
  assert.deepEqual((await context.json()).ancestors.map((s) => s.id), ['1']);
});

test('notifications present mentions and honour type filters', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/mentions': { items: [post(3, 'bob')] },
  });
  const res = await handleProxy(
    request('/api/v1/notifications', { token: 'tok' }),
    { fetch },
  );
  assert.equal((await res.json())[0].type, 'mention');

  const filtered = await handleProxy(
    request('/api/v1/notifications?types[]=follow', { token: 'tok' }),
    { fetch },
  );
  assert.deepEqual(await filtered.json(), []);
  assert.equal(calls.length, 1);
});

test('replying returns the created post found in the conversation', async () => {
  const before = [post(1, 'ann')];
  const after = [post(2, 'me', '<p>Hi</p>', { is_deletable: true }), post(1, 'ann')];
  let replied = false;
  const { fetch, calls } = stubUpstream({
    'GET /posts/conversation': () => ({ items: replied ? after : before }),
    'POST /posts/reply': () => {
      replied = true;
      return new Response('');
    },
  });
  const res = await handleProxy(
    request('/api/v1/statuses', {
      token: 'tok',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Hi', in_reply_to_id: '1' }),
    }),
    { fetch },
  );
  const body = await res.json();
  assert.equal(body.id, '2');
  assert.equal(body.in_reply_to_id, '1');
  const sent = new URLSearchParams(
    calls.find(({ key }) => key === 'POST /posts/reply').init.body,
  );
  assert.equal(sent.get('id'), '1');
  assert.equal(sent.get('content'), 'Hi');
});

test('top-level posts are refused without reaching upstream', async () => {
  const { fetch, calls } = stubUpstream();
  const res = await handleProxy(
    request('/api/v1/statuses', {
      token: 'tok',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Hi' }),
    }),
    { fetch },
  );
  assert.equal(res.status, 422);
  assert.equal(calls.length, 0);
});

test('bookmarking returns the post marked as bookmarked', async () => {
  const { fetch, calls } = stubUpstream({
    'POST /posts/bookmarks': {},
    'GET /posts/conversation': { items: [post(7, 'ann')] },
  });
  const res = await handleProxy(
    request('/api/v1/statuses/7/bookmark', { token: 'tok', method: 'POST' }),
    { fetch },
  );
  assert.equal((await res.json()).bookmarked, true);
  assert.equal(new URLSearchParams(calls[0].init.body).get('id'), '7');
});

test("one user's bookmark listing never answers another user's request", async () => {
  // Unresolved: a fediverse URL with no Micro.blog post id in it.
  const bookmark = {
    ...post(55, 'ann'),
    url: 'https://aus.social/users/ann/statuses/1',
  };
  const { fetch } = stubUpstream({
    'GET /posts/bookmarks': ({}, init) =>
      init.headers.Authorization === 'Bearer alice'
        ? { items: [bookmark] }
        : { items: [] },
    'GET /posts/conversation': { items: [] },
  });
  await handleProxy(request('/api/v1/bookmarks', { token: 'alice' }), { fetch });
  const res = await handleProxy(
    request('/api/v1/statuses/55', { token: 'bob' }),
    { fetch },
  );
  assert.equal(res.status, 404);
});

test('tokens and sign-in codes never reach the logs', async () => {
  const logged = [];
  const originals = { log: console.log, error: console.error };
  console.log = console.error = (...args) => logged.push(args.join(' '));
  try {
    const { fetch } = stubUpstream({
      'POST /indieauth/token': { access_token: 'SECRET-MINTED' },
      'GET /posts/timeline': () => new Response('No', { status: 500 }),
      'POST /account/verify': { username: 'ann' },
      'GET /posts/ann': { items: [], author: {}, _microblog: { username: 'ann' } },
    });
    await handleProxy(
      request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'code=SECRET-CODE&code_verifier=SECRET-VERIFIER',
      }),
      { fetch },
    );
    await handleProxy(
      request('/oauth/authorize?client_id=a&redirect_uri=b&code_challenge=SECRET-CHALLENGE'),
      { fetch },
    );
    await handleProxy(
      request('/api/v1/timelines/home', { token: 'SECRET-TOKEN' }),
      { fetch },
    );
    await handleProxy(
      request('/api/v1/accounts/verify_credentials', { token: 'SECRET-TOKEN' }),
      { fetch },
    );
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(logged.filter((line) => line.includes('SECRET')), []);
});

test('unknown API reads get an empty list and writes are refused', async () => {
  const { fetch } = stubUpstream();
  const read = await handleProxy(request('/api/v1/lists'), { fetch });
  assert.deepEqual(await read.json(), []);
  const write = await handleProxy(
    request('/api/v1/statuses/1/reblog', { token: 'tok', method: 'POST' }),
    { fetch },
  );
  assert.equal(write.status, 501);
});

test('familiar followers is a stub, not a profile named familiar_followers', async () => {
  const { fetch, calls } = stubUpstream();
  const res = await handleProxy(
    request('/api/v1/accounts/familiar_followers?id[]=ann'),
    { fetch },
  );
  assert.deepEqual(await res.json(), []);
  assert.equal(calls.length, 0);
});

test('personal API responses are never stored by a cache', async () => {
  const { fetch } = stubUpstream({
    'GET /posts/timeline': { items: [post(1, 'ann')] },
  });
  const res = await handleProxy(
    request('/api/v1/timelines/home', { token: 'tok' }),
    { fetch },
  );
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});
