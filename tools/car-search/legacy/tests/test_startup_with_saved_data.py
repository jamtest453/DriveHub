"""The server must start when a saved data file already exists (as on the
live /data volume), not only with an empty data folder."""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_server_starts_and_loads_existing_data_file(tmp_path):
    saved = {'version': 1, 'searches': [{'id': 's1', 'name': 'BMW M2', 'links': []}],
             'listings': {'a': {'id': 'a', 'title': 'BMW M2 blue'}}, 'snapshots': {},
             'options': {'pageDepth': 5, 'home': {'label': 'Stockport', 'lat': 53.4, 'lng': -2.15}}}
    (tmp_path / 'car-search-hub.json').write_text(json.dumps(saved))
    env = {**os.environ, 'DATA_DIR': str(tmp_path), 'APP_PASSWORD': 'long-test-password',
           'ENVIRONMENT': 'production', 'GOOGLE_LOGIN_CLIENT_ID': ''}
    code = ("import server, json; s=server.state; "
            "print(json.dumps([s['searches'][0]['name'], s['options']]))")
    result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, env=env,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    name, options = json.loads(result.stdout.strip().splitlines()[-1])
    assert name == 'BMW M2'
    assert options['pageDepth'] == 5 and options['home']['label'] == 'Stockport'
