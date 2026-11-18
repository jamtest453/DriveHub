"""Google sign-in mode: each person's Car Search data lives in their own
Google Drive app-data folder, never in the shared server file."""
import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
CLIENT_ID = 'test-client.apps.googleusercontent.com'
SCOPE = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.appdata'


class FakeGoogle:
    """Google token check plus a tiny in-memory Drive, one per account."""

    def __init__(self):
        self.tokens = {}
        self.drives = {}
        self.uploads = 0

    def add(self, token, sub, email, **extra):
        self.tokens[token] = {'aud': CLIENT_ID, 'sub': sub, 'email': email,
                              'email_verified': 'true', 'scope': SCOPE, 'expires_in': '3599', **extra}
        self.drives.setdefault(sub, {})

    def handler(self, request):
        url = request.url
        if url.host == 'oauth2.googleapis.com':
            info = self.tokens.get(url.params.get('access_token'))
            return httpx.Response(200, json=info) if info else httpx.Response(400, json={})
        token = request.headers.get('authorization', '').removeprefix('Bearer ')
        info = self.tokens.get(token)
        if not info:
            return httpx.Response(401, json={})
        drive = self.drives[info['sub']]
        path = url.path
        if request.method == 'GET' and path == '/drive/v3/files':
            assert url.params['spaces'] == 'appDataFolder'
            name = url.params['q'].split("'")[1]
            return httpx.Response(200, json={'files': [{'id': i} for i, f in drive.items() if f['name'] == name]})
        if request.method == 'GET' and path.startswith('/drive/v3/files/'):
            return httpx.Response(200, content=drive[path.rsplit('/', 1)[1]]['data'])
        if request.method == 'POST' and path == '/upload/drive/v3/files':
            body = request.content
            assert b'"parents": ["appDataFolder"]' in body
            metadata = json.loads(body.split(b'\r\n\r\n', 2)[1].split(b'\r\n')[0])
            data = body.split(b'\r\n\r\n', 2)[2].rsplit(b'\r\n--', 1)[0]
            file_id = f"file-{info['sub']}-{metadata['name']}"
            drive[file_id] = {'name': metadata['name'], 'data': data}
            self.uploads += 1
            return httpx.Response(200, json={'id': file_id})
        if request.method == 'PATCH' and path.startswith('/upload/drive/v3/files/'):
            drive[path.rsplit('/', 1)[1]]['data'] = request.content
            self.uploads += 1
            return httpx.Response(200, json={'id': path.rsplit('/', 1)[1]})
        return httpx.Response(404)

    def saved(self, sub, name='car-search-hub.json'):
        for item in self.drives[sub].values():
            if item['name'] == name:
                return json.loads(item['data'])
        return None


def load_google_server(monkeypatch, tmp_path, fake, owner=''):
    monkeypatch.setenv('GOOGLE_LOGIN_CLIENT_ID', CLIENT_ID)
    monkeypatch.setenv('ALLOWED_EMAILS', 'alex@example.com, sam@example.com')
    monkeypatch.setenv('LEGACY_DATA_OWNER', owner)
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.setenv('ENVIRONMENT', 'production')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.syspath_prepend(str(ROOT))
    spec = importlib.util.spec_from_file_location('server_google_mode', ROOT / 'server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.GOOGLE_STORE.http = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
    return module


def client_for(module):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url='http://testserver')


@pytest.mark.asyncio
async def test_each_person_gets_their_own_data_in_their_own_drive(tmp_path, monkeypatch):
    fake = FakeGoogle()
    fake.add('token-alex-aaaaaaaaaaaaaaaa', 'alex', 'alex@example.com')
    fake.add('token-sam-bbbbbbbbbbbbbbbbbb', 'sam', 'sam@example.com')
    server = load_google_server(monkeypatch, tmp_path, fake)
    async with client_for(server) as alex, client_for(server) as sam:
        assert (await alex.get('/api/auth')).json()['mode'] == 'google'
        assert (await alex.get('/api/state')).status_code == 401
        signed = await alex.post('/api/google/session', json={'accessToken': 'token-alex-aaaaaaaaaaaaaaaa'})
        assert signed.status_code == 200, signed.text
        assert signed.json()['email'] == 'alex@example.com'
        assert (await sam.post('/api/google/session', json={'accessToken': 'token-sam-bbbbbbbbbbbbbbbbbb'})).status_code == 200

        made = await alex.post('/api/searches', json={
            'name': 'Porsche 911', 'filters': {'keywords': '', 'priceMax': 40000}, 'sources': ['ebay']})
        assert made.status_code == 200, made.text
        assert [s['name'] for s in made.json()['state']['searches']] == ['Porsche 911']
        # Sam sees none of Alex's searches.
        assert (await sam.get('/api/state')).json()['state']['searches'] == []

        for workspace in server.GOOGLE_STORE.workspaces.values():
            await server.GOOGLE_STORE.flush(workspace)
        assert [s['name'] for s in fake.saved('alex')['searches']] == ['Porsche 911']
        assert fake.saved('sam') is None  # nothing changed for Sam, nothing written
        # Nothing is stored on the server's disk.
        assert not (tmp_path / 'car-search-hub.json').exists()

        # A restarted server reloads Alex's data from their Drive.
        restarted = load_google_server(monkeypatch, tmp_path, fake)
        async with client_for(restarted) as again:
            await again.post('/api/google/session', json={'accessToken': 'token-alex-aaaaaaaaaaaaaaaa'})
            names = [s['name'] for s in (await again.get('/api/state')).json()['state']['searches']]
            assert names == ['Porsche 911']


