export const REMOTE_BASE_PATH = '/admin/stream-companion';

export function controllerBasePath(value = '') {
  if (value === '' || value === REMOTE_BASE_PATH) return value;
  throw new Error('Unsupported controller mount.');
}

export function basePathFromModule(moduleUrl) {
  const url = new URL(moduleUrl);
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  if (/^\/(?:app|accounts|clips|messages|controller-path)\.js$/.test(url.pathname)) return '';
  if (new RegExp(`^${REMOTE_BASE_PATH}/(?:app|accounts|clips|messages|controller-path)\\.js$`).test(url.pathname)) return REMOTE_BASE_PATH;
  throw new Error('Unsupported controller module location.');
}

export function controllerPath(basePath, path) {
  const base = controllerBasePath(basePath);
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('//') || /[?#\\%]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid controller path.');
  return `${base}${path}`;
}

export function responseError(response) {
  return Object.assign(new Error('Controller request did not complete.'), { status: response?.status });
}

export function requestNetwork(error) {
  return error?.status === 401 ? 'unauthenticated' : error?.status === 403 ? 'forbidden' : 'offline';
}

export function networkTitle(network, basePath = '') {
  if (network === 'unauthenticated') return 'Sign-in required';
  if (network === 'forbidden') return 'Access or 2FA required';
  if (network === 'offline') return basePath ? 'Mac unavailable' : 'Host unavailable';
  return network === 'stale' ? 'Status stale' : network === 'online' ? 'Host online' : 'Connecting';
}

export function connectionMessage(network, basePath = '', hasData = false) {
  if (network === 'unauthenticated') return 'Your server session has ended. Sign in again before using the controller. Requests are not replayed after sign-in.';
  if (network === 'forbidden') return 'Controller access is blocked. Check your server permissions and complete two-factor setup if required. No command will be retried automatically.';
  if (network === 'offline' && basePath) return 'The Mac controller is unreachable. The Mac may be asleep or its connection may be down. Last reported values are unverified; commands are not retried automatically.';
  if (network === 'offline') return hasData ? 'Showing last known data. Controls are held until the host has a fresh response.' : 'Cannot reach the local host. Account status and controls are unavailable.';
  if (network === 'stale') return 'Showing last reported data. Controls wait for a fresh host response.';
  return '';
}

export function configureControllerMount(document, basePath = '') {
  const link = document.getElementById('back-to-server');
  if (link) link.hidden = controllerBasePath(basePath) === '';
}

// Restoration resumes only reads. Pending mutation outcomes stay in the
// controller and reconcile through status; no event replays an action.
export function bindControllerLifecycle(controller, { document = globalThis.document, window = globalThis } = {}) {
  const visible = () => { if (!document.hidden) void controller.refresh(); };
  const hide = () => controller.stop();
  const show = () => { controller.start(); void controller.refresh(); };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  return () => {
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
  };
}
