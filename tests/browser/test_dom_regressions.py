"""Additional DOM regressions: preserve code evidence and distinguish image artifacts.

These exercise the actual adapter in Chromium. HTML is synthetic and contains
no capture credentials, signed URLs, private text or external resources.
"""
import os
from pathlib import Path
import shutil
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

class DomEvidenceRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
        options = {'headless': True, 'args': ['--no-sandbox']}
        if executable:
            options['executable_path'] = executable
        cls.browser = cls.pw.chromium.launch(**options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.route('**/*', lambda route: route.abort())
        self.page.set_content('''<main><section data-testid="conversation-turn-2" data-turn="assistant">
          <div data-message-author-role="assistant" data-message-id="test-answer"><pre><code></code></pre></div>
          <button data-testid="copy-turn-action-button">Copy</button></section></main>''')
        for file in ['src/shared/goal-core.js', 'src/content/dom-adapter.js']:
            self.page.add_script_tag(path=str(ROOT / file))
        self.page.evaluate("window.adapter = ChatgptGoalDom.createAdapter(document)")

    def tearDown(self):
        self.page.close()

    def collect_code(self, code, bare_pre=False):
        self.page.evaluate('''({code,bare}) => {
          const pre = document.querySelector('pre');
          if (bare) pre.textContent = code;
          else pre.querySelector('code').textContent = code;
        }''', {'code': code, 'bare': bare_pre})
        return self.page.evaluate('adapter.collectMessages()[0].text')

    def test_python_indentation_is_preserved(self):
        code = 'def answer():\n    if True:\n        return 42\n'
        self.assertIn('```\n' + code + '\n```', self.collect_code(code))

    def test_blank_lines_inside_code_are_preserved(self):
        code = 'first = 1\n\n\n\nsecond = 2'
        self.assertIn('```\n' + code + '\n```', self.collect_code(code))

    def test_leading_indent_in_bare_pre_is_preserved(self):
        code = '    nested()\n\tsecond()  '
        self.assertIn('```\n' + code + '\n```', self.collect_code(code, bare_pre=True))

    def test_indentation_change_changes_response_fingerprint(self):
        self.collect_code('if ready:\n    run()')
        before = self.page.evaluate('ChatgptGoalCore.turnFingerprint(adapter.collectMessages()[0])')
        self.collect_code('if ready:\nrun()')
        after = self.page.evaluate('ChatgptGoalCore.turnFingerprint(adapter.collectMessages()[0])')
        self.assertNotEqual(before, after)

    def test_distinct_generated_images_with_same_alt_are_not_merged(self):
        # Three display/glow layers per generated image, as seen in the capture.
        self.page.evaluate('''src => {
          const turn = document.querySelector('section');
          for (const id of ['image-first','image-second']) {
            const holder = document.createElement('div'); holder.id = id;
            for (let i=0;i<3;i++) { const img=document.createElement('img');img.src=src;img.alt='Generated image';holder.append(img); }
            turn.append(holder);
          }
        }''', IMAGE)
        artifacts = self.page.evaluate('adapter.collectMessages()[0].artifacts')
        self.assertEqual(len(artifacts), 2)
        self.assertTrue(all(a == {'kind':'image','name':'Generated image','verified':False} for a in artifacts))

    def test_repeated_layers_without_holder_share_source_identity(self):
        self.page.evaluate('''src => {
          const turn=document.querySelector('section');
          for (let i=0;i<3;i++) { const img=document.createElement('img');img.src=src;img.alt='Same image';turn.append(img); }
        }''', IMAGE)
        self.assertEqual(len(self.page.evaluate('adapter.collectMessages()[0].artifacts')),1)

if __name__ == '__main__':
    unittest.main()
