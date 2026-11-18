"""Per-person Car Search data.

Two storage modes:

* ``password`` (default, the original behaviour): one shared workspace saved
  to ``DATA_DIR/car-search-hub.json``.
* ``google`` (when ``GOOGLE_CLIENT_ID`` is set): every person signs in with
  their Google account. Their searches, listings and notes are kept in a file
  in that account's private Google Drive app-data folder. The server only holds
  a working copy in memory while they use it and never writes it to disk.

The rest of the server reads ``state``/``job`` and takes ``LOCK`` exactly as
before; the proxies here route those names to the workspace of the person who
made the current request (or whose scan/background task is running).
"""
import asyncio
import contextvars
import json
import os
import time
from collections.abc import MutableMapping

import httpx

DRIVE_FILE_NAME = 'car-search-hub.json'
DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
FLUSH_DELAY = 3.0
IDLE_EVICT_SECONDS = 12 * 3600
TOKEN_MARGIN = 90

CURRENT = contextvars.ContextVar('car_search_workspace', default=None)


def new_job():
    return {'busy': False, 'label': '', 'detail': '', 'stop': False, 'message': '',
            'started': None, 'finished': None, 'searchIds': []}


class Workspace:
    def __init__(self, key, state, email=''):
        self.key = key
        self.email = email
        self.state = state
        self.revision = 0
        self.job = new_job()
        self.lock = asyncio.Lock()
        self.token = ''
        self.token_expiry = 0.0
        self.drive_file_id = None
        self.dirty = False
        self.flush_task = None
        self.last_used = time.time()
        self.save_error = ''

    def token_valid(self):
        return bool(self.token) and self.token_expiry - TOKEN_MARGIN > time.time()


def current():
    workspace = CURRENT.get()
    if workspace is None:
        raise RuntimeError('No Car Search workspace is active for this request.')
    return workspace


class _StateProxy(MutableMapping):
    def _target(self):
        return current().state

    def __getitem__(self, key):
        return self._target()[key]

    def __setitem__(self, key, value):
        self._target()[key] = value

    def __delitem__(self, key):
        del self._target()[key]

    def __iter__(self):
        return iter(self._target())

    def __len__(self):
        return len(self._target())

    def get(self, key, default=None):
        return self._target().get(key, default)


class _JobProxy(_StateProxy):
    def _target(self):
        return current().job


class _LockProxy:
    async def __aenter__(self):
        await current().lock.acquire()

    async def __aexit__(self, *exc):
        current().lock.release()

    def locked(self):
        return current().lock.locked()


state = _StateProxy()
job = _JobProxy()
LOCK = _LockProxy()


def plain(value):
    """The real dict behind a proxy, for JSON responses."""
    if isinstance(value, _StateProxy):
        return value._target()
    return value


class GoogleError(Exception):
    def __init__(self, message, status=401):
        super().__init__(message)
        self.status = status


