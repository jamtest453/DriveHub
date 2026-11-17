import fs from 'node:fs';
import assert from 'node:assert/strict';
const css=fs.readFileSync(new URL('../public/drivehub-chrome.css',import.meta.url),'utf8');
const js=fs.readFileSync(new URL('../public/drivehub-chrome.js',import.meta.url),'utf8');
const runtime=fs.readFileSync(new URL('../public/drivehub-runtime.js',import.meta.url),'utf8');
const gatewayHtml=fs.readFileSync(new URL('../../gateway/public/index.html',import.meta.url),'utf8');
const gatewayJs=fs.readFileSync(new URL('../../gateway/public/app.js',import.meta.url),'utf8');

assert.match(css,/@media \(min-width:900px\)/,'shared chrome must define wide-screen navigation');
assert.match(css,/\.drivehub-desktop-nav\{[\s\S]*position:fixed;[\s\S]*inset:0 0 auto 0/,'wide-screen navigation is a separate full-width application bar');
assert.match(css,/\.drivehub-desktop-nav\{[\s\S]*justify-content:center/,'desktop branding and navigation are centered as one group');
assert.match(css,/\.drivehub-desktop-nav__brand\{[\s\S]*flex:0 0 auto;[\s\S]*margin:0/,'desktop brand no longer pushes navigation to the far edge');
assert.match(css,/\.drivehub-desktop-nav__brand\{/,'desktop navigation exposes DriveHub + tool context');
assert.match(js,/viewBox=\"0 0 512 512\"/,'desktop navigation uses the real DriveHub logo mark');
assert.match(css,/font:800 12\.5px\/1/, 'desktop navigation labels have readable wide-screen sizing');
assert.match(css,/\.drivehub-desktop-nav__item \.nav-label\{display:inline!important/,'wide-screen nav should show labels');
assert.match(css,/\.drivehub-desktop-nav__item\.gateway-home[\s\S]*\.nav-label\{display:none!important/,'Home stays icon-only');
assert.match(css,/\.bottom-nav\{display:none!important\}/,'mobile bottom navigation is hidden, not restyled, on wide screens');
assert.match(css,/body\[data-view="edit"\] \.organic-edit-head\{[\s\S]*padding-top:calc\(var\(--dh-top-nav-height\) \+ 28px\)!important/,'MyGarage edit headers clear the fixed desktop navigation with deliberate spacing');
assert.match(js,/proxy\.addEventListener\('click',\(\)=>original\.click\(\)\)/,'desktop items proxy the tool-owned navigation controls');
assert.match(js,/new MutationObserver\(syncDesktopNav\)/,'desktop active state stays synchronized with the source navigation');
assert.match(css,/\.drivehub-activity__spinner/,'shared shell provides consistent busy feedback');
assert.match(css,/drivehub-activity\[data-state="success"\]/,'shared status surface supports success outcomes');
assert.match(css,/drivehub-activity\[data-state="error"\]/,'shared status surface supports error outcomes');
assert.match(js,/const showStatus=/,'shared shell exposes a single transient outcome API');
assert.match(js,/release\.update=/,'shared activities update in place instead of being recreated');
assert.match(js,/if\(latest\)\{[\s\S]*activity\.dataset\.state='working'/,'working activity takes priority over queued outcomes');
assert.match(js,/if\(transient\)\{[\s\S]*scheduleTransientHide/,'queued outcomes appear only after work has finished');
assert.match(js,/drivehubChrome==='14235'/,'shared shell uses the v142.35 initialization guard');
assert.match(js,/beginActivity/,'shared shell exposes a reusable concurrent activity API');
assert.match(runtime,/apiUrl\(path\)/,'shared runtime centralises API routing for browser and native shells');
assert.match(runtime,/notifyAppReady/,'shared runtime confirms healthy native OTA bundles');
assert.match(js,/drivehub-desktop-nav/,'shared shell builds an independent desktop application bar');
assert.match(js,/brand\.addEventListener\('click',goHome/,'desktop DriveHub identity is a working Home control');
assert.match(js,/drivehub\.lastTool\.v1/,'shared shell records the last tool for gateway continuity');
assert.match(css,/\.dh-state\{/,'shared shell exposes a common recovery and empty-state pattern');
assert.match(js,/Offline — saved data is still available/,'shared shell must expose offline feedback');
for(const rel of ['../../tools/my-garage/public/index.html','../../tools/valuation/public/index.html','../../tools/road-finder/public/index.html']){
  const html=fs.readFileSync(new URL(rel,import.meta.url),'utf8');
  assert.match(html,/shared\/public\/drivehub-chrome\.css\?v=14235/,'every tool must load shared desktop chrome');
  assert.match(html,/shared\/public\/drivehub-chrome\.js\?v=14235/,'every tool must load shared resilience behaviour');
  assert.match(html,/shared\/public\/drivehub-runtime\.js\?v=14221/,'every tool must load shared browser/native runtime');
}
assert.match(gatewayHtml,/id="garage-live-status"/,'gateway surfaces MyGarage readiness');
assert.match(gatewayHtml,/id="valuation-live-status"/,'gateway surfaces Valuation readiness');
assert.match(gatewayHtml,/id="roads-live-status"/,'gateway surfaces Road Finder readiness');
assert.match(gatewayJs,/drivehub\.valuation\.saved\.v1/,'gateway surfaces saved valuation continuity');
assert.match(gatewayJs,/indexedDB\.databases/,'gateway checks Road Finder cache without creating a stale IndexedDB schema');
assert.match(gatewayJs,/\/api\/integrations\/status/,'hosted gateway reports live integration readiness');
assert.match(gatewayHtml,/id="resume-tool"/,'gateway exposes a recent-tool continuation action');
assert.match(gatewayJs,/Continue in \$\{recent\.label/,'gateway labels the continuation action with the last tool');
console.log('Shared DriveHub chrome tests passed');

assert.match(js,/ensureGlobalHeader=/,'every page gets the same shared header');
assert.match(js,/path\.startsWith\('\/search\/'\)/,'Car Search header uses the shared route context');
assert.match(css,/v142\.27 · Shared DriveHub header/,'same light DriveHub design is used across tools');
assert.match(gatewayHtml,/drivehub-chrome\.js\?v=14235/,'the home page also loads the shared header');

assert.match(js,/const findSearchNav=/,'Car Search header reads the live saved search navigation');
assert.match(js,/searchFrame=frame/,'embedded Car Search frame is connected to the shared header');
assert.match(js,/searchDoc.getElementById\(id\)\?\.click\(\)/,'Car Search header actions trigger original handlers');
assert.doesNotMatch(js,/Open full screen/,'Car Search must not offer a separate full-screen link');
assert.match(css,/\.drivehub-search-select\{/,'saved searches are available as a compact header dropdown');
assert.match(css,/\.drivehub-desktop-nav__actions\{display:flex!important/,'tool actions remain in the header on phones');

assert.match(css,/v142\.28: keep branding/,'all tool actions use a single header row');
assert.match(css,/\.bottom-nav \.gateway-home\{display:none!important\}/,'only the shared logo serves as DriveHub Home');
assert.match(js,/\.nav-btn:not\(\.gateway-home\)/,'duplicated Home items are not mirrored into the header');

assert.match(css,/\.drivehub-desktop-nav__actions > :first-child\{\s*margin-left:auto!important/,
  'first visible navigation control pushes the tablet group to the right edge');
assert.match(css,/\.drivehub-search-select\{margin-left:auto!important\}/,
  'tablet Search selector is right aligned even when desktop tabs are hidden');
