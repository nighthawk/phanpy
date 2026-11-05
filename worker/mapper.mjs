const IMG = /<img\b[^>]*>/gi;
const ANCHOR = /<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;

const attr = (tag, name) =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1];

function extractMentions(html) {
  return [...html.matchAll(ANCHOR)].flatMap(([, url, inner]) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!text.startsWith('@')) return [];
    const username = text.slice(1);
    return [{ id: username, username, acct: username, url }];
  });
}

// Fediverse custom emoji arrive as images, marked by class. Mastodon clients expect
// a :shortcode: in the text plus an entry in `emojis`.
function extractEmojis(html) {
  const emojis = new Map();
  const content = html.replace(IMG, (tag) => {
    const shortcode = attr(tag, 'alt');
    if (!/\bcustom_emoji\b/.test(attr(tag, 'class') ?? '') || !shortcode) return tag;
    const url = attr(tag, 'src');
    emojis.set(shortcode, { shortcode, url, static_url: url, visible_in_picker: false });
    return `:${shortcode}:`;
  });
  return { content, emojis: [...emojis.values()] };
}

function extractMedia(html, postId) {
  const media = [...html.matchAll(IMG)].map(([tag], index) => {
    const url = attr(tag, 'src');
    const width = Number(attr(tag, 'width'));
    const height = Number(attr(tag, 'height'));
    return {
      id: `${postId}-${index}`,
      type: 'image',
      url,
      preview_url: url,
      remote_url: null,
      description: attr(tag, 'alt') || null,
      blurhash: null,
      meta:
        width && height
          ? { original: { width, height, aspect: width / height } }
          : {},
    };
  });
  // Micro.blog wraps some images in their own paragraph, which would leave a gap.
  const content = html.replace(IMG, '').replace(/<p>\s*<\/p>/g, '').trim();
  return { content, media };
}

export function toAccount(author = {}, profile = {}) {
  const username = profile.username ?? author._microblog?.username;
  return {
    id: username,
    username,
    acct: username,
    display_name: author.name || username,
    locked: false,
    bot: false,
    group: false,
    discoverable: true,
    created_at: '1970-01-01T00:00:00.000Z',
    note: profile.bio ?? '',
    url: author.url,
    avatar: author.avatar,
    avatar_static: author.avatar,
    header: '',
    header_static: '',
    // Micro.blog deliberately has no follower counts, so this is not "zero followers".
    followers_count: 0,
    following_count: profile.following_count ?? 0,
    statuses_count: 0,
    emojis: [],
    fields: [],
  };
}

export function toStatus(item, { extractImages = false, parent = null } = {}) {
  const source = item.content_html ?? '';
  const { content: html, emojis } = extractEmojis(source);
  const { content, media } = extractImages
    ? extractMedia(html, item.id)
    : { content: html, media: [] };
  return {
    id: item.id,
    uri: item.url,
    url: item.url,
    created_at: item.date_published,
    edited_at: null,
    account: toAccount(item.author),
    content,
    text: null,
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    language: null,
    media_attachments: media,
    mentions: extractMentions(html),
    tags: [],
    emojis,
    card: null,
    poll: null,
    reblog: null,
    quote: null,
    application: null,
    in_reply_to_id: parent?.id ?? null,
    in_reply_to_account_id: parent?.author?._microblog?.username ?? null,
    reblogs_count: 0,
    favourites_count: 0,
    replies_count: 0,
    favourited: Boolean(item._microblog?.is_favorite),
    reblogged: false,
    muted: false,
    pinned: false,
    bookmarked: Boolean(item._microblog?.is_bookmark),
  };
}

// The API has no reply-to field, so parents are a guess: the most recent earlier
// post by whoever a reply mentions first, otherwise the thread's first post.
function inferParents(items) {
  const oldestFirst = [...items].sort((a, b) =>
    a.date_published.localeCompare(b.date_published),
  );
  const parents = new Map();
  oldestFirst.forEach((item, index) => {
    if (index === 0) return;
    const name = extractMentions(item.content_html ?? '')[0]?.username;
    const earlier = oldestFirst.slice(0, index).reverse();
    const mentioned =
      name &&
      earlier.find((candidate) => {
        const author = candidate.author?._microblog?.username ?? '';
        return author === name || author.startsWith(`${name}@`);
      });
    parents.set(item.id, mentioned || oldestFirst[0]);
  });
  return { oldestFirst, parents };
}

