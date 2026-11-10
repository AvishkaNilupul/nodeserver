#!/usr/bin/env node
// Builds the Firefox for Android copy of the Epic Claim Helper from the Chrome
// helper's source, so both run the same claim logic:
//  - every `chrome.` API call becomes `ext.` (compat.js points `ext` at
//    Firefox's `browser` API and stands in for browsingData),
//  - the manifest gets a background page instead of a service worker, a gecko
//    id, and the cookies permission with *.epicgames.com access (for clearing
//    Epic's cookies before each claim).
//  - Android-only phone-visible.js tells the phone bridge while a helper page
//    is on screen (see phone/phone-bridge.cjs).
// The version is the Chrome helper's plus ".<ANDROID_REV>"; bump ANDROID_REV
// when only the Android parts change, so Firefox accepts the update.
// Usage: node build.cjs [chrome-helper-dir]   (default ../epic-claim-helper)
// Output: dist/ and epic-claim-helper-android-<version>.xpi, unsigned: install
// it in Firefox Nightly with xpinstall.signatures.required=false.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ANDROID_REV = 4;
const here = __dirname;
const src = path.resolve(process.argv[2] || path.join(here, '..', 'epic-claim-helper'));
const dist = path.join(here, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const scripts = new Set([manifest.background.service_worker]);
for (const cs of manifest.content_scripts) cs.js.forEach(f => scripts.add(f));
for (const file of scripts) {
  const code = fs.readFileSync(path.join(src, file), 'utf8');
  let out = code.replace(/\bchrome\.(?=[a-z])/g, 'ext.');
  // Firefox's background page can poll promptly while the phone is awake.
  // The shared in-flight guard still guarantees one poll/job at a time.
  if (file === manifest.background.service_worker) out += '\nsetInterval(pollBrowserClaims, 5000);\n';
  // Keep the assigned job alive while the person completes a visible check.
  // Ending it immediately loses the context needed to click the free checkout.
  if (file === 'epic-claim-checkout.js') {
    out = out.replace('problemSince=0;', 'problemSince=0,challengeSeen=false;');
    const immediate = "if(/one more step|please complete a security check/i.test(text))return report('needs_captcha','Complete the visible security check in the claim tab');";
    if (!out.includes(immediate)) throw Error('Android security-check patch no longer matches source');
    out = out.replace(immediate, "if(/one more step|please complete a security check/i.test(text)){challengeSeen=true;return;}");
    out = out.replace("report('error',(clicked?", "report(challengeSeen?'needs_captcha':'error',(clicked?");
  }
  if (/\bchrome\.[a-z]/.test(out)) throw Error(file + ': chrome. call left after rewrite');
  fs.writeFileSync(path.join(dist, file), out);
}
for (const file of ['compat.js', 'phone-visible.js']) fs.copyFileSync(path.join(here, file), path.join(dist, file));
fs.copyFileSync(path.join(here, 'phone/phone-awake.js'), path.join(dist, 'phone-awake.js'));

manifest.name += ' (Android)';
manifest.version += '.' + ANDROID_REV;
manifest.background = { scripts: ['compat.js', manifest.background.service_worker] };
manifest.permissions = manifest.permissions.filter(p => p !== 'browsingData').concat('cookies');
manifest.host_permissions = [...new Set([...manifest.host_permissions, 'https://*.epicgames.com/*'])];
// Page-world scripts never see extension APIs, so they get no shim.
for (const cs of manifest.content_scripts) if (cs.world !== 'MAIN') cs.js = ['compat.js', ...cs.js];
manifest.content_scripts.push({
  matches: ['http://127.0.0.1/*', 'https://*.epicgames.com/*'],
  js: ['compat.js', 'phone-awake.js', 'phone-visible.js'],
  run_at: 'document_idle',
});
manifest.browser_specific_settings = {
  gecko: { id: 'epic-claim-helper-android@nodeserver.local', strict_min_version: '128.0' },
  gecko_android: { strict_min_version: '128.0' },
};
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const xpi = path.join(here, 'epic-claim-helper-android-' + manifest.version + '.xpi');
fs.rmSync(xpi, { force: true });
execFileSync('zip', ['-q', '-X', '-r', xpi, '.'], { cwd: dist });
console.log('built ' + path.basename(xpi) + ' from ' + src);
