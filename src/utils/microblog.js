// Mastodon features that still make sense on Micro.blog.
const MICROBLOG_FEATURES = new Set([
  '@mastodon/mentions',
  '@mastodon/post-bookmark',
]);

export function isMicroblogNodeInfo(nodeInfo) {
  return nodeInfo?.software?.name === 'microdotblog';
}

export function microblogSupports(feature) {
  return MICROBLOG_FEATURES.has(feature);
}

// micro.blog itself rejects the Mastodon API, so signing in goes through the proxy
// on this host. People will reasonably type the name of the service they use.
export function resolveLoginInstance(instance, ownHost) {
  const normalized = instance
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return normalized === 'micro.blog' ? ownHost : instance;
}
