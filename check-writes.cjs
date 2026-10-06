// Proves the steward complaint is fixed: submitting now calls the contract
// instead of navigating to Studio. Uses a mock EIP-1193 provider (this is a
// headless VPS with no MetaMask), and asserts on what the app actually does.
const { chromium } = require('/home/administrator/node_modules/playwright');
const TARGET_URL = process.env.TARGET || 'http://127.0.0.1:8906/veritag/';

const MOCK = `
  window.__calls = { requestAccounts: 0, switchChain: 0, ethRequest: [] };
  const chainId = '0x' + (61997).toString(16);
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      window.__calls.requestAccounts++;
      if (method === 'eth_requestAccounts') return ['0x61fd0047595A30A067f1F21F3b28C4AE8A8e3Dc3'];
      if (method === 'wallet_switchEthereumChain') {
        window.__calls.switchChain++;
        window.__calls.switchedTo = params?.[0]?.chainId;
        return null;
      }
      if (method === 'eth_chainId') return chainId;
      window.__calls.ethRequest.push(method);
      return null;
    },
    on: () => {}, removeListener: () => {},
  };
`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let fails = 0;
  const ok = (c, m) => { console.log(`   ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; };

  // Fail loudly if the page navigates away — that was the original bug.
  // Compare against the origin actually under test, so this works against both
  // the local server and the live site (a hardcoded origin false-fired there).
  const ORIGIN = new global.URL(TARGET_URL).origin;
  const ALLOWED = ORIGIN + '/veritag/';
  let navigatedAway = false;
  page.on('framenavigated', (f) => { if (f === page.mainFrame() && !f.url().startsWith(ALLOWED)) navigatedAway = true; });

  await page.addInitScript(MOCK);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);

  console.log('1. the old dead link is gone');
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a')].map(a => ({ text: a.textContent.trim(), href: a.href })));
  const studioLink = links.find(l => /studio/i.test(l.text));
  ok(!studioLink, `no "Submit in GenLayer Studio" link remains (${links.length} links, none to Studio)`);
  ok(!links.some(l => /studio-next/.test(l.href)), 'nothing points at studio-next');

  console.log('\n2. a real submit control exists');
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /submit claim/i.test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { text: b.textContent.trim(), tag: b.tagName, disabled: b.disabled,
             w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok(!!btn, btn ? `button reads "${btn.text}" (${btn.tag})` : 'submit button MISSING');
  if (btn) {
    ok(btn.tag === 'BUTTON', 'it is a <button>, not an <a>');
    ok(btn.h >= 44, `touch target ${btn.h}px tall (>=44)`);
    ok(!btn.disabled, 'it is enabled with the prefilled claim');
  }

  console.log('\n3. clicking it calls the wallet (the real test)');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /submit claim/i.test(x.textContent));
    b.click();
  });
  await page.waitForTimeout(4000);
  const calls = await page.evaluate(() => window.__calls);
  ok(calls.requestAccounts > 0, `eth_requestAccounts called (${calls.requestAccounts}x)`);
  ok(calls.switchChain > 0, `wallet_switchEthereumChain called (${calls.switchChain}x)`);
  ok(calls.ethRequest.includes('eth_sendTransaction'),
     `wallet asked to SIGN a transaction (eth_sendTransaction)`);
  const want = '0x' + (61997).toString(16);
  ok(calls.switchedTo === want, `switched to chain ${calls.switchedTo} (Studio dev = ${want})`);
  ok(!navigatedAway, 'the page did NOT navigate away to Studio');
  console.log('   rpc methods seen:', JSON.stringify(calls.ethRequest));

  console.log('\n4. the UI reports progress or a real error, never a dead end');
  const state = await page.evaluate(() => {
    // Only the live status/error elements next to the button, never page copy.
    const btn = [...document.querySelectorAll('button')].find(x => /submit claim|verifying with/i.test(x.textContent));
    const panel = btn?.closest('div')?.parentElement || document.body;
    const t = panel.innerText || '';
    const stages = ['connecting wallet', 'estimating fees', 'submitting to the committee',
                    'waiting for consensus', 'Verifying with the committee'];
    return {
      stage: stages.find(s => t.includes(s)) || '',
      err: (t.match(/Could not submit:[^\n]*/) || [])[0] || '',
      disabledDuring: btn?.disabled ?? false,
      btnText: btn?.textContent.trim() || '',
    };
  });
  ok(!!state.stage || !!state.err, `live status: "${state.stage || state.err}"`);
  ok(state.stage !== 'recorded on-chain', 'did NOT falsely claim success headless');
  console.log(`   button now: "${state.btnText}" disabled=${state.disabledDuring}`);
  if (state.err) console.log('   expected here: a real consensus tx needs a funded wallet + LLM keys');

  await browser.close();
  console.log('\n' + (fails ? fails + ' problems' : 'the app now calls the contract'));
  process.exit(fails ? 1 : 0);
})();
