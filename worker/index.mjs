import { handleProxy } from './proxy.mjs';

export default {
  async fetch(request, env) {
    return (
      (await handleProxy(request, {
        kv: env.MICROBLOG_KV,
        allowedUsers: env.MICROBLOG_ALLOWED_USERS,
      })) ??
      env.ASSETS.fetch(request)
    );
  },
};
