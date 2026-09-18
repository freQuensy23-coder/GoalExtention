"""Offline Chromium replay. Only browser/HTTP boundaries are simulated, not our implementation."""
import gzip
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = json.loads(gzip.decompress((ROOT/'tests/fixtures/capture-dom.json.gz').read_bytes()))
# Independently reviewed from all source captures, not calculated by the implementation under test.
# state: (turn count, last index, candidate index, generating, draft, blocked)
EXPECTED = {
  1:(0,0,0,False,False,False), 2:(0,0,0,False,False,False),
  3:(4,4,0,False,False,False), 4:(4,4,4,False,False,False),
  5:(4,4,4,False,True,False), 6:(6,6,0,False,False,False),
  7:(5,6,6,False,False,False), 8:(5,6,6,False,False,True), 9:(5,6,6,False,False,True),
  10:(7,8,8,False,False,False), 11:(6,8,8,False,False,False),
  12:(6,8,8,False,False,True), 13:(6,8,8,False,False,True),
  14:(7,10,10,False,False,False), 15:(0,0,0,False,False,False),
  16:(0,0,0,False,False,False), 17:(2,2,0,True,False,False), 18:(2,2,0,True,False,False),
  19:(0,0,0,False,False,False), 20:(2,2,2,False,False,True),
  21:(2,2,2,False,False,False), 22:(2,2,2,False,False,True),
  23:(4,4,0,True,False,False), 24:(4,4,4,False,False,False),
  25:(4,4,4,False,False,False), 26:(4,4,4,False,False,False), 27:(8,10,10,False,False,False),
}

def turn(index, role='assistant', text='Result', complete=True):
    footer='<button data-testid="copy-turn-action-button">Copy response</button>' if complete else ''
    return f'<section data-testid="conversation-turn-{index}" data-turn="{role}"><div data-message-author-role="{role}" data-message-id="id-{index}"><p>{text}</p></div>{footer}</section>'

BASE = '''<!doctype html><main id="main"></main><form data-type="unified-composer">
<textarea name="prompt-textarea" hidden></textarea>
<div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p><br></p></div>
<button id="composer-submit-button" data-testid="send-button" type="submit" disabled>Send prompt</button></form>
<style>#prompt-textarea{min-height:30px}button{min-width:30px;min-height:30px}</style>'''

EDITOR = r'''() => {
  window.submissions = [];
  const editor=document.querySelector('#prompt-textarea');
  const button=document.querySelector('[data-testid="send-button"]');
  window.editorState = '';
  editor.addEventListener('input', () => { // A stateful editing boundary, not a textContent assertion.
    window.editorState=editor.innerText;
    setTimeout(()=>{button.disabled=!editorState.trim();}, window.enableDelay || 0);
  });
  document.querySelector('form').addEventListener('submit', e=>{
    e.preventDefault();
    if(window.dropSubmit) return;
    const text=window.editorState.trim();
    submissions.push(text);
    const last=[...document.querySelectorAll('[data-turn]')].at(-1);
    const index=Number(last?.dataset.testid.split('-').at(-1)||0)+1;
    const section=document.createElement('section');section.dataset.testid=`conversation-turn-${index}`;section.dataset.turn='user';
    const message=document.createElement('div');message.dataset.messageAuthorRole='user';message.dataset.messageId=`id-${index}`;message.textContent=text;section.append(message);
    document.querySelector('main').append(section);editor.replaceChildren(document.createElement('p'));window.editorState='';button.disabled=true;
  });
}'''

class ChromiumCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start()
        executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
        cls.browser=cls.pw.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.context=self.browser.new_context()
        self.context.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<!doctype html>'))
        self.page=self.context.new_page()  # No navigation to the real ChatGPT host.
    def tearDown(self):self.context.close()
    def load(self,html=BASE):
        self.page.set_content(html)
        for path in ['src/shared/goal-core.js','src/content/dom-adapter.js']:
            self.page.add_script_tag(content=(ROOT/path).read_text())
        self.page.evaluate("window.testUrl='https://chatgpt.com/c/demo';window.dom = ChatgptGoalDom.createAdapter(document,{getUrl:()=>testUrl})")
    def state(self):return self.page.evaluate('dom.snapshot()')

