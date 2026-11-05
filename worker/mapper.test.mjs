import assert from 'node:assert/strict';
import { test } from 'node:test';

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
  unsupportedPostOption,
  wantsMentions,
} from './mapper.mjs';

const item = (id, username, html, minute, extra = {}) => ({
  id,
  content_html: html,
  url: `https://micro.blog/${username}/${id}`,
  date_published: `2026-11-05T00:${String(minute).padStart(2, '0')}:00+00:00`,
  author: {
    name: username.toUpperCase(),
    url: `https://${username}.example`,
    avatar: `https://cdn.example/${username}.jpg`,
    _microblog: { username },
  },
  _microblog: { is_bookmark: false, is_deletable: false, ...extra },
});

const mention = (username) =>
  `<a href="https://micro.blog/${username}">@${username}</a>`;

test('toStatus fills every field Phanpy dereferences', () => {
  const status = toStatus(item('1', 'ann', '<p>Hi</p>', 1));
  assert.equal(status.id, '1');
  assert.equal(status.content, '<p>Hi</p>');
  assert.equal(status.created_at, '2026-11-05T00:01:00+00:00');
  assert.equal(status.account.acct, 'ann');
  assert.equal(status.visibility, 'public');
  assert.deepEqual(status.media_attachments, []);
  assert.deepEqual(status.emojis, []);
  assert.equal(status.reblog, null);
  assert.equal(status.spoiler_text, '');
});

test('toStatus carries bookmark state from the post', () => {
  const status = toStatus(item('1', 'ann', '<p>Hi</p>', 1, { is_bookmark: true }));
  assert.equal(status.bookmarked, true);
});

test('toStatus lists mentions so Phanpy can link them', () => {
  const status = toStatus(item('2', 'bob', `<p>${mention('ann')} yes</p>`, 2));
  assert.deepEqual(
    status.mentions.map((m) => m.acct),
    ['ann'],
  );
});

test('toStatus moves inline images into media attachments', () => {
  const html =
    '<p>Pumpkins</p>\n<img src="https://cdn.example/a.jpg" width="600" height="400" alt="A pumpkin" loading="lazy">';
  const status = toStatus(item('5', 'ann', html, 5), { extractImages: true });
  assert.equal(status.content, '<p>Pumpkins</p>');
  assert.equal(status.media_attachments.length, 1);
  const [media] = status.media_attachments;
  assert.equal(media.type, 'image');
  assert.equal(media.url, 'https://cdn.example/a.jpg');
  assert.equal(media.description, 'A pumpkin');
  assert.deepEqual(media.meta.original, { width: 600, height: 400, aspect: 1.5 });
});

test('toStatus leaves inline images alone unless asked', () => {
  const html = '<p>Pumpkins</p><img src="https://cdn.example/a.jpg">';
  const status = toStatus(item('5', 'ann', html, 5));
  assert.equal(status.content, html);
  assert.deepEqual(status.media_attachments, []);
});

test('toStatus reads Mastodon-style mention markup', () => {
  const html =
    '<p><span class="h-card"><a href="https://social.coop/@dajb" class="u-url mention">@<span>dajb</span></a></span> hi</p>';
  const status = toStatus(item('6', 'manton', html, 6));
  assert.deepEqual(status.mentions.map((m) => m.acct), ['dajb']);
});

test('toAccount uses the username as the id and adds profile fields', () => {
  const account = toAccount(
    { name: 'Ann', url: 'https://ann.example', avatar: 'https://a/a.jpg' },
    { username: 'ann', bio: 'Hello', following_count: 3 },
  );
  assert.equal(account.id, 'ann');
  assert.equal(account.username, 'ann');
  assert.equal(account.display_name, 'Ann');
  assert.equal(account.note, 'Hello');
  assert.equal(account.following_count, 3);
  assert.equal(account.avatar_static, 'https://a/a.jpg');
});

test('toContext splits a newest-first list around the focused post', () => {
  const items = [
    item('3', 'ann', `<p>${mention('bob')} three</p>`, 3),
    item('2', 'bob', `<p>${mention('ann')} two</p>`, 2),
    item('1', 'ann', '<p>one</p>', 1),
  ];
  const { ancestors, descendants } = toContext(items, '2');
  assert.deepEqual(ancestors.map((s) => s.id), ['1']);
  assert.deepEqual(descendants.map((s) => s.id), ['3']);
});

test('toContext infers a reply parent from the leading mention', () => {
  const items = [
    item('4', 'cat', `<p>${mention('ann')} four</p>`, 4),
    item('3', 'bob', `<p>${mention('ann')} three</p>`, 3),
    item('2', 'ann', `<p>${mention('bob')} two</p>`, 2),
    item('1', 'bob', '<p>one</p>', 1),
  ];
  const { descendants } = toContext(items, '1');
  const parents = Object.fromEntries(
    descendants.map((s) => [s.id, s.in_reply_to_id]),
  );
  assert.deepEqual(parents, { 2: '1', 3: '2', 4: '2' });
});

test('toContext falls back to the root when the mention matches no one', () => {
  const items = [
    item('2', 'bob', `<p>${mention('zed')} two</p>`, 2),
    item('1', 'ann', '<p>one</p>', 1),
  ];
  const { descendants } = toContext(items, '1');
  assert.equal(descendants[0].in_reply_to_id, '1');
});