export function toThreadStatus(items, id, options = {}) {
  const { parents } = inferParents(items);
  const item = items.find((candidate) => candidate.id === id);
  return item && toStatus(item, { ...options, parent: parents.get(id) });
}

export function toContext(items, id, options = {}) {
  const { oldestFirst, parents } = inferParents(items);
  const convert = (item) =>
    toStatus(item, { ...options, parent: parents.get(item.id) });

  const ancestors = [];
  for (let up = parents.get(id); up; up = parents.get(up.id)) {
    ancestors.unshift(up);
  }

  const below = new Set([id]);
  const descendants = oldestFirst.filter((item) => {
    if (!below.has(parents.get(item.id)?.id)) return false;
    below.add(item.id);
    return true;
  });

  return {
    ancestors: ancestors.map(convert),
    descendants: descendants.map(convert),
  };
}

// masto.js pages by following `Link` headers, which Micro.blog doesn't send.
export function paginationLink(requestUrl, items) {
  const oldest = items.at(-1);
  if (!oldest) return undefined;
  const next = new URL(requestUrl);
  next.searchParams.delete('since_id');
  next.searchParams.delete('min_id');
  next.searchParams.set('max_id', oldest.id);
  return `<${next}>; rel="next"`;
}

// Profile feeds ignore before_id and return twice the requested count, so pages
// are cut here. Ids are 64-bit, hence BigInt.
export function pageItems(items, params) {
  const maxId = params.get('max_id');
  const limit = Number(params.get('limit')) || items.length;
  const older = maxId
    ? items.filter((item) => BigInt(item.id) < BigInt(maxId))
    : items;
  return older.slice(0, limit);
}

export function toNotification(item, options = {}) {
  const status = toStatus(item, options);
  return {
    id: item.id,
    type: 'mention',
    created_at: item.date_published,
    account: status.account,
    status,
  };
}

// Micro.blog only has mentions, so a filter for any other type is an empty list.
export function wantsMentions(params) {
  const types = params.getAll('types[]');
  if (types.length && !types.includes('mention')) return false;
  return !params.getAll('exclude_types[]').includes('mention');
}

export function readFields(contentType = '', text = '') {
  if (!text) return {};
  if (contentType.includes('application/json')) return JSON.parse(text);
  return Object.fromEntries(new URLSearchParams(text));
}

// Phanpy needs the created post back, and the reply response isn't documented.
export function findNewReply(items, knownIds) {
  return items.find(
    (item) => !knownIds.has(item.id) && item._microblog?.is_deletable,
  );
}

// A bookmark has its own id and no field for the post's. Only Micro.blog-hosted
// posts reveal it, in the URL; fediverse and external-blog posts don't.
export function bookmarkPostId(item) {
  return (
    item.url?.match(/^https:\/\/micro\.blog\/[^/]+\/(\d+)$/)?.[1] ?? item.id
  );
}

const HARMLESS_POST_FIELDS = new Set([
  'status',
  'in_reply_to_id',
  'language',
  'quote_approval_policy',
]);

const isEmpty = (value) =>
  value === null ||
  value === undefined ||
  value === '' ||
  value === false ||
  (Array.isArray(value) && value.length === 0);

// Micro.blog's reply API takes only an id and content, and everything is public.
// Dropping an option could publish what the author meant to limit, as when a
// private mention went out publicly, so anything unrecognised is refused.
export function unsupportedPostOption(fields) {
  if (!isEmpty(fields.visibility) && fields.visibility !== 'public') {
    return 'Micro.blog has no private posts, so this was not sent.';
  }
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'visibility' || HARMLESS_POST_FIELDS.has(name)) continue;
    if (!isEmpty(value)) return `Not sent: ${name} isn't supported on Micro.blog.`;
  }
  return null;
}
