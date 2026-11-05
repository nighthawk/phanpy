import { isMicroblogNodeInfo } from './microblog';
import store from './store';
import { getCurrentAccount } from './store-utils';

// Reads the store directly because getCurrentNodeInfo() caches for the page's
// lifetime, and signing in changes the account without a reload.
export function isMicroblogAccount() {
  const instance = getCurrentAccount()?.instanceURL?.toLowerCase();
  return isMicroblogNodeInfo(store.local.getJSON('nodeInfos')?.[instance]);
}

export function updateMicroblogClass() {
  document.documentElement.classList.toggle(
    'is-microblog',
    isMicroblogAccount(),
  );
}