class CapturedDOMTests(ChromiumCase):
    def test_corpus_has_no_credentials_scripts_network_or_private_identifiers(self):
        self.assertEqual(len(FIXTURES),27)
        for f in FIXTURES:
            html=f['html']
            for forbidden in ['<script', '<iframe', 'src=', 'authorization', 'Bearer ', 'oaiusercontent', 'session-token', 'onclick=', 'onload=', 'https://']:
                self.assertNotIn(forbidden,html)
            self.assertNotRegex(html,r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    def test_generated_images_are_kept_without_role_message_nodes(self):
        self.load(FIXTURES[26]['html']);s=self.state()
        for index in [8,10]:
            result=next(t for t in s['turns'] if t['index']==index)
            self.assertEqual(result['text'],'');self.assertTrue(result['complete'])
            self.assertEqual(len([a for a in result['artifacts'] if a['kind']=='image']),1)
            self.assertIn('url',result['artifacts'][0])
    def test_goal_prompt_excludes_attached_file_tile_labels(self):
        self.load(FIXTURES[3]['html'])
        self.page.evaluate("document.querySelector('[data-testid=conversation-turn-3] .whitespace-pre-wrap').textContent='/goal ship'")
        result=next(t for t in self.state()['turns'] if t['index']==3)
        self.assertEqual(result['text'],'/goal ship')
        self.assertTrue(result['artifacts'])
    def test_work_file_buttons_are_metadata_not_verified_file_contents(self):
        self.load(FIXTURES[23]['html']);s=self.state()
        names={a['name'] for t in s['turns'] for a in t['artifacts']}
        self.assertIn('demo-file.json',names)
    def test_canvas_editor_and_hidden_textarea_are_never_selected(self):
        self.load(FIXTURES[20]['html'])
        self.assertTrue(self.page.evaluate("dom.getComposer().id==='prompt-textarea' && dom.getComposer().closest('form').dataset.type==='unified-composer'"))
        self.assertEqual(self.page.evaluate("dom.getComposer().tagName"),'DIV')


def capture_test(number,fixture):
    def run(self):
        self.load(fixture['html']);s=self.state()
        count,last,candidate,generating,draft,blocked=EXPECTED[number]
        self.assertEqual(len(s['turns']),count)
        self.assertEqual(s['turns'][-1]['index'] if s['turns'] else 0,last)
        self.assertEqual(s['candidate']['index'] if s['candidate'] else 0,candidate)
        self.assertEqual(s['generating'],generating)
        self.assertEqual(s['draft'],draft)
        self.assertEqual(s['blocked'],blocked)
        if number in [15,19]:self.assertFalse(s['composerReady'])
    return run
for n,fixture in enumerate(FIXTURES,1):setattr(CapturedDOMTests,'test_capture_'+fixture['name'].replace('-','_'),capture_test(n,fixture))

class AdapterInteractionTests(ChromiumCase):
    def setup_editor(self,html=BASE):
        self.load(html);self.page.evaluate(EDITOR)
    def test_editor_transaction_reaches_state_and_waits_for_button_then_echo(self):
        self.setup_editor();self.page.evaluate('window.enableDelay=250')
        result=self.page.evaluate("dom.sendMessage('First line\\nSecond line')")
        self.assertEqual(result['text'],'First line\nSecond line')
        self.assertEqual(self.page.evaluate('submissions'),['First line\nSecond line'])
        self.assertEqual(self.page.locator('textarea').input_value(),'')
    def test_click_alone_is_not_submission_acknowledgement(self):
        self.setup_editor();self.page.evaluate('window.dropSubmit=true')
        error=self.page.evaluate("dom.sendMessage('hello',{timeoutMs:150}).then(()=>'',e=>e.message)")
        self.assertIn('acknowledge',error)
    def test_unsent_draft_and_attachment_are_not_overwritten(self):
        self.setup_editor();self.page.locator('#prompt-textarea').fill('my draft')
        self.assertIn('draft',self.page.evaluate("dom.sendMessage('robot').catch(e=>e.message)"))
        self.assertEqual(self.page.locator('#prompt-textarea').inner_text(),'my draft')
        self.page.locator('#prompt-textarea').fill('')
        self.page.evaluate("document.querySelector('form').insertAdjacentHTML('beforeend','<button aria-label=\"Remove file 1: pending.png\">X</button>')")
        self.assertIn('attachment',self.page.evaluate("dom.sendMessage('robot').catch(e=>e.message)"))
    def test_attribute_only_stop_transition_prevents_send(self):
        self.setup_editor();self.page.evaluate("document.querySelector('button').dataset.testid='stop-button'")
        self.assertTrue(self.state()['generating'])
        self.assertIn('cancelled',self.page.evaluate("dom.sendMessage('robot').catch(e=>e.message)"))
    def test_role_dialog_without_aria_modal_blocks_send(self):
        self.setup_editor(BASE+'<div role="dialog"><p>Image editor</p></div>')
        self.assertIn('cancelled',self.page.evaluate("dom.sendMessage('robot').catch(e=>e.message)"))
    def test_late_guard_cancels_delayed_send(self):
        self.setup_editor();self.page.evaluate('window.enableDelay=250;window.allowed=true;setTimeout(()=>window.allowed=false,70)')
        result=self.page.evaluate("dom.sendMessage('robot',{guard:()=>window.allowed,timeoutMs:600}).catch(e=>e.message)")
        self.assertIn('cancelled',result);self.assertEqual(self.page.evaluate('submissions'),[])
    def test_changing_assistant_before_send_is_rechecked(self):
        self.setup_editor()
        result=self.page.evaluate("dom.sendMessage('robot',{beforeSend:()=>false}).catch(e=>e.message)")
        self.assertIn('Assistant turn changed',result);self.assertEqual(self.page.evaluate('submissions'),[])
    def test_last_user_turn_never_selects_previous_assistant(self):
        self.load(BASE.replace('<main id="main"></main>','<main id="main">'+turn(1,'user','goal')+turn(2)+turn(3,'user','next')+'</main>'))
        self.assertIsNone(self.state()['candidate'])
    def test_code_table_math_are_read_without_toolbar_noise_or_duplicate_katex(self):
        content='''<p>Here is the result.</p><pre><button>Copy code</button><code>const x = 1;</code></pre>
        <table><tr><th>Request</th><th>Response</th></tr><tr><td>GET</td><td>200</td></tr></table>
        <span class="katex"><span aria-hidden="true">duplicated equation</span><annotation>T = A + B</annotation></span>'''
        self.load(BASE.replace('<main id="main"></main>','<main id="main">'+turn(2,text=content)+'</main>'))
        text=self.state()['candidate']['text']
        self.assertIn('```\nconst x = 1;\n```',text);self.assertIn('| GET | 200 |',text);self.assertIn('T = A + B',text)
        self.assertNotIn('Copy code',text);self.assertNotIn('duplicated equation',text);self.assertNotIn('Copy response',text)

class ControllerTests(ChromiumCase):
    def start_controller(self,delayed=False):
        self.load();self.page.evaluate(EDITOR)
        for path in ['src/background/evaluator.js','src/background/goal-service.js']:
            self.page.add_script_tag(content=(ROOT/path).read_text())
        self.page.evaluate('''delayed=>{
          const data={};window.goalData=data;window.requests=[];window.popupListeners=[];let id=0;
          const storage={get:async k=>structuredClone({[k]:data[k]}),set:async o=>Object.assign(data,structuredClone(o)),remove:async k=>delete data[k]};
          window.svc=ChatgptGoalService.createService({storage,randomId:()=>`test-${++id}`,getSettings:async()=>({historyMessages:2}),evaluate:async()=>{
            requests.push('judge');
            if(delayed) await new Promise(r=>window.releaseJudge=r);
            return {is_goal_done:false,short_explanation:'Need tests'};
          }});
          window.chrome={runtime:{sendMessage:(m,cb)=>svc.handleMessage(m,{tab:{id:1},frameId:0,url:testUrl}).then(cb).catch(e=>cb({ok:false,error:e.message})),onMessage:{addListener:f=>popupListeners.push(f)}}};
        }''',delayed)
        self.page.add_script_tag(content=(ROOT/'src/content/controller.js').read_text())
        self.page.evaluate('window.ChatgptGoalController=ChatgptGoalControllerFactory.createController({getUrl:()=>testUrl})')
    def send_goal(self):
        self.page.locator('#prompt-textarea').fill('/goal ship')
        self.page.locator('[data-testid="send-button"]').click()
        self.page.wait_for_function("goalData['chatgptGoal.tab.1']?.status==='active'")
    def append_answer(self,complete=True):
        self.page.evaluate('(html)=>document.querySelector("main").insertAdjacentHTML("beforeend",html)',turn(2,complete=complete))
    def test_new_chat_multiline_command_prefix_whitespace(self):
        self.start_controller()
        self.page.evaluate("testUrl='https://chatgpt.com/'; ChatgptGoalController.tick()")
        self.page.locator('#prompt-textarea').fill('/goal \n\nship')
        self.page.locator('[data-testid="send-button"]').click()
        self.page.evaluate(r"""() => {
          document.querySelector('[data-message-author-role=user]').textContent='/goal\nship';
          testUrl='https://chatgpt.com/c/new-chat';
        }""")
        self.page.wait_for_function("goalData['chatgptGoal.tab.1']?.status==='active'")
        self.assertEqual(self.page.evaluate("goalData['chatgptGoal.tab.1'].objective"),'ship')
    def test_automatic_full_roundtrip_uses_real_controller_service_and_dom(self):
        self.start_controller();self.send_goal();self.append_answer()
        self.page.wait_for_function("goalData['chatgptGoal.tab.1']?.iteration===1",timeout=7000)
        self.assertEqual(len(self.page.evaluate('submissions')),2)
        self.assertIn('Your task:\nship',self.page.evaluate('submissions[1]'))
        self.page.wait_for_timeout(2000)
        self.assertEqual(self.page.evaluate('requests.length'),1)
    def test_stable_partial_response_without_stop_is_not_evaluated(self):
        self.start_controller();self.send_goal();self.append_answer(False)
        self.page.wait_for_timeout(2200);self.assertEqual(self.page.evaluate('requests.length'),0)
        self.page.evaluate("document.querySelector('[data-turn=assistant]').insertAdjacentHTML('beforeend','<button data-testid=copy-turn-action-button>Copy</button>')")
        self.page.wait_for_function("goalData['chatgptGoal.tab.1']?.iteration===1",timeout=5000)
    def test_popup_pause_during_slow_judge_never_sends(self):
        self.start_controller(True);self.send_goal();self.append_answer()
        self.page.wait_for_function("typeof window.releaseJudge === 'function'")
        self.page.evaluate("new Promise(r=>popupListeners[0]({type:'CG_PAUSE_GOAL'},{},r))")
        self.page.evaluate('releaseJudge()');self.page.wait_for_timeout(500)
        self.assertEqual(self.page.evaluate('submissions.length'),1)
        self.assertEqual(self.page.evaluate('svc.read(1).then(g=>g.status)'),'paused')
    def test_navigation_during_slow_judge_never_sends_into_other_chat(self):
        self.start_controller(True);self.send_goal();self.append_answer()
        self.page.wait_for_function("typeof window.releaseJudge === 'function'");self.page.evaluate("testUrl='https://chatgpt.com/c/other';releaseJudge()")
        self.page.wait_for_timeout(600);self.assertEqual(self.page.evaluate('submissions.length'),1)
    def test_manual_draft_during_slow_judge_is_preserved(self):
        self.start_controller(True);self.send_goal();self.append_answer();self.page.wait_for_function("typeof window.releaseJudge === 'function'")
        self.page.locator('#prompt-textarea').fill('my own draft');self.page.evaluate('releaseJudge()');self.page.wait_for_timeout(500)
        self.assertEqual(self.page.evaluate('submissions.length'),1);self.assertEqual(self.page.locator('#prompt-textarea').inner_text(),'my own draft')
    def test_command_is_not_armed_before_actual_submit(self):
        self.start_controller();self.page.evaluate('window.dropSubmit=true')
        self.page.locator('#prompt-textarea').fill('/goal ship');self.page.locator('[data-testid="send-button"]').click()
        self.page.wait_for_timeout(500);self.assertIsNone(self.page.evaluate('svc.read(1)'))
    def test_reloading_pending_send_pauses_instead_of_resending(self):
        self.start_controller();self.send_goal();self.append_answer()
        self.page.evaluate('ChatgptGoalController.dispose()')
        self.page.evaluate("svc.handleMessage({type:'CG_EVALUATE',threadUrl:testUrl,transcript:dom.collectMessages()},{tab:{id:1},frameId:0,url:testUrl})")
        self.page.add_script_tag(content=(ROOT/'src/content/controller.js').read_text())
        self.page.evaluate('window.ChatgptGoalController=ChatgptGoalControllerFactory.createController({getUrl:()=>testUrl})')
        self.page.wait_for_function("goalData['chatgptGoal.tab.1']?.status==='paused'",timeout=5000)
        self.assertEqual(self.page.evaluate('submissions.length'),1)

if __name__=='__main__':unittest.main()