@pytest.mark.asyncio
async def test_sign_in_is_limited_to_allowed_accounts_and_car_search_tokens(tmp_path, monkeypatch):
    fake = FakeGoogle()
    fake.add('token-stranger-cccccccccccccc', 'x', 'stranger@example.com')
    fake.add('token-wrongapp-dddddddddddddd', 'alex', 'alex@example.com', aud='another-app')
    fake.add('token-noscope-eeeeeeeeeeeeeee', 'alex', 'alex@example.com', scope='openid email')
    server = load_google_server(monkeypatch, tmp_path, fake)
    async with client_for(server) as client:
        for token, wanted in (('token-stranger-cccccccccccccc', 'not allowed'),
                              ('token-wrongapp-dddddddddddddd', 'not issued for Car Search'),
                              ('token-noscope-eeeeeeeeeeeeeee', 'Google Drive'),
                              ('token-unknown-ffffffffffffff', 'expired')):
            response = await client.post('/api/google/session', json={'accessToken': token})
            assert response.status_code in (401, 403)
            assert wanted in response.json()['detail']
        assert (await client.post('/api/login', json={'password': 'x'})).status_code == 400
        assert (await client.get('/api/state')).status_code == 401


@pytest.mark.asyncio
async def test_owner_first_sign_in_copies_existing_shared_data(tmp_path, monkeypatch):
    shared = {'version': 1, 'searches': [{'id': 's1', 'name': 'BMW M2', 'links': []}],
              'listings': {}, 'snapshots': {}, 'options': {'pageDepth': 5}}
    (tmp_path / 'car-search-hub.json').write_text(json.dumps(shared))
    fake = FakeGoogle()
    fake.add('token-alex-aaaaaaaaaaaaaaaa', 'alex', 'alex@example.com')
    fake.add('token-sam-bbbbbbbbbbbbbbbbbb', 'sam', 'sam@example.com')
    server = load_google_server(monkeypatch, tmp_path, fake, owner='alex@example.com')
    async with client_for(server) as alex, client_for(server) as sam:
        await alex.post('/api/google/session', json={'accessToken': 'token-alex-aaaaaaaaaaaaaaaa'})
        await sam.post('/api/google/session', json={'accessToken': 'token-sam-bbbbbbbbbbbbbbbbbb'})
        assert [s['name'] for s in (await alex.get('/api/state')).json()['state']['searches']] == ['BMW M2']
        assert (await sam.get('/api/state')).json()['state']['searches'] == []
        await asyncio.sleep(0)
        await server.GOOGLE_STORE.flush(server.GOOGLE_STORE.workspaces['alex'])
        assert fake.saved('alex')['options']['pageDepth'] == 5
    assert (tmp_path / 'car-search-hub.json').exists()  # left in place


@pytest.mark.asyncio
async def test_expired_google_sign_in_asks_the_browser_to_renew(tmp_path, monkeypatch):
    fake = FakeGoogle()
    fake.add('token-alex-aaaaaaaaaaaaaaaa', 'alex', 'alex@example.com')
    server = load_google_server(monkeypatch, tmp_path, fake)
    async with client_for(server) as alex:
        await alex.post('/api/google/session', json={'accessToken': 'token-alex-aaaaaaaaaaaaaaaa'})
        server.GOOGLE_STORE.workspaces['alex'].token_expiry = 0
        response = await alex.get('/api/state')
        assert response.status_code == 401 and response.json()['reauth'] == 'google'
        await alex.post('/api/google/session', json={'accessToken': 'token-alex-aaaaaaaaaaaaaaaa'})
        assert (await alex.get('/api/state')).status_code == 200


