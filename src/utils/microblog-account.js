import { isMicroblogNodeInfo } from './microblog';
import store from './store';
import { getCurrentAccount } from './store-utils';

// Reads the store directly because getCurrentNodeInfo() caches for the page's
// lifetime, and signing in changes the account without a reload.
export function updateMicroblogClass() {
  const instance = getCurrentAccount()?.instanceURL?.toLowerCase();
  const nodeInfo = store.local.getJSON('nodeInfos')?.[instance];
  document.documentElement.classList.toggle(
    'is-microblog',
    isMicroblogNodeInfo(nodeInfo),
  );
}
