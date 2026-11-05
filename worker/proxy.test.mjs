import assert from 'node:assert/strict';
import { test } from 'node:test';

import worker from './index.mjs';
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
  new Request(path.startsWith('http') ? path : `${ORIGIN}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

test('leaves app paths for the static assets', async () => {
  const { fetch } = stubUpstream();
  assert.equal(await handleProxy(request('/'), { fetch }), null);
  assert.equal(await handleProxy(request('/assets/main.js'), { fetch }), null);
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
  assert.equal(
    target.origin + target.pathname,
    'https://micro.blog/indieauth/auth',
  );
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
  assert.deepEqual(
    body.map((s) => s.account.acct),
    ['ann', 'bob'],
  );
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
  const items = [
    post(2, 'bob', '<p><a href="x">@ann</a> yes</p>'),
    post(1, 'ann'),
  ];
  const { fetch } = stubUpstream({
    'GET /posts/conversation': { items },
  });
  const status = await handleProxy(request('/api/v1/statuses/2'), { fetch });
  assert.equal((await status.json()).in_reply_to_id, '1');
  const context = await handleProxy(request('/api/v1/statuses/2/context'), {
    fetch,
  });
  assert.deepEqual(
    (await context.json()).ancestors.map((s) => s.id),
    ['1'],
  );
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
  const after = [
    post(2, 'me', '<p>Hi</p>', { is_deletable: true }),
    post(1, 'ann'),
  ];
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
  await handleProxy(request('/api/v1/bookmarks', { token: 'alice' }), {
    fetch,
  });
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
      'GET /posts/ann': {
        items: [],
        author: {},
        _microblog: { username: 'ann' },
      },
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
      request(
        '/oauth/authorize?client_id=a&redirect_uri=b&code_challenge=SECRET-CHALLENGE',
      ),
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
  assert.deepEqual(
    logged.filter((line) => line.includes('SECRET')),
    [],
  );
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

// A profile feed ignores before_id and returns twice the requested count.
function profileFeed(total) {
  const all = Array.from({ length: total }, (_, i) =>
    post(String(total - i), 'ann'),
  );
  return (url) => ({
    author: {},
    _microblog: {},
    items: all.slice(0, Number(url.searchParams.get('count')) * 2),
  });
}

test('the first profile page fetches only what it needs', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/ann': profileFeed(1000),
  });
  const res = await handleProxy(
    request('/api/v1/accounts/ann/statuses?limit=20'),
    { fetch },
  );
  assert.equal((await res.json()).length, 20);
  assert.deepEqual(
    calls.map(({ url }) => url.searchParams.get('count')),
    ['20'],
  );
});

test('later profile pages fetch deeper until the page fills', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/ann': profileFeed(1000),
  });
  // 60 posts in: count=20 only reaches 40 posts and count=40 reaches 80.
  const res = await handleProxy(
    request('/api/v1/accounts/ann/statuses?limit=20&max_id=941'),
    { fetch },
  );
  const body = await res.json();
  assert.equal(body.length, 20);
  assert.equal(body[0].id, '940');
  assert.deepEqual(
    calls.map(({ url }) => url.searchParams.get('count')),
    ['20', '40'],
  );
});

test('a profile with no older posts stops fetching', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/ann': profileFeed(5),
  });
  const res = await handleProxy(
    request('/api/v1/accounts/ann/statuses?limit=20&max_id=1'),
    { fetch },
  );
  assert.deepEqual(await res.json(), []);
  assert.equal(calls.length, 1);
});

test('deep profile paging stops at the fetch limit', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/ann': profileFeed(5000),
  });
  await handleProxy(
    request('/api/v1/accounts/ann/statuses?limit=20&max_id=2'),
    { fetch },
  );
  assert.equal(calls.at(-1).url.searchParams.get('count'), '200');
});

// Bookmarks of fediverse or blog posts have no post id, and no conversation.
const unresolvedBookmark = {
  ...post(55, 'ann'),
  url: 'https://aus.social/users/ann/statuses/1',
};

test('an unresolved bookmark opens from the user’s own bookmarks', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/conversation': { items: [] },
    'GET /posts/bookmarks': { items: [unresolvedBookmark, post(40, 'bob')] },
  });
  const res = await handleProxy(
    request('/api/v1/statuses/55', { token: 'alice' }),
    { fetch },
  );
  assert.equal((await res.json()).id, '55');
  const lookup = calls.find(({ key }) => key === 'GET /posts/bookmarks');
  assert.equal(lookup.init.headers.Authorization, 'Bearer alice');
  assert.equal(lookup.url.searchParams.get('before_id'), '56');
});

test('an unknown post does not fall back without a token', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/conversation': { items: [] },
  });
  const res = await handleProxy(request('/api/v1/statuses/55'), { fetch });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
});

test('unbookmarking an unresolved row still returns its post', async () => {
  let removed = false;
  const { fetch } = stubUpstream({
    'GET /posts/conversation': { items: [] },
    'GET /posts/bookmarks': () => ({
      items: removed ? [] : [unresolvedBookmark],
    }),
    'DELETE /posts/bookmarks/55': () => {
      removed = true;
      return {};
    },
  });
  const res = await handleProxy(
    request('/api/v1/statuses/55/unbookmark', {
      token: 'alice',
      method: 'POST',
    }),
    { fetch },
  );
  const body = await res.json();
  assert.equal(body.id, '55');
  assert.equal(body.bookmarked, false);
  assert.equal(removed, true);
});

const reply = (fields, fetch) =>
  handleProxy(
    request('/api/v1/statuses', {
      token: 'tok',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Hi', in_reply_to_id: '1', ...fields }),
    }),
    { fetch },
  );

// Publishing without one of these would expose something the author meant to limit.
for (const [name, fields] of [
  ['a private mention', { visibility: 'direct' }],
  ['a followers-only post', { visibility: 'private' }],
  ['an unlisted post', { visibility: 'unlisted' }],
  ['a content warning', { spoiler_text: 'Spoilers' }],
  ['sensitive media', { sensitive: true }],
  ['a scheduled post', { scheduled_at: '2030-01-01T00:00:00Z' }],
  ['a poll', { poll: { options: ['a', 'b'], expires_in: 60 } }],
  ['media', { media_ids: ['9'] }],
  ['a quote', { quoted_status_id: '2' }],
]) {
  test(`${name} is refused and never reaches Micro.blog`, async () => {
    const { fetch, calls } = stubUpstream();
    const res = await reply(fields, fetch);
    assert.equal(res.status, 422);
    assert.ok((await res.json()).error);
    assert.equal(calls.length, 0);
  });
}

test('Phanpy’s ordinary public reply fields are accepted', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/conversation': { items: [post(1, 'ann')] },
    'POST /posts/reply': {},
    'POST /account/verify': { username: 'me' },
    'GET /posts/me': { author: {}, _microblog: { username: 'me' } },
  });
  const res = await reply(
    {
      visibility: 'public',
      spoiler_text: '',
      sensitive: false,
      language: 'en',
      media_ids: [],
    },
    fetch,
  );
  assert.equal(res.status, 200);
  assert.equal(
    calls.filter(({ key }) => key === 'POST /posts/reply').length,
    1,
  );
});

test('a reply already published still succeeds if reading it back fails', async () => {
  // Phanpy resends a failed post, so an error here would publish a duplicate.
  let replied = false;
  const { fetch, calls } = stubUpstream({
    'GET /posts/conversation': () =>
      replied
        ? new Response('Down', { status: 500 })
        : { items: [post(1, 'ann')] },
    'POST /posts/reply': () => {
      replied = true;
      return {};
    },
  });
  const res = await reply({}, fetch);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content, '<p>Hi</p>');
  assert.equal(
    calls.filter(({ key }) => key === 'POST /posts/reply').length,
    1,
  );
});

function fakeKv() {
  const data = new Map();
  let writes = 0;
  return {
    data,
    writes: () => writes,
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => {
      writes += 1;
      data.set(key, value);
    },
  };
}

// Answers /account/verify as whichever user owns the token.
const verifyByToken = ({}, init) => ({
  username: new URLSearchParams(init.body).get('token'),
});

const markerPost = (token, kv, fetch, id = '50') =>
  handleProxy(
    request('/api/v1/markers', {
      token,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifications: { last_read_id: id } }),
    }),
    { fetch, kv },
  );

const markerGet = (token, kv, fetch) =>
  handleProxy(request('/api/v1/markers?timeline[]=notifications', { token }), {
    fetch,
    kv,
  });

test('a read position saved by a user comes back for that user', async () => {
  const kv = fakeKv();
  const { fetch } = stubUpstream({ 'POST /account/verify': verifyByToken });
  const saved = await markerPost('alice', kv, fetch);
  assert.equal((await saved.json()).notifications.last_read_id, '50');
  const res = await markerGet('alice', kv, fetch);
  const body = await res.json();
  assert.equal(body.notifications.last_read_id, '50');
  assert.ok(body.notifications.updated_at);
});

test("one user's read position is never returned to another", async () => {
  const kv = fakeKv();
  const { fetch } = stubUpstream({ 'POST /account/verify': verifyByToken });
  await markerPost('alice', kv, fetch);
  const res = await markerGet('bob', kv, fetch);
  assert.deepEqual(await res.json(), {});
});

test('read positions are stored under the verified user, not the token', async () => {
  const kv = fakeKv();
  const { fetch } = stubUpstream({
    'POST /account/verify': { username: 'alice' },
  });
  await markerPost('SECRET-TOKEN', kv, fetch);
  assert.deepEqual([...kv.data.keys()], ['markers:alice']);
  assert.ok(!kv.data.get('markers:alice').includes('SECRET-TOKEN'));
});

test('an unchanged read position does not write again', async () => {
  const kv = fakeKv();
  const { fetch } = stubUpstream({ 'POST /account/verify': verifyByToken });
  await markerPost('alice', kv, fetch);
  await markerPost('alice', kv, fetch);
  assert.equal(kv.writes(), 1);
});

test('read positions need a signed-in user', async () => {
  const kv = fakeKv();
  const { fetch } = stubUpstream();
  const res = await markerPost(null, kv, fetch);
  assert.equal(res.status, 401);
  assert.equal(kv.data.size, 0);
});

test('read positions still answer when no store is configured', async () => {
  const { fetch } = stubUpstream({ 'POST /account/verify': verifyByToken });
  const saved = await markerPost('alice', undefined, fetch);
  assert.equal(saved.status, 200);
  assert.deepEqual(
    await (await markerGet('alice', undefined, fetch)).json(),
    {},
  );
});

const foundUser = {
  name: 'Ann',
  url: 'https://ann.example',
  avatar: 'https://cdn.example/ann.jpg',
  username: 'ann@social.example',
  bio: 'Hello',
  is_following: true,
  is_you: false,
};

test('search returns matching accounts and posts', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /users/search': [foundUser],
    'GET /posts/search': { items: [post(8, 'bob')] },
  });
  const res = await handleProxy(
    request('/api/v2/search?q=coffee', { token: 'tok' }),
    { fetch },
  );
  const body = await res.json();
  assert.equal(body.accounts[0].acct, 'ann@social.example');
  assert.equal(body.accounts[0].note, 'Hello');
  assert.equal(body.statuses[0].id, '8');
  assert.deepEqual(body.hashtags, []);
  assert.equal(
    calls
      .find(({ key }) => key === 'GET /posts/search')
      .url.searchParams.get('q'),
    'coffee',
  );
});

test('search only queries the requested type', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /users/search': [foundUser],
  });
  const res = await handleProxy(
    request('/api/v2/search?q=ann&type=accounts&limit=1', { token: 'tok' }),
    { fetch },
  );
  assert.equal((await res.json()).statuses.length, 0);
  assert.deepEqual(
    calls.map(({ key }) => key),
    ['GET /users/search'],
  );
});

test('search has no results without a token rather than failing', async () => {
  const { fetch } = stubUpstream({
    'GET /users/search': () => new Response('No', { status: 401 }),
    'GET /posts/search': { items: [post(8, 'bob')] },
  });
  const res = await handleProxy(request('/api/v2/search?q=ann'), { fetch });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.accounts, []);
  assert.equal(body.statuses.length, 1);
});

test('search cannot resolve a URL into a post, so it finds nothing', async () => {
  const { fetch, calls } = stubUpstream();
  const res = await handleProxy(
    request(
      '/api/v2/search?q=https%3A%2F%2Faus.social%2F%40x%2F1&resolve=true',
      { token: 'tok' },
    ),
    { fetch },
  );
  assert.deepEqual(await res.json(), {
    accounts: [],
    statuses: [],
    hashtags: [],
  });
  assert.equal(calls.length, 0);
});

test('account search looks up people', async () => {
  const { fetch } = stubUpstream({ 'GET /users/search': [foundUser] });
  const res = await handleProxy(
    request('/api/v1/accounts/search?q=ann', { token: 'tok' }),
    { fetch },
  );
  assert.equal((await res.json())[0].id, 'ann@social.example');
});

test('the following list pages through its results', async () => {
  const people = Array.from({ length: 5 }, (_, i) => ({
    ...foundUser,
    username: `user${i}`,
  }));
  const { fetch } = stubUpstream({ 'GET /users/following/ann': people });
  const first = await handleProxy(
    request('/api/v1/accounts/ann/following?limit=2', { token: 'tok' }),
    { fetch },
  );
  assert.deepEqual(
    (await first.json()).map((a) => a.id),
    ['user0', 'user1'],
  );
  const next = first.headers.get('Link').match(/<([^>]+)>/)[1];
  const second = await handleProxy(request(next, { token: 'tok' }), { fetch });
  assert.deepEqual(
    (await second.json()).map((a) => a.id),
    ['user2', 'user3'],
  );
  const last = second.headers.get('Link').match(/<([^>]+)>/)[1];
  const third = await handleProxy(request(last, { token: 'tok' }), { fetch });
  assert.deepEqual(
    (await third.json()).map((a) => a.id),
    ['user4'],
  );
  assert.equal(third.headers.get('Link'), null);
});

const mine = (id) => post(id, 'me', '<p>Mine</p>', { is_deletable: true });

test('deleting your own post removes it and returns it', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/conversation': { items: [mine(12)] },
    'DELETE /posts/12': {},
  });
  const res = await handleProxy(
    request('/api/v1/statuses/12', { token: 'tok', method: 'DELETE' }),
    { fetch },
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, '12');
  assert.ok(calls.some(({ key }) => key === 'DELETE /posts/12'));
});

test('a post Micro.blog says is not deletable is left alone', async () => {
  const { fetch, calls } = stubUpstream({
    'GET /posts/conversation': { items: [post(12, 'ann')] },
  });
  const res = await handleProxy(
    request('/api/v1/statuses/12', { token: 'tok', method: 'DELETE' }),
    { fetch },
  );
  assert.equal(res.status, 403);
  assert.ok(!calls.some(({ key }) => key.startsWith('DELETE')));
});

test('an id that is not a post in a conversation is left alone', async () => {
  // A bookmark's own id: DELETE /posts/<id> could remove the wrong thing.
  const { fetch, calls } = stubUpstream({
    'GET /posts/conversation': { items: [] },
    'GET /posts/bookmarks': {
      items: [{ ...mine(55), url: 'https://aus.social/users/me/statuses/1' }],
    },
  });
  const res = await handleProxy(
    request('/api/v1/statuses/55', { token: 'tok', method: 'DELETE' }),
    { fetch },
  );
  assert.equal(res.status, 404);
  assert.ok(!calls.some(({ key }) => key.startsWith('DELETE')));
});

const newPost = (fields, fetch) =>
  handleProxy(
    request('/api/v1/statuses', {
      token: 'tok',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Hello', ...fields }),
    }),
    { fetch },
  );

const posted = () =>
  new Response('', {
    status: 202,
    headers: { Location: 'https://me.example/2026/hello.html' },
  });

const newPostRoutes = (extra = {}) => ({
  'POST /micropub': posted,
  'POST /account/verify': { username: 'me' },
  'GET /posts/me': {
    author: { name: 'Me' },
    _microblog: { username: 'me' },
    items: [
      { ...mine(30), url: 'https://me.example/2026/hello.html' },
      mine(29),
    ],
  },
  ...extra,
});

test('a new post goes through Micropub and comes back from the feed', async () => {
  const { fetch, calls } = stubUpstream(newPostRoutes());
  const res = await newPost({ visibility: 'public', language: 'en' }, fetch);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, '30');
  const sent = new URLSearchParams(
    calls.find(({ key }) => key === 'POST /micropub').init.body,
  );
  assert.equal(sent.get('h'), 'entry');
  assert.equal(sent.get('content'), 'Hello');
  assert.equal(calls.filter(({ key }) => key === 'POST /micropub').length, 1);
});

test('a new post the feed has not caught up with still succeeds once', async () => {
  // Phanpy resends a failed post, so an error here would publish a duplicate.
  const { fetch, calls } = stubUpstream(
    newPostRoutes({
      'GET /posts/me': () => new Response('Down', { status: 500 }),
    }),
  );
  const res = await newPost({}, fetch);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.url, 'https://me.example/2026/hello.html');
  assert.equal(body.content, '<p>Hello</p>');
  assert.equal(calls.filter(({ key }) => key === 'POST /micropub').length, 1);
});

test('a rejected new post reports failure', async () => {
  const { fetch } = stubUpstream({
    'POST /micropub': () => new Response('Nope', { status: 400 }),
  });
  const res = await newPost({}, fetch);
  assert.equal(res.status, 400);
});

test('privacy options are still refused for new posts', async () => {
  const { fetch, calls } = stubUpstream(newPostRoutes());
  const res = await newPost({ visibility: 'direct' }, fetch);
  assert.equal(res.status, 422);
  assert.equal(calls.length, 0);
});

const uploadImage = (fetch, description = 'A pumpkin') => {
  const form = new FormData();
  form.set('file', new File(['img'], 'a.png', { type: 'image/png' }));
  if (description) form.set('description', description);
  return handleProxy(
    request('/api/v2/media', { token: 'tok', method: 'POST', body: form }),
    { fetch },
  );
};

const uploaded = () =>
  new Response('', {
    status: 202,
    headers: { Location: 'https://me.example/uploads/a.png' },
  });

test('uploading sends the file to Micro.blog and returns its URL', async () => {
  const { fetch, calls } = stubUpstream({ 'POST /micropub/media': uploaded });
  const res = await uploadImage(fetch);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'image');
  assert.equal(body.url, 'https://me.example/uploads/a.png');
  assert.equal(body.description, 'A pumpkin');
  assert.ok(body.id);
  const sent = calls[0].init.body;
  assert.ok(sent instanceof FormData);
  assert.equal(sent.get('file').name, 'a.png');
});

test('uploads that are not images are refused without reaching Micro.blog', async () => {
  const { fetch, calls } = stubUpstream({ 'POST /micropub/media': uploaded });
  const form = new FormData();
  form.set('file', new File(['x'], 'a.mp4', { type: 'video/mp4' }));
  const res = await handleProxy(
    request('/api/v2/media', { token: 'tok', method: 'POST', body: form }),
    { fetch },
  );
  assert.equal(res.status, 422);
  assert.equal(calls.length, 0);
});

test('a new post with images sends each one with its alt text', async () => {
  const { fetch, calls } = stubUpstream({
    'POST /micropub/media': uploaded,
    ...newPostRoutes(),
  });
  const { id } = await (await uploadImage(fetch)).json();
  const res = await newPost({ media_ids: [id, id] }, fetch);
  assert.equal(res.status, 200);
  const sent = new URLSearchParams(
    calls.find(({ key }) => key === 'POST /micropub').init.body,
  );
  assert.deepEqual(sent.getAll('photo[]'), [
    'https://me.example/uploads/a.png',
    'https://me.example/uploads/a.png',
  ]);
  assert.deepEqual(sent.getAll('mp-photo-alt[]'), ['A pumpkin', 'A pumpkin']);
});

test('an image attached to a reply is refused, because replies take only text', async () => {
  const { fetch, calls } = stubUpstream({ 'POST /micropub/media': uploaded });
  const { id } = await (await uploadImage(fetch)).json();
  calls.length = 0;
  const res = await newPost({ media_ids: [id], in_reply_to_id: '1' }, fetch);
  assert.equal(res.status, 422);
  assert.equal(calls.length, 0);
});

test('a media id that was not issued here is refused', async () => {
  const { fetch, calls } = stubUpstream(newPostRoutes());
  const res = await newPost({ media_ids: ['not-a-real-id'] }, fetch);
  assert.equal(res.status, 422);
  assert.equal(calls.length, 0);
});

test('following someone asks Micro.blog and reports the new state', async () => {
  const { fetch, calls } = stubUpstream({
    'POST /users/follow': {},
    'GET /users/is_following': { is_following: true },
  });
  const res = await handleProxy(
    request('/api/v1/accounts/dajb%40social.coop/follow', {
      token: 'tok',
      method: 'POST',
    }),
    { fetch },
  );
  const body = await res.json();
  assert.equal(body.following, true);
  assert.equal(body.id, 'dajb@social.coop');
  assert.equal(
    new URLSearchParams(calls[0].init.body).get('username'),
    'dajb@social.coop',
  );
});

test('unfollowing someone asks Micro.blog and reports the new state', async () => {
  const { fetch, calls } = stubUpstream({ 'POST /users/unfollow': {} });
  const res = await handleProxy(
    request('/api/v1/accounts/ann/unfollow', { token: 'tok', method: 'POST' }),
    { fetch },
  );
  assert.equal((await res.json()).following, false);
  assert.equal(calls[0].key, 'POST /users/unfollow');
});

const signIn = (fetch, allowedUsers) =>
  handleProxy(
    request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=c1',
    }),
    { fetch, allowedUsers },
  );

const signInRoutes = (username) => ({
  'POST /indieauth/token': { access_token: 'SECRET-MINTED' },
  'POST /account/verify': { username },
});

test('sign-in refuses a user who is not on the allowlist', async () => {
  const { fetch } = stubUpstream(signInRoutes('stranger'));
  const res = await signIn(fetch, 'nighthawk,manton');
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes('SECRET-MINTED'));
});

test('sign-in lets in allowlisted users, ignoring case and spaces', async () => {
  for (const username of ['nighthawk', 'Manton']) {
    const { fetch } = stubUpstream(signInRoutes(username));
    const res = await signIn(fetch, ' nighthawk , manton ');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).access_token, 'SECRET-MINTED');
  }
});

test('sign-in withholds the token when the user cannot be verified', async () => {
  const { fetch } = stubUpstream({
    'POST /indieauth/token': { access_token: 'SECRET-MINTED' },
  });
  const res = await signIn(fetch, 'nighthawk');
  assert.notEqual(res.status, 200);
  assert.ok(!(await res.text()).includes('SECRET-MINTED'));
});

test('sign-in is open when no allowlist is set', async () => {
  const { fetch } = stubUpstream(signInRoutes('anyone'));
  for (const allowedUsers of [undefined, '', ' , ']) {
    const res = await signIn(fetch, allowedUsers);
    assert.equal(res.status, 200);
  }
});

test('the Worker takes the allowlist from its environment', async (t) => {
  const { fetch } = stubUpstream(signInRoutes('stranger'));
  t.mock.method(globalThis, 'fetch', fetch);
  const res = await worker.fetch(
    request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=c1',
    }),
    { MICROBLOG_ALLOWED_USERS: 'nighthawk' },
  );
  assert.equal(res.status, 403);
});