@pytest.mark.asyncio
async def test_each_person_has_their_own_facebook_login_in_their_drive(tmp_path, monkeypatch):
    monkeypatch.setenv('FACEBOOK_EMAIL', 'server-account@example.com')
    monkeypatch.setenv('FACEBOOK_PASSWORD', 'server-password')
    fake = FakeGoogle()
    fake.add('token-alex-aaaaaaaaaaaaaaaa', 'alex', 'alex@example.com')
    fake.add('token-sam-bbbbbbbbbbbbbbbbbb', 'sam', 'sam@example.com')
    server = load_google_server(monkeypatch, tmp_path, fake)
    from src import facebook_profile, scanner
    async with client_for(server) as alex, client_for(server) as sam:
        await alex.post('/api/google/session', json={'accessToken': 'token-alex-aaaaaaaaaaaaaaaa'})
        await sam.post('/api/google/session', json={'accessToken': 'token-sam-bbbbbbbbbbbbbbbbbb'})
        empty = (await alex.get('/api/facebook/account')).json()
        assert empty == {'personal': True, 'email': '', 'hasPassword': False}
        assert (await alex.put('/api/facebook/account', json={'email': 'alex.fb@example.com'})).status_code == 400

        saved = await alex.put('/api/facebook/account', json={'email': 'alex.fb@example.com', 'password': 'alex-secret'})
        assert saved.status_code == 200, saved.text
        assert saved.json() == {'personal': True, 'email': 'alex.fb@example.com', 'hasPassword': True}
        assert 'alex-secret' not in saved.text
        assert fake.saved('alex', 'car-search-facebook.json')['password'] == 'alex-secret'
        # Changing only the email keeps the saved password.
        kept = await alex.put('/api/facebook/account', json={'email': 'alex2@example.com', 'password': ''})
        assert kept.json()['hasPassword'] is True
        assert fake.saved('alex', 'car-search-facebook.json')['password'] == 'alex-secret'

        # Sam has no Facebook login and never gets Alex's or the server's.
        assert (await sam.get('/api/facebook/account')).json()['email'] == ''
        # The password is never in the car data, the backup export or the page state.
        for client in (alex, sam):
            assert 'alex-secret' not in (await client.get('/api/state')).text
            assert 'alex-secret' not in (await client.get('/api/export')).text

        alex_ws = server.GOOGLE_STORE.workspaces['alex']
        sam_ws = server.GOOGLE_STORE.workspaces['sam']
        token = facebook_profile.PROFILE.set(alex_ws.facebook_profile)
        try:
            assert facebook_profile.active().credentials() == ('alex2@example.com', 'alex-secret')
            alex_session = scanner.facebook_state_path()
        finally:
            facebook_profile.PROFILE.reset(token)
        token = facebook_profile.PROFILE.set(sam_ws.facebook_profile)
        try:
            assert facebook_profile.active().credentials() == ('', '')
            assert scanner.facebook_state_path() != alex_session
            with pytest.raises(ValueError, match='Car Search Settings'):
                class NoCookies:
                    async def cookies(self, url):
                        return []
                await scanner.ensure_facebook_session(NoCookies())
        finally:
            facebook_profile.PROFILE.reset(token)
        assert not str(alex_session).startswith(str(tmp_path))  # not in the shared data folder

        # A verified Facebook browser session is saved to Alex's Drive too.
        alex_session.write_text(json.dumps({'cookies': [{'name': 'c_user', 'value': '1'}], 'origins': []}))
        assert await server.GOOGLE_STORE.save_facebook(alex_ws)
        assert fake.saved('alex', 'car-search-facebook.json')['session']['cookies'][0]['name'] == 'c_user'

        # After a restart, Alex's Facebook login and session come back from Drive.
        restarted = load_google_server(monkeypatch, tmp_path, fake)
        async with client_for(restarted) as again:
            await again.post('/api/google/session', json={'accessToken': 'token-alex-aaaaaaaaaaaaaaaa'})
            assert (await again.get('/api/facebook/account')).json()['email'] == 'alex2@example.com'
            profile = restarted.GOOGLE_STORE.workspaces['alex'].facebook_profile
            assert json.loads(profile.managed_path().read_text())['cookies'][0]['value'] == '1'

        removed = await alex.delete('/api/facebook/account')
        assert removed.json() == {'personal': True, 'email': '', 'hasPassword': False}
        assert fake.saved('alex', 'car-search-facebook.json')['password'] == ''
        assert not alex_session.exists()


@pytest.mark.asyncio
async def test_password_mode_still_uses_server_facebook_login(monkeypatch):
    import server
    from src import facebook_profile
    monkeypatch.setenv('FACEBOOK_EMAIL', 'server-account@example.com')
    monkeypatch.setenv('FACEBOOK_PASSWORD', 'server-password')
    assert facebook_profile.active().credentials() == ('server-account@example.com', 'server-password')
    monkeypatch.setattr(server, 'PASSWORD', '')
    async with client_for(server) as client:
        assert (await client.get('/api/facebook/account')).json() == {'personal': False}
