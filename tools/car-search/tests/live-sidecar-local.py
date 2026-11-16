"""Local end-to-end check of the actual restored FastAPI app behind DriveHub."""
import os, socket, subprocess, sys, tempfile, time
from pathlib import Path

import httpx

ROOT=Path(__file__).resolve().parents[3]

def wait(addr, proc, label):
    for _ in range(150):
        if proc.poll() is not None: raise RuntimeError(f'{label} exited with {proc.returncode}')
        try:
            r=httpx.get(addr,timeout=0.6)
            if r.status_code in (200, 401, 404): return
        except Exception:pass
        time.sleep(.1)
    raise RuntimeError(f'{label} did not start')

with tempfile.TemporaryDirectory() as datadir:
    env={**os.environ,'DATA_DIR':datadir,'APP_PASSWORD':'test-long-secure-password',
         'ENVIRONMENT':'production','PORT':'23447','AUTH_SECRET':'e2e-test-secret'}
    py=subprocess.Popen([sys.executable,'-m','uvicorn','server:app','--app-dir',
                        str(ROOT/'tools/car-search/legacy'), '--host','127.0.0.1',
                        '--port','3213','--workers','1'], cwd=ROOT, env=env,
                        stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
    node=None
    try:
        wait('http://127.0.0.1:3213/api/auth',py,'Python Car Search')
        node=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,
                              stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
        base='http://127.0.0.1:23447'
        wait(base+'/search/',node,'DriveHub')
        with httpx.Client(base_url=base,follow_redirects=False,timeout=15) as client:
            assert client.get('/search/').status_code==200
            home=client.get('/car-search-app/')
            assert home.status_code==200 and 'Car Search Hub' in home.text
            assert '/car-search-app/dashboard.js?' not in home.text or 'dashboard.js?v=' in home.text
            js=client.get('/car-search-app/dashboard.js')
            assert js.status_code==200 and "fetch('/car-search-app' + url" in js.text
            assert "'/car-search-app/api/facebook/connection/preview'" in js.text
            auth=client.get('/car-search-app/api/auth').json()
            assert auth=={'authenticated':False,'passwordRequired':True}
            assert client.get('/car-search-app/api/state').status_code==401
            login=client.post('/car-search-app/api/login',json={'password':'test-long-secure-password'},headers={'origin':base})
            assert login.status_code==200,login.text
            assert 'Path=/car-search-app/' in login.headers['set-cookie']
            state=client.get('/car-search-app/api/state')
            assert state.status_code==200, state.text
            parsed=client.post('/car-search-app/api/searches/parse-url',
                json={'url':'https://www.autotrader.co.uk/car-search?aggregatedTrim=996%20Carrera%204S&make=Porsche&model=911&maximum-mileage=100000&price-to=30000&transmission=Manual'},
                headers={'origin':base})
            assert parsed.status_code==200,parsed.text
            assert parsed.json()['filters']['requiredKeywords']=='996, Carrera 4S'
            assert client.get('/api/state').status_code==404
            print('Live Python+DriveHub integration passed: original frontend, assets, password, login cookies, API isolation and search-URL parsing.')
    finally:
        for p in [node,py]:
            if p is not None:
                p.terminate()
                try:p.wait(timeout=5)
                except subprocess.TimeoutExpired:p.kill()
        if py.returncode and py.returncode not in (-15,-9):
            print('Python stderr:',py.stderr.read()[-5000:])
