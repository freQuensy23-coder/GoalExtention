"""CI-only native MV3 registration smoke test; never opens ChatGPT or calls an API."""
from pathlib import Path
import tempfile
import os
from playwright.sync_api import sync_playwright

extension = str(Path(__file__).resolve().parents[1] / 'dist')
with sync_playwright() as playwright, tempfile.TemporaryDirectory() as profile:
    # Full bundled Chromium supports extensions in headless mode; headless_shell does not.
    context = playwright.chromium.launch_persistent_context(
        profile, channel='chromium', headless=True,
        executable_path=os.environ.get('CHROMIUM_PATH'),
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'],
    )
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker', timeout=15000)
        assert worker.evaluate('chrome.runtime.getManifest().version') == '0.3.0'
        assert worker.evaluate('ready.then(() => typeof service.handleMessage)') == 'function'
        extension_id = worker.url.split('/')[2]
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/src/options/options.html')
        page.wait_for_function("() => document.querySelector('#api-endpoint').value === 'https://openrouter.ai/api/v1/chat/completions'")
        assert page.locator('#model').input_value() == 'openai/gpt-5.6-luna'
        page.locator('#test-connection').click()
        page.wait_for_function("() => document.querySelector('#status').textContent === 'API key is not configured.'")
        # No provider request or permission prompt in this offline test.
        page.locator('#api-endpoint').fill('https://api.openai.com/v1/responses')
        page.locator('#api-key').fill('offline-test-key')
        page.evaluate('''() => { globalThis.fetch = async (url, init) => {
          const request = JSON.parse(init.body);
          if (JSON.parse(request.input[1].content[0].text).goal !== 'Describe the attached image as a red square.' || !request.input[1].content.some(part => part.type === 'input_image' && part.image_url.startsWith('data:image/png;base64,')))
            throw new Error('Unexpected test goal');
          return new Response(JSON.stringify({output_text: JSON.stringify({
            is_goal_done: true, short_explanation: 'Synthetic reply matches'
          })}), {status: 200});
        }; }''')
        page.locator('#test-connection').click()
        page.wait_for_function("() => document.querySelector('#status').textContent.startsWith('Connection verified:')")
        page.locator('#model').fill('test-model')
        page.locator('#history-messages').fill('3')
        page.locator('button[type=submit]').click()
        page.wait_for_function("() => document.querySelector('#status').textContent === 'Saved.'")
        saved = worker.evaluate("chrome.storage.local.get('chatgptGoal.settings')")['chatgptGoal.settings']
        assert saved['model'] == 'test-model' and saved['historyMessages'] == 3
        page.reload()
        page.wait_for_function("() => document.querySelector('#model').value === 'test-model'")
        print('Native MV3 worker registration, imports, storage access and options save passed.')
    finally:
        context.close()
