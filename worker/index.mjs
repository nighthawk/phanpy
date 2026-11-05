import { handleProxy } from './proxy.mjs';

export default {
  async fetch(request, env) {
    return (await handleProxy(request)) ?? env.ASSETS.fetch(request);
  },
};
