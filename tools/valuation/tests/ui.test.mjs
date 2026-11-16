import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const js=fs.readFileSync(path.join(root,'public','app.js'),'utf8');
const css=fs.readFileSync(path.join(root,'public','styles.css'),'utf8');

const home=html.indexOf('id="navHome"');
const fresh=html.indexOf('id="navNewValuation"');
const saved=html.indexOf('id="navSavedValuations"');
assert(home>=0 && fresh>home && saved>fresh,'bottom nav must be Home → New valuation → Saved valuations');
assert.match(html,/aria-label="Valuation sections"/);
assert.doesNotMatch(html,/id="navHome"[\s\S]{0,260}<span class="nav-label">Home<\/span>/,'Valuation Home is icon-only');
assert.match(css,/\.bottom-nav\{/,'valuation uses the DriveHub bottom pill navigation');
assert.match(js,/drivehub\.valuation\.saved\.v1/,'saved valuations have dedicated persistent storage');
assert.match(js,/Save valuation/,'completed valuations expose a save action');
assert.match(js,/Done \$\{esc\(fmtDate/,'saved cards show when the valuation was done');
assert.match(js,/data-refresh-saved/,'saved valuations expose refresh actions');
assert.match(js,/valuedAt:data\.updatedAt\|\|now/,'refresh updates the existing saved valuation timestamp');
assert.match(js,/previousValuation:previous/,'saved valuation refresh preserves the previous market snapshot');
assert.match(js,/valuationMovementMarkup/,'saved valuations surface price movement between checks');
assert.match(js,/data-retry-valuation/,'valuation failures expose a persistent retry action rather than only a toast');
assert.match(css,/\.valuation-movement\.up/,'valuation history has distinct movement treatment');
assert.match(css,/\.valuation-error/,'valuation uses the shared recoverable error state');
assert.match(html,/styles\.css\?v=14221/,'Valuation uses the v142.12 asset cache key');
assert.match(js,/drivehub\.valuation\.prefillVehicleId/,'Valuation accepts a vehicle handoff from MyGarage');
assert.match(js,/DriveHubChrome\?\.beginActivity\?\.\('Checking market…'\)/,'market valuation participates in shared busy feedback');

assert.match(js,/function valuationConfidenceInfo\(val=\{\}\)/,'valuation results explain confidence using evidence rather than a label alone');
assert.match(js,/function mileageEvidenceMarkup\(val=\{\}\)/,'valuation evidence explains mileage normalisation');
assert.match(js,/function valuationHistoryMarkup\(item\)/,'saved valuation detail exposes recent valuation history');
assert.match(css,/\.valuation-trust\{/,'valuation result surfaces evidence strength at a glance');
assert.match(css,/\.valuation-history__rows\{/,'saved valuation history has a compact readable treatment');
assert.match(js,/DriveHubChrome\?\.showStatus/,'valuation outcomes prefer the shared DriveHub status surface');

assert.match(js,/const DRIVEHUB_HOST_CONTEXT=\(\(\)=>\{/,'Valuation resolves an explicit DriveHub host context');
assert.match(js,/parent\.location\.origin/,'embedded Valuation can inherit the parent DriveHub origin when needed');
assert.match(js,/DRIVEHUB_API_URL/,'Valuation uses an explicit API URL derived from the real DriveHub host');
assert.match(js,/static-only deployment/,'Valuation distinguishes a missing live API from local file mode');
assert.match(js,/data-open-garage/,'saved-car valuations expose a direct MyGarage next action');
assert.match(js,/parent\.postMessage\(\{type:'drivehub-open',tool:'garage'\}/,'Valuation can hand back to MyGarage in the standalone shell');
console.log('Valuation UI tests passed');

assert.match(css,/@media\(min-width:900px\)[\s\S]*880px/,'valuation desktop canvas is no longer phone-width');

assert.match(css,/\.tool-head\{display:block/,'valuation hero must not retain the obsolete back-button grid');
assert.doesNotMatch(css,/\.tool-head\{[^}]*grid-template-columns:44px/,'valuation hero text must not be constrained to the removed back-button column');