class GoogleDriveStore:
    """Signs people in with a Google access token and keeps each person's data
    in their own Drive app-data folder."""

    def __init__(self, client_id, allowed_emails, fresh_state, prepare_state,
                 legacy_owner='', legacy_file=None, http=None):
        self.client_id = client_id
        self.allowed = {e.strip().lower() for e in allowed_emails if e.strip()}
        self.fresh_state = fresh_state
        self.prepare_state = prepare_state
        self.legacy_owner = legacy_owner.strip().lower()
        self.legacy_file = legacy_file
        self.http = http
        self.workspaces = {}
        self.loading = {}

    def _client(self):
        if self.http is None:
            self.http = httpx.AsyncClient(timeout=30)
        return self.http

    async def verify(self, access_token):
        if not isinstance(access_token, str) or not 20 <= len(access_token) <= 4096:
            raise GoogleError('Google sign-in did not return a usable token.')
        try:
            response = await self._client().get(
                'https://oauth2.googleapis.com/tokeninfo', params={'access_token': access_token})
        except httpx.HTTPError:
            raise GoogleError('Could not reach Google to check your sign-in. Try again.', 503)
        if response.status_code != 200:
            raise GoogleError('Google sign-in has expired. Sign in again.')
        info = response.json()
        if info.get('aud') != self.client_id and info.get('azp') != self.client_id:
            raise GoogleError('That Google sign-in was not issued for Car Search.', 403)
        if DRIVE_SCOPE not in str(info.get('scope', '')).split():
            raise GoogleError('Allow Car Search to store its data in your Google Drive to continue.', 403)
        email = str(info.get('email') or '').lower()
        if not email or str(info.get('email_verified')).lower() != 'true':
            raise GoogleError('Your Google account needs a verified email address.', 403)
        if not self.allowed:
            raise GoogleError('No Google accounts have been allowed to use Car Search yet. '
                              'Add them to CAR_SEARCH_ALLOWED_EMAILS.', 403)
        if email not in self.allowed:
            raise GoogleError(f'{email} is not allowed to use Car Search.', 403)
        sub = str(info.get('sub') or '')
        if not sub:
            raise GoogleError('Google did not identify your account.', 403)
        try:
            expires = time.time() + int(info.get('expires_in', 0))
        except (TypeError, ValueError):
            expires = time.time()
        return {'sub': sub, 'email': email, 'expires': expires}

    def _headers(self, token):
        return {'Authorization': 'Bearer ' + token}

    async def _find_file(self, token):
        response = await self._client().get(
            'https://www.googleapis.com/drive/v3/files',
            params={'spaces': 'appDataFolder', 'q': f"name='{DRIVE_FILE_NAME}' and trashed=false",
                    'fields': 'files(id,modifiedTime)', 'orderBy': 'modifiedTime desc', 'pageSize': '1'},
            headers=self._headers(token))
        if response.status_code == 401:
            raise GoogleError('Google sign-in has expired. Sign in again.')
        response.raise_for_status()
        files = response.json().get('files') or []
        return files[0]['id'] if files else None

    async def _download(self, token, file_id):
        response = await self._client().get(
            f'https://www.googleapis.com/drive/v3/files/{file_id}',
            params={'alt': 'media'}, headers=self._headers(token))
        if response.status_code == 401:
            raise GoogleError('Google sign-in has expired. Sign in again.')
        response.raise_for_status()
        return response.json()

    async def _upload(self, workspace):
        body = json.dumps(workspace.state, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        headers = self._headers(workspace.token)
        if workspace.drive_file_id:
            response = await self._client().patch(
                f'https://www.googleapis.com/upload/drive/v3/files/{workspace.drive_file_id}',
                params={'uploadType': 'media'}, content=body,
                headers={**headers, 'Content-Type': 'application/json'})
            if response.status_code == 404:
                workspace.drive_file_id = None
                return await self._upload(workspace)
        else:
            boundary = 'carsearch' + os.urandom(8).hex()
            metadata = json.dumps({'name': DRIVE_FILE_NAME, 'parents': ['appDataFolder'],
                                   'mimeType': 'application/json'})
            multipart = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
                         f'{metadata}\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n'
                         ).encode() + body + f'\r\n--{boundary}--'.encode()
            response = await self._client().post(
                'https://www.googleapis.com/upload/drive/v3/files',
                params={'uploadType': 'multipart', 'fields': 'id'}, content=multipart,
                headers={**headers, 'Content-Type': f'multipart/related; boundary={boundary}'})
        if response.status_code == 401:
            workspace.token_expiry = 0
            raise GoogleError('Google sign-in has expired. Sign in again.')
        response.raise_for_status()
        if not workspace.drive_file_id:
            workspace.drive_file_id = response.json().get('id')

    def _legacy_state(self, email):
        if not (self.legacy_owner and email == self.legacy_owner and self.legacy_file
                and self.legacy_file.exists()):
            return None
        return json.loads(self.legacy_file.read_text(encoding='utf-8'))

    async def sign_in(self, access_token):
        """Verify the token and return the person's workspace, loading it from
        their Drive the first time."""
        info = await self.verify(access_token)
        self.evict_idle()
        workspace = self.workspaces.get(info['sub'])
        if workspace is None:
            pending = self.loading.get(info['sub'])
            if pending is None:
                pending = asyncio.ensure_future(self._load(info, access_token))
                self.loading[info['sub']] = pending
            try:
                workspace = await pending
            finally:
                self.loading.pop(info['sub'], None)
        workspace.token = access_token
        workspace.token_expiry = info['expires']
        workspace.email = info['email']
        workspace.last_used = time.time()
        if workspace.dirty:
            self.schedule_flush(workspace, delay=0)
        return workspace

    async def _load(self, info, token):
        existing = self.workspaces.get(info['sub'])
        if existing:
            return existing
        try:
            file_id = await self._find_file(token)
            raw = await self._download(token, file_id) if file_id else None
        except httpx.HTTPError:
            raise GoogleError('Could not load your Car Search data from Google Drive. Try again.', 503)
        imported = False
        if raw is None:
            raw = self._legacy_state(info['email'])
            imported = raw is not None
        workspace = Workspace(info['sub'], self.prepare_state(raw) if raw else self.fresh_state(),
                              info['email'])
        workspace.drive_file_id = file_id
        workspace.token, workspace.token_expiry = token, info['expires']
        self.workspaces[info['sub']] = workspace
        if imported:
            workspace.dirty = True
        return workspace

    def find(self, sub):
        workspace = self.workspaces.get(sub)
        if workspace:
            workspace.last_used = time.time()
        return workspace

    def schedule_flush(self, workspace, delay=FLUSH_DELAY):
        workspace.dirty = True
        if workspace.flush_task and not workspace.flush_task.done():
            return
        workspace.flush_task = asyncio.ensure_future(self._flush_later(workspace, delay))

    async def _flush_later(self, workspace, delay):
        await asyncio.sleep(delay)
        await self.flush(workspace)

    async def flush(self, workspace):
        """Save to Drive. A failure keeps the change pending; it is retried on
        the next change or the next time the person's sign-in is refreshed."""
        if not workspace.dirty:
            return True
        if not workspace.token_valid():
            workspace.save_error = 'Waiting for Google sign-in to save your latest changes.'
            return False
        workspace.dirty = False
        try:
            await self._upload(workspace)
            workspace.save_error = ''
            return True
        except (GoogleError, httpx.HTTPError, ValueError) as exc:
            workspace.dirty = True
            workspace.save_error = 'Could not save to Google Drive yet: ' + str(exc)[:160]
            return False

    async def sign_out(self, sub):
        workspace = self.workspaces.get(sub)
        if not workspace:
            return
        await self.flush(workspace)
        if not workspace.job['busy'] and not workspace.dirty:
            self.workspaces.pop(sub, None)
        else:
            workspace.token = ''

    def evict_idle(self):
        cutoff = time.time() - IDLE_EVICT_SECONDS
        for sub, workspace in list(self.workspaces.items()):
            if workspace.last_used < cutoff and not workspace.dirty and not workspace.job['busy']:
                self.workspaces.pop(sub, None)
