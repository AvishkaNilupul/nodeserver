const reserved = new Set([
  'activate', 'bits', 'checkout', 'clip', 'clips', 'collections', 'dashboard', 'directory',
  'downloads', 'drops', 'friends', 'inventory', 'jobs', 'login', 'logout', 'messages',
  'moderator', 'payments', 'popout', 'prime', 'products', 'search', 'settings', 'signup',
  'store', 'subscriptions', 'team', 'teams', 'turbo', 'videos', 'wallet'
]);

export function watchUrl(value) {
  const login = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(login) || reserved.has(login)) return '';
  return `https://www.twitch.tv/${login}#companion-watch`;
}

const form = globalThis.document?.getElementById('watch-channel-form');
if (form) {
  const input = document.getElementById('watch-channel');
  const error = document.getElementById('watch-error');
  input.addEventListener('input', () => { error.hidden = true; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const url = watchUrl(input.value);
    if (url) {
      location.assign(url);
    } else {
      error.textContent = 'Enter a Twitch channel name.';
      error.hidden = false;
      input.focus();
    }
  });
}