test('toContext matches a bare mention to a fediverse author', () => {
  const items = [
    item('3', 'ann', '<p><a href="https://social.coop/@dajb" class="mention">@<span>dajb</span></a> three</p>', 3),
    item('2', 'dajb@social.coop', '<p>two</p>', 2),
    item('1', 'ann', '<p>one</p>', 1),
  ];
  const { descendants } = toContext(items, '1');
  const parents = Object.fromEntries(
    descendants.map((s) => [s.id, s.in_reply_to_id]),
  );
  assert.equal(parents[3], '2');
});

test('paginationLink points the next page before the oldest post', () => {
  const link = paginationLink('http://localhost:4010/api/v1/timelines/home?limit=20', [
    { id: '9' },
    { id: '5' },
  ]);
  assert.equal(
    link,
    '<http://localhost:4010/api/v1/timelines/home?limit=20&max_id=5>; rel="next"',
  );
});

test('paginationLink is absent on an empty page, which ends the iterator', () => {
  assert.equal(paginationLink('http://localhost:4010/x', []), undefined);
});

test('pageItems drops posts at or after max_id, which profile feeds ignore', () => {
  const items = [{ id: '9' }, { id: '7' }, { id: '5' }, { id: '3' }];
  const page = pageItems(items, new URLSearchParams({ max_id: '7' }));
  assert.deepEqual(page.map((i) => i.id), ['5', '3']);
});

test('pageItems compares ids numerically, not as text', () => {
  const items = [{ id: '100' }, { id: '99' }];
  const page = pageItems(items, new URLSearchParams({ max_id: '100' }));
  assert.deepEqual(page.map((i) => i.id), ['99']);
});

test('pageItems trims to the limit, which count does not guarantee', () => {
  const items = [{ id: '9' }, { id: '7' }, { id: '5' }];
  const page = pageItems(items, new URLSearchParams({ limit: '2' }));
  assert.deepEqual(page.map((i) => i.id), ['9', '7']);
});

test('toStatus turns custom emoji images into shortcodes, not media', () => {
  const html =
    '<p>Hi <img src="https://cdn.example/blob.png" alt="blob" class="custom_emoji" width="20" height="20"></p>';
  const status = toStatus(item('7', 'ann', html, 7), { extractImages: true });
  assert.equal(status.content, '<p>Hi :blob:</p>');
  assert.deepEqual(status.media_attachments, []);
  assert.deepEqual(status.emojis, [
    {
      shortcode: 'blob',
      url: 'https://cdn.example/blob.png',
      static_url: 'https://cdn.example/blob.png',
      visible_in_picker: false,
    },
  ]);
});

test('toNotification presents a mention with its author and post', () => {
  const notification = toNotification(item('8', 'bob', '<p>Hi</p>', 8));
  assert.equal(notification.id, '8');
  assert.equal(notification.type, 'mention');
  assert.equal(notification.created_at, '2026-11-05T00:08:00+00:00');
  assert.equal(notification.account.acct, 'bob');
  assert.equal(notification.status.id, '8');
});

test('wantsMentions honours Phanpy type filters', () => {
  const query = (text) => new URLSearchParams(text);
  assert.equal(wantsMentions(query('')), true);
  assert.equal(wantsMentions(query('types[]=mention')), true);
  assert.equal(wantsMentions(query('types[]=follow')), false);
  assert.equal(wantsMentions(query('exclude_types[]=mention')), false);
  assert.equal(wantsMentions(query('exclude_types[]=follow')), true);
});

test('readFields parses both JSON and form bodies', () => {
  assert.deepEqual(
    readFields('application/json', '{"status":"Hi","in_reply_to_id":"1"}'),
    { status: 'Hi', in_reply_to_id: '1' },
  );
  assert.deepEqual(
    readFields('application/x-www-form-urlencoded; charset=utf-8', 'status=Hi&in_reply_to_id=1'),
    { status: 'Hi', in_reply_to_id: '1' },
  );
  assert.deepEqual(readFields('application/json', ''), {});
});

test('findNewReply picks the newest post of mine not seen before', () => {
  const items = [
    item('4', 'bob', '<p>Not mine</p>', 4),
    item('3', 'me', '<p>New</p>', 3, { is_deletable: true }),
    item('2', 'me', '<p>Older</p>', 2, { is_deletable: true }),
    item('1', 'bob', '<p>Root</p>', 1),
  ];
  assert.equal(findNewReply(items, new Set(['1', '2'])).id, '3');
  assert.equal(findNewReply(items, new Set(['1', '2', '3', '4'])), undefined);
});

test('bookmarkPostId reads the post id from a Micro.blog-hosted URL', () => {
  const bookmark = { id: '10157054', url: 'https://micro.blog/CTD/10134408' };
  assert.equal(bookmarkPostId(bookmark), '10134408');
});

test('bookmarkPostId keeps the bookmark id when the URL has no post id', () => {
  const fediverse = {
    id: '100367361',
    url: 'https://aus.social/users/nighthawk/statuses/117548881100007265',
  };
  const blog = { id: '8621185', url: 'https://adrian.example/micro/2020/03/16.html' };
  assert.equal(bookmarkPostId(fediverse), '100367361');
  assert.equal(bookmarkPostId(blog), '8621185');
});

test('unsupportedPostOption refuses any field it does not recognise', () => {
  assert.match(unsupportedPostOption({ status: 'Hi', new_field: 'x' }), /new_field/);
});

test('unsupportedPostOption ignores empty values and known harmless fields', () => {
  assert.equal(
    unsupportedPostOption({
      status: 'Hi',
      in_reply_to_id: '1',
      language: 'en',
      quote_approval_policy: 'public',
      visibility: 'public',
      spoiler_text: '',
      sensitive: false,
      media_ids: [],
      poll: null,
    }),
    null,
  );
});
