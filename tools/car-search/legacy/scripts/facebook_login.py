"""Optional one-off login helper, run only on a desktop hosting the scanner.

Usage: python scripts/facebook_login.py
You sign in yourself in a regular Chromium window; credentials are not read by the app.
Copies the resulting browser session to DATA_DIR/facebook-session.json.
"""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    path = Path(os.environ.get('DATA_DIR','data')) / 'facebook-session.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'))
        ctx = await browser.new_context(locale='en-GB')
        page = await ctx.new_page()
        await page.goto('https://www.facebook.com/marketplace/', wait_until='domcontentloaded')
        print('Sign in to Facebook in the open Chromium window, then press Enter here to save your session.')
        await asyncio.to_thread(input)
        await ctx.storage_state(path=str(path))
        try: os.chmod(path, 0o600)
        except OSError: pass
        print(f'Private session written to {path}. Set FACEBOOK_STORAGE_STATE={path} when running the app.')
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
