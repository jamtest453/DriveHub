import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=fs.readFileSync(path.join(root,'public','js','app.js'),'utf8');
const bundle=fs.readFileSync(path.join(root,'public','js','app.bundle.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const designCss=fs.readFileSync(path.join(root,'public','css','design-system.css'),'utf8');
for(const source of [app,bundle]){
  assert.match(source,/function timelinePeriod\(a\).*return 'today'/,'Timeline classifies events dated today separately from past and upcoming');
  assert.match(source,/const today=items\.filter\(a=>timelinePeriod\(a\)==='today'\)/,'Timeline builds a dedicated Today event group');
  assert.match(source,/story-period-label today"><span>Today<\/span>/,'Timeline renders an explicit Today section');
  assert.match(source,/\$\{upcomingHtml\}\$\{todayHtml\}\$\{divider\}\$\{pastHtml\}/,'Today sits between Upcoming and Past in the Timeline');
}
assert.match(designCss,/\.story-period-label\.today/,'Today has a deliberate Timeline section treatment');
assert.match(designCss,/\.mot-history-page>\*/,'MOT history direct children are allowed to shrink inside the mobile viewport');
assert.match(designCss,/\.mot-history-chart-card \.mileage-chart-wrap\{[\s\S]*max-width:100%[\s\S]*overflow-x:auto/,'The wide MOT mileage chart scrolls inside its card instead of widening the page');
for(const source of [app,bundle]){
  assert.match(source,/class=\"nav-btn gateway-home\"[^`]+aria-label=\"DriveHub home\"/,'MyGarage exposes an accessible Home nav item');
  assert.doesNotMatch(source,/gateway-home[^`]+<span class=\"nav-label\">DriveHub<\/span>/,'MyGarage Home is icon-only');
  assert.match(source,/M3 11\.5 12 4l9 7\.5/,'MyGarage uses the same Home icon geometry as the other tools');
}
assert.match(html,/app\.bundle\.js\?v=14221/,'MyGarage ships a fresh bundle cache key for the nav change');
assert.match(html,/design-system\.css\?v=14221/,'MyGarage busts the CSS cache for desktop cursor affordances');
assert.match(designCss,/Garage v141\.28 — consistent desktop interaction cursors/,'MyGarage defines a shared desktop cursor affordance rule');
assert.match(designCss,/--color-bg:#f6f4ef;/,'MyGarage uses the warm off-white app canvas rather than the previous green-tinted background');
assert.doesNotMatch(designCss,/--color-bg:#e9f0ee;/,'MyGarage no longer uses the green-tinted canvas token');
assert.match(designCss,/button:not\(:disabled\)[\s\S]*cursor:pointer/,'Enabled buttons consistently use the pointer cursor on mouse/trackpad devices');
assert.match(designCss,/\[data-nav\]:not\(:disabled\)/,'Delegated navigation controls inherit the same pointer affordance');
assert.match(bundle,/id=\"open-valuation-tool\"/,'MyGarage overview exposes a dedicated Valuation handoff');
assert.match(bundle,/drivehub\.valuation\.prefillVehicleId/,'MyGarage carries vehicle context into the Valuation Tool');
assert.match(bundle,/openDriveHubTool\('valuation'\)/,'MyGarage opens Valuation through the shared DriveHub tool handoff');
assert.match(bundle,/id="open-road-finder"/,'MyGarage overview exposes a Road Finder handoff');
assert.match(bundle,/openDriveHubTool\('roads'\)/,'MyGarage can open Road Finder through the shared tool handoff');
assert.match(bundle,/DriveHubChrome\?\.beginActivity\?\.\(message\|\|'Checking vehicle details…'\)/,'vehicle lookup participates in shared busy feedback');
assert.match(bundle,/Google Drive took too long to respond\. Try again\./,'Google Drive sync fails cleanly instead of hanging');
assert.match(bundle,/service-worker\.js\?v=14221/,'MyGarage asks the browser for the current service worker');
const worker=fs.readFileSync(path.join(root,'public','service-worker.js'),'utf8');
assert.match(worker,/drivehub-mygarage-v14221/,'MyGarage shell cache is versioned with the consolidation release');
assert.match(worker,/styles\.css\?v=14221/,'MyGarage service worker preloads the current shell assets');
assert.match(worker,/app\.bundle\.js\?v=14221/,'MyGarage service worker precaches the bundle actually executed by the page');
assert.match(worker,/drivehub-runtime\.js\?v=14221/,'MyGarage offline shell includes the shared native-aware runtime');

for(const source of [app,bundle]){
  assert.match(source,/data-notifications-master/,'MyGarage exposes a global notifications switch');
  assert.match(source,/data-notification-channel=\"browser\"/,'MyGarage exposes a Browser notifications child toggle');
  assert.match(source,/data-notification-channel=\"email\"/,'MyGarage exposes an Email notifications child toggle');
  assert.match(source,/Coming later · native Android notifications/,'MyGarage reserves the future App notification channel');
  assert.match(source,/requestBrowserNotificationPermission/,'Browser notification permission is requested only through the notification workflow');
  assert.match(source,/buildEmailReminderSchedule/,'MyGarage builds a minimal schedule for background email delivery');
  assert.match(source,/buildPushReminderSchedule/,'MyGarage builds the same minimal schedule for Web Push delivery');
  assert.match(source,/PushManager/,'MyGarage uses the browser Push API for background notifications');
  assert.match(source,/notificationApi\('push\/register'/,'MyGarage registers browser PushSubscriptions through the hosted relay');
  assert.match(source,/notificationApi\('push\/sync'/,'MyGarage syncs Web Push schedules through the hosted relay');
  assert.match(source,/notificationApi\('sync'/,'MyGarage syncs email schedules through the hosted relay API');
  assert.match(source,/Browser reminders use genuine Web Push/,'MyGarage explains that browser reminders work while DriveHub is closed');
  assert.doesNotMatch(source,/checked while DriveHub is open/,'MyGarage no longer describes Browser notifications as foreground-only');
}
assert.match(worker,/addEventListener\('push'/,'MyGarage service worker receives genuine Web Push events');
assert.match(worker,/showNotification/,'MyGarage service worker displays Web Push notifications');
assert.match(worker,/notificationclick/,'MyGarage service worker can focus the app from a browser notification');
const relay=fs.readFileSync(path.join(root,'..','..','cloudflare','notification-relay','worker.js'),'utf8');
const schema=fs.readFileSync(path.join(root,'..','..','cloudflare','notification-relay','schema.sql'),'utf8');
assert.match(relay,/buildPushPayload/,'Cloudflare relay builds encrypted Web Push payloads');
assert.match(relay,/VAPID_PUBLIC_KEY/,'Cloudflare relay uses VAPID for browser push');
assert.match(relay,/sendDuePush/,'Cloudflare scheduled handler sends due browser push reminders');
assert.match(schema,/notification_push_devices/,'D1 schema stores per-device PushSubscriptions');
assert.match(schema,/notification_push_reminders/,'D1 schema stores scheduled Web Push reminders');

console.log('MyGarage UI tests passed');
