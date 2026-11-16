# DriveHub self-hosted Android OTA releases

`channels.json` is the explicit promotion switch used by `POST /api/app/update`.

The native Capacitor updater checks this endpoint. DriveHub only returns a bundle when:

- the channel is enabled;
- the referenced ZIP exists in `app-updates/bundles/`;
- the requesting device is on an older web version;
- its native Android `versionCode` meets `minimumNativeVersionCode`.

A normal unencrypted release entry looks like:

```json
"stable": {
  "version": "142.21.0",
  "file": "drivehub-142.21.0.zip",
  "checksum": "<checksum returned by Capgo CLI>",
  "minimumNativeVersionCode": 1,
  "sessionKey": "",
  "enabled": true
}
```

For Capgo Encryption V2, `checksum` must be the **encrypted checksum** returned by the encrypt command and `sessionKey` must be its `ivSessionKey`. The API returns that as `session_key` to the native updater.

Create bundles with the Capgo CLI, not a generic ZIP utility. See `android-shell/README.md` for the complete release flow.

Use the promotion helper rather than hand-editing a live channel:

```bash
npm run promote:android-ota -- <version> <filename.zip> <checksum> [stable|beta] [minimumNativeVersionCode] [sessionKey]
```

Channels in source are disabled by default, so deploying this repository alone cannot accidentally activate an incomplete OTA release.
