# DriveHub notification relay

A small Cloudflare Worker + D1 service for DriveHub's scheduled **Email** and **Web Push** reminder channels.

The same 15-minute scheduler drives both channels. Browser Web Push uses VAPID and can arrive while DriveHub is closed. Email uses Resend. The future native App channel can be added as another delivery adapter later without changing MyGarage's reminder model.

The relay stores only what it needs to deliver reminders: verified email details for the Email channel, browser PushSubscription data for Web Push, and the minimal reminder schedule (title/body/send time). It never receives MyGarage photos, paperwork, valuation data or the full garage record.

## 1. Install the Worker dependencies

From `cloudflare/notification-relay/`:

```bash
npm install
```

The Worker uses `@block65/webcrypto-web-push`, which builds RFC Web Push payloads using Web Crypto and is compatible with Cloudflare Workers.

## 2. Create / migrate the D1 database

```bash
wrangler d1 create drivehub-notifications
wrangler d1 execute drivehub-notifications --file=./schema.sql --remote
```

If the database already exists from DriveHub v142.13, run the same `schema.sql` command again. The `CREATE TABLE IF NOT EXISTS` statements add the new push-device and push-reminder tables without deleting existing email subscriptions.

Copy `wrangler.toml.example` to `wrangler.toml` and add the returned database id.

## 3. Generate VAPID keys

Generate one VAPID key pair and keep it for the lifetime of this DriveHub deployment. Changing the key pair later requires browsers to subscribe again.

One convenient option is:

```bash
npx web-push generate-vapid-keys
```

You need the **public key**, **private key**, and a VAPID subject such as `mailto:you@example.com` or your HTTPS site URL.

## 4. Configure Worker secrets

For the shared relay:

```bash
wrangler secret put RELAY_SECRET
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT
```

For Email delivery, also configure Resend:

```bash
wrangler secret put RESEND_API_KEY
wrangler secret put EMAIL_FROM
```

`EMAIL_FROM` should be a complete verified sender such as `DriveHub <reminders@example.com>`.

The VAPID **public** key is safe to return to the browser. The VAPID private key, Resend key, and relay secret stay in Cloudflare.

## 5. Deploy

```bash
npm run deploy
```

## 6. Configure the DriveHub host

Add these to DriveHub's server environment:

```text
NOTIFICATION_RELAY_URL=https://drivehub-notification-relay.YOUR-SUBDOMAIN.workers.dev
NOTIFICATION_RELAY_SECRET=the-same-random-secret-used-by-the-worker
```

The browser talks only to DriveHub's `/api/notifications/*` endpoints. DriveHub's host adds the relay secret before forwarding requests to Cloudflare.

## Web Push flow

When the user enables **Browser notifications**:

1. DriveHub requests notification permission.
2. The browser registers the MyGarage service worker.
3. DriveHub requests the Worker VAPID public key through its hosted API.
4. `PushManager.subscribe()` creates a device-specific PushSubscription.
5. DriveHub sends that subscription to the relay and receives a random device token.
6. The same three-week / one-week reminder schedule used by Email is synced for that device.
7. The Cloudflare cron sends encrypted Web Push when the reminder is due.
8. The service worker receives the `push` event and displays the native notification even if DriveHub is closed.

A browser endpoint returning HTTP 404/410 is treated as expired. The relay deactivates that device and its pending push reminders rather than retrying indefinitely.

Each browser/device gets its own push subscription. Enabling DriveHub Browser notifications on a desktop, phone and tablet therefore allows the same reminders to reach all three devices.

## iPhone / iPad

Web Push on iOS/iPadOS requires DriveHub/MyGarage to be installed to the Home Screen before notification permission can be granted. Android and desktop Chromium/Firefox can subscribe directly from a secure HTTPS deployment.

## Scheduling

DriveHub schedules two notification times for each enabled reminder: roughly **three weeks before** and **one week before**, at 09:00 local time when the schedule is created. The Worker cron checks every 15 minutes.

If a channel is enabled after a reminder has already entered one of those windows, DriveHub schedules one catch-up notification for the current window instead of sending both at once.

The **Notifications** master switch controls all delivery. Turning it off sends an empty schedule to active channels while retaining their verified/subscribed identity. Turning the **Browser** channel itself off also deletes the relay device record and unsubscribes the browser PushSubscription.
