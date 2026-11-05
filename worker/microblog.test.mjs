import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isMicroblogNodeInfo,
  microblogSupports,
  resolveLoginInstance,
} from '../src/utils/microblog.js';

test('isMicroblogNodeInfo recognises the software the Worker reports', () => {
  assert.equal(
    isMicroblogNodeInfo({ software: { name: 'microdotblog' } }),
    true,
  );
});

test('isMicroblogNodeInfo is false for anything else or nothing', () => {
  assert.equal(isMicroblogNodeInfo({ software: { name: 'mastodon' } }), false);
  assert.equal(isMicroblogNodeInfo({}), false);
  assert.equal(isMicroblogNodeInfo(undefined), false);
});

test('microblogSupports keeps only mentions and bookmarks', () => {
  assert.equal(microblogSupports('@mastodon/mentions'), true);
  assert.equal(microblogSupports('@mastodon/post-bookmark'), true);
  for (const feature of [
    '@mastodon/lists',
    '@mastodon/filters',
    '@mastodon/trending-hashtags',
    '@mastodon/trending-links',
    '@mastodon/post-edit',
    '@mastodon/profile-edit',
    '@mastodon/profile-private-note',
    '@mastodon/pinned-posts',
  ]) {
    assert.equal(microblogSupports(feature), false, feature);
  }
});

test('resolveLoginInstance sends micro.blog to the proxy on this host', () => {
  const host = 'phanpy.example.workers.dev';
  assert.equal(resolveLoginInstance('micro.blog', host), host);
  assert.equal(resolveLoginInstance('Micro.Blog', host), host);
  assert.equal(resolveLoginInstance('https://micro.blog/', host), host);
  assert.equal(resolveLoginInstance(' micro.blog ', host), host);
});

test('resolveLoginInstance leaves every other server alone', () => {
  const host = 'phanpy.example.workers.dev';
  assert.equal(resolveLoginInstance('aus.social', host), 'aus.social');
  assert.equal(resolveLoginInstance(host, host), host);
  // Only the exact service: this is someone's own server, not Micro.blog's API.
  assert.equal(
    resolveLoginInstance('mastodon.micro.blog', host),
    'mastodon.micro.blog',
  );
});
