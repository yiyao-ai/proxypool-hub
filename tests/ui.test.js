import test from 'node:test';
import assert from 'node:assert/strict';

const UI_URL = process.env.UI_TEST_URL || 'http://localhost:8081/';

async function getText(html, regex) {
  const match = html.match(regex);
  return match ? match[1] : null;
}

test('Web UI loads and includes core navigation', async () => {
  const res = await fetch(UI_URL);
  assert.equal(res.status, 200);
  const html = await res.text();

  // Basic smoke checks that are resilient to styling changes.
  assert.ok(html.includes('<title>ProxyPool Hub</title>'));
  assert.ok(html.includes('dashboard'));
  assert.ok(html.includes('accounts'));
  assert.ok(html.includes('logs'));
  assert.ok(html.includes('settings'));
});

test('Web UI loads app bundle and has a logs container', async () => {
  const res = await fetch(UI_URL);
  assert.equal(res.status, 200);
  const html = await res.text();

  // Script is the main interactive surface.
  assert.ok(html.includes('<script src="/js/app.js"></script>'));

  // Logs view uses this id; useful for streaming/log rendering.
  assert.ok(html.includes('id="logs-container"'));
});

test('UI Quick Test and Haiku test controls are present', async () => {
  const res = await fetch(UI_URL);
  assert.equal(res.status, 200);
  const html = await res.text();

  // i18n keys referenced in the template via t('...')
  assert.ok(html.includes("t('quickTest')"));
  assert.ok(html.includes("t('haikuKiloTest')"));
  assert.ok(html.includes("t('test')"));
  assert.ok(html.includes("t('testHaiku')"));
});

test('app.js defines expected Alpine state keys (smoke)', async () => {
  const res = await fetch(new URL('/js/app.js', UI_URL));
  assert.equal(res.status, 200);
  const js = await res.text();

  // These are key behaviors we rely on.
  for (const needle of [
    "Alpine.data('app'",
    'activeTab',
    'refreshAccounts()',
    'checkHealth()',
    'startLogStream()',
    'configViewerOpen',
    'openConfigViewer(tool',
    'setHaikuModel(model)',
    'testChat()',
    'testHaikuChat()'
  ]) {
    assert.ok(js.includes(needle), `Expected app.js to include ${needle}`);
  }
});

test('Dashboard template includes config viewer entry points', async () => {
  const res = await fetch(UI_URL);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes("t('viewConfig')"));
  assert.ok(html.includes("@click=\"openConfigViewer('claude')\""));
  assert.ok(html.includes("@click=\"openConfigViewer('codex')\""));
  assert.ok(html.includes("@click=\"openConfigViewer('gemini')\""));
  assert.ok(html.includes("@click=\"openConfigViewer('openclaw')\""));
});

test('Health endpoint drives Online/Offline indicator (server contract)', async () => {
  // This checks the server contract used by the UI (checkHealth -> /health).
  const res = await fetch(new URL('/health', UI_URL));
  assert.equal(res.status, 200);

  const text = await res.text();
  // Expect either JSON or plain text; just ensure it is non-empty.
  assert.ok(text.length > 0);

  // UI expects response.ok to mean connected.
  assert.ok(res.ok);
});
