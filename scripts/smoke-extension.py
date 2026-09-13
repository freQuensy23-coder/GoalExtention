"""CI-only native MV3 registration smoke test; never opens ChatGPT or calls an API."""
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright

extension = str(Path(__file__).resolve().parents[1] / 'dist')
with sync_playwright() as playwright, tempfile.TemporaryDirectory() as profile:
    # Full bundled Chromium supports extensions in headless mode; headless_shell does not.
    context = playwright.chromium.launch_persistent_context(
        profile, channel='chromium', headless=True,
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'],
    )
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker', timeout=15000)
        assert worker.evaluate('chrome.runtime.getManifest().version') == '0.2.0'
        assert worker.evaluate('ready.then(() => typeof service.handleMessage)') == 'function'
        extension_id = worker.url.split('/')[2]
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/src/options/options.html')
        page.wait_for_function("document.querySelector('#api-endpoint').value === 'https://api.openai.com/v1/responses'")
        page.locator('#model').fill('test-model')
        page.locator('#max-iterations').fill('3')
        page.locator('button[type=submit]').click()
        page.wait_for_function("document.querySelector('#status').textContent === 'Saved.'")
        saved = worker.evaluate("chrome.storage.local.get('chatgptGoal.settings')")['chatgptGoal.settings']
        assert saved['model'] == 'test-model' and saved['maxIterations'] == 3
        print('Native MV3 worker registration, imports, storage access and options save passed.')
    finally:
        context.close()
