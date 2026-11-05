// Presents the Mastodon API that Phanpy expects, backed by Micro.blog's own API.
// It holds nothing between requests, so one user's data can't reach another's.
// Never log tokens, sign-in codes or query strings here.
import {
  bookmarkPostId,
  findNewReply,
  pageItems,
  paginationLink,
  readFields,
  toAccount,
  toContext,
  toNotification,
  toStatus,
  toThreadStatus,
  wantsMentions,
} from './mapper.mjs';

const UPSTREAM = 'https://micro.blog';
const MAX_PROFILE_COUNT = 200;
const STATUS_OPTIONS = { extractImages: true };
const WELL_KNOWN = new Set([
  '/.well-known/nodeinfo',
  '/.well-known/oauth-authorization-server',
]);
// These sit under /accounts/ but aren't account names.
const NOT_ACCOUNTS = new Set(['familiar_followers', 'search']);

class UpstreamError extends Error {
  constructor(status, path) {
    super(`upstream ${status} for ${path}`);
    this.status = status;
  }
}

function makeClient(fetch, token) {
  const call = async (path, init = {}) => {
    const res = await fetch(`${UPSTREAM}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new UpstreamError(res.status, path.split('?')[0]);
    // Write endpoints aren't documented as returning JSON.
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  const postForm = (path, fields) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  return { call, postForm };
}

function feedQuery(params) {
  const query = new URLSearchParams();
  if (params.has('limit')) query.set('count', params.get('limit'));
  if (params.has('max_id')) query.set('before_id', params.get('max_id'));
  const since = params.get('since_id') || params.get('min_id');
  if (since) query.set('since_id', since);
  return query.toString();
}

function pageResponse(items, url, convert = toStatus) {
  const link = paginationLink(url.href, items);
  return {
    body: items.map((item) => convert(item, STATUS_OPTIONS)),
    headers: link ? { Link: link } : {},
  };
}

async function feedResponse(client, path, url, convert) {
  const query = feedQuery(url.searchParams);
  const feed = await client.call(query ? `${path}?${query}` : path);
  return pageResponse(pageItems(feed.items ?? [], url.searchParams), url, convert);
}

// Profile feeds ignore before_id, so older pages can only be reached by fetching
// from the newest post. Deep fetches are slow (25s for count=200 on a fediverse
// account), so start shallow and go deeper only until the page fills.
async function profileResponse(client, username, url) {
  const limit = Number(url.searchParams.get('limit')) || 20;
  let count = Math.min(limit, MAX_PROFILE_COUNT);
  while (true) {
    const feed = await client.call(`${userPath(username)}?count=${count}`);
    const fetched = feed.items ?? [];
    const items = pageItems(fetched, url.searchParams);
    const exhausted = fetched.length < count || count >= MAX_PROFILE_COUNT;
    if (items.length >= limit || exhausted) return pageResponse(items, url);
    count = Math.min(count * 2, MAX_PROFILE_COUNT);
  }
}

const userPath = (username) => `/posts/${encodeURI(username)}`;

async function fetchAccount(client, username) {
  const feed = await client.call(`${userPath(username)}?count=1`);
  return toAccount(feed.author, feed._microblog);
}

async function verifyCredentials(client, token) {
  const { username } = await client.postForm('/account/verify', { token });
  if (!username) throw new UpstreamError(401, '/account/verify');
  return fetchAccount(client, username);
}

async function conversation(client, id) {
  const path = `/posts/conversation?id=${encodeURIComponent(id)}`;
  return (await client.call(path)).items ?? [];
}

// A bookmark's id isn't its post's id, so rows use the post's where it's known.
function bookmarkStatus(item, options) {
  return toStatus({ ...item, id: bookmarkPostId(item) }, options);
}

// Bookmarks of fediverse or blog posts keep their own id and have no conversation,
// so they're looked up in the signed-in user's bookmarks, which are newest-first.
async function findStatus(client, token, id) {
  const items = await conversation(client, id);
  const found = toThreadStatus(items, id, STATUS_OPTIONS);
  if (found || !token) return found;
  const feed = await client.call(`/posts/bookmarks?before_id=${BigInt(id) + 1n}`);
  const bookmark = feed.items?.find((item) => item.id === id);
  return bookmark && toStatus(bookmark, STATUS_OPTIONS);
}

async function setBookmark(client, token, id, bookmarked) {
  let status;
  if (bookmarked) {
    await client.postForm('/posts/bookmarks', { id });
    status = await findStatus(client, token, id);
  } else {
    // Looked up first, because an unresolved bookmark can't be found once removed.
    status = await findStatus(client, token, id);
    await client.call(`/posts/bookmarks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  if (!status) throw new UpstreamError(404, '/posts/conversation');
  // The action just succeeded, so don't let a stale flag undo it in the UI.
  return { body: { ...status, bookmarked } };
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c],
  );

async function createReply(client, token, fields) {
  const { status: text, in_reply_to_id: parentId, media_ids: mediaIds } = fields;
  if (!parentId) {
    return { status: 422, body: { error: 'New posts are not supported yet.' } };
  }
  if (mediaIds?.length) {
    return { status: 422, body: { error: 'Media is not supported yet.' } };
  }
  const known = new Set(
    (await conversation(client, parentId)).map(({ id }) => id),
  );
  // The response doesn't identify the new post, so it's found by comparing threads.
  const response = await client.postForm('/posts/reply', {
    id: parentId,
    content: text,
  });
  const items = await conversation(client, parentId);
  const created = findNewReply(items, known);
  if (created) {
    return { body: toThreadStatus(items, created.id, STATUS_OPTIONS) };
  }
  const {
    display_name: name,
    avatar,
    username,
  } = await verifyCredentials(client, token);
  return {
    body: toStatus({
      id: String(response.id ?? `pending-${Date.now()}`),
      content_html: `<p>${escapeHtml(text)}</p>`,
      url: '',
      date_published: new Date().toISOString(),
      author: { name, avatar, _microblog: { username } },
    }),
  };
}

function authorizeRedirect(url) {
  const params = url.searchParams;
  const target = new URL(`${UPSTREAM}/indieauth/auth`);
  target.search = new URLSearchParams({
    response_type: 'code',
    client_id: params.get('client_id'),
    redirect_uri: params.get('redirect_uri'),
    // Phanpy sends no state and IndieAuth requires one.
    state: crypto.randomUUID(),
    // Micro.blog has no `push` scope.
    scope: 'read write follow',
    ...(params.has('code_challenge') && {
      code_challenge: params.get('code_challenge'),
      code_challenge_method: params.get('code_challenge_method'),
    }),
  }).toString();
  return { status: 302, headers: { Location: target.href } };
}

async function exchangeToken(fetch, fields) {
  const { code, client_id, redirect_uri, code_verifier } = fields;
  const res = await fetch(`${UPSTREAM}/indieauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id,
      redirect_uri,
      ...(code_verifier && { code_verifier }),
    }).toString(),
  });
  const json = await res.json();
  if (!res.ok) return { status: res.status, body: json };
  return {
    body: {
      access_token: json.access_token,
      token_type: 'Bearer',
      scope: json.scope ?? 'read write follow',
      created_at: Math.floor(Date.now() / 1000),
    },
  };
}

function instanceInfo(host) {
  return {
    uri: host,
    domain: host,
    title: 'Micro.blog',
    version: '4.0.0',
    description: '',
    short_description: '',
    thumbnail: { url: '' },
    languages: ['en'],
    rules: [],
    registrations: { enabled: false },
    contact: {},
    configuration: {
      urls: {},
      statuses: { max_characters: 5000, max_media_attachments: 0 },
      media_attachments: { supported_mime_types: [] },
      polls: { max_options: 0 },
    },
  };
}

async function route(request, url, fetch) {
  const { pathname, origin, host } = url;
  const { method } = request;
  const token =
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || null;
  const client = makeClient(fetch, token);
  const fields =
    method === 'POST'
      ? readFields(request.headers.get('Content-Type'), await request.text())
      : {};

  if (pathname === '/.well-known/oauth-authorization-server') {
    return {
      body: {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        code_challenge_methods_supported: ['S256'],
      },
    };
  }
  if (pathname === '/.well-known/nodeinfo') {
    return {
      body: {
        links: [
          {
            rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
            href: `${origin}/nodeinfo/2.0`,
          },
        ],
      },
    };
  }
  if (pathname === '/nodeinfo/2.0') {
    return {
      body: {
        version: '2.0',
        software: { name: 'microdotblog', version: '4.0.0' },
      },
    };
  }
  if (pathname === '/oauth/authorize') return authorizeRedirect(url);
  if (pathname === '/oauth/token' && method === 'POST') {
    return exchangeToken(fetch, fields);
  }
  // Micro.blog has no revoke endpoint I could find, so tokens stay valid until
  // revoked in its account settings.
  if (pathname === '/oauth/revoke') return { body: {} };

  if (pathname === '/api/v1/apps' && method === 'POST') {
    return {
      body: {
        id: 'microblog',
        name: fields.client_name || 'Phanpy',
        website: null,
        redirect_uri: fields.redirect_uris,
        // IndieAuth identifies clients by URL rather than by a registered ID.
        client_id: `${origin}/`,
        client_secret: 'unused',
        vapid_key: '',
      },
    };
  }
  if (pathname === '/api/v1/instance' || pathname === '/api/v2/instance') {
    return { body: instanceInfo(host) };
  }
  if (pathname === '/api/v1/accounts/verify_credentials') {
    if (!token) return { status: 401, body: { error: 'No token' } };
    return { body: await verifyCredentials(client, token) };
  }
  if (pathname === '/api/v1/preferences' || pathname === '/api/v1/markers') {
    return { body: {} };
  }
  if (pathname === '/api/v1/timelines/home') {
    return feedResponse(client, '/posts/timeline', url);
  }
  if (pathname === '/api/v1/notifications') {
    if (!token) return { status: 401, body: { error: 'No token' } };
    if (!wantsMentions(url.searchParams)) return { body: [] };
    return feedResponse(client, '/posts/mentions', url, toNotification);
  }
  if (pathname === '/api/v1/bookmarks') {
    return feedResponse(client, '/posts/bookmarks', url, bookmarkStatus);
  }
  if (pathname === '/api/v1/statuses' && method === 'POST') {
    return createReply(client, token, fields);
  }
  const bookmark = pathname.match(/^\/api\/v1\/statuses\/(\d+)\/(un)?bookmark$/);
  if (bookmark && method === 'POST') {
    return setBookmark(client, token, bookmark[1], !bookmark[2]);
  }
  if (pathname === '/api/v1/accounts/lookup') {
    return { body: await fetchAccount(client, url.searchParams.get('acct')) };
  }
  if (pathname === '/api/v1/accounts/relationships') {
    const relationships = url.searchParams.getAll('id[]').map(async (id) => {
      const feed = await client.call(`${userPath(id)}?count=1`);
      return {
        id,
        following: Boolean(feed._microblog?.is_following),
        followed_by: false,
        requested: false,
        blocking: false,
        muting: false,
        note: '',
      };
    });
    return { body: await Promise.all(relationships) };
  }

  const account = pathname.match(/^\/api\/v1\/accounts\/([^/]+)(\/statuses)?$/);
  if (account && !NOT_ACCOUNTS.has(account[1])) {
    const username = decodeURIComponent(account[1]);
    if (!account[2]) return { body: await fetchAccount(client, username) };
    if (url.searchParams.get('pinned') === 'true') return { body: [] };
    return profileResponse(client, username, url);
  }

  const status = pathname.match(/^\/api\/v1\/statuses\/(\d+)(\/context)?$/);
  if (status && method === 'GET') {
    if (status[2]) {
      const items = await conversation(client, status[1]);
      return { body: toContext(items, status[1], STATUS_OPTIONS) };
    }
    const found = await findStatus(client, token, status[1]);
    return found ? { body: found } : { status: 404, body: { error: 'Not found' } };
  }

  // Features Micro.blog lacks read as empty, and writes fail visibly.
  if (method === 'GET') return { body: [] };
  return { status: 501, body: { error: `Not supported: ${pathname}` } };
}

const isProxied = (pathname) =>
  pathname.startsWith('/api/') ||
  pathname.startsWith('/oauth/') ||
  pathname.startsWith('/nodeinfo/') ||
  WELL_KNOWN.has(pathname);

// Returns null for anything that belongs to the static app.
export async function handleProxy(request, { fetch = globalThis.fetch } = {}) {
  const url = new URL(request.url);
  if (!isProxied(url.pathname)) return null;
  const baseHeaders = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  try {
    const {
      status = 200,
      body,
      headers = {},
    } = await route(request, url, fetch);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { ...baseHeaders, ...headers },
    });
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 500;
    // Only the message: UpstreamError carries a path with no query string.
    console.error(`${request.method} ${url.pathname}: ${error.message}`);
    return Response.json(
      { error: error.message },
      { status, headers: baseHeaders },
    );
  }
}
