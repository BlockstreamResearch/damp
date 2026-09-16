// Actual browser export -> Rust HTTP -> verified download. All chain data is synthetic.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, chmod, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = await mkdtemp(join(tmpdir(), 'damp-browser-'));
const directory = join(evidence, 'fixture');
const bin = join(root, 'target/debug/damp-report');
const children = [];
let browser;
function run(binary, args) { return execFileSync(binary, args, { cwd: root, env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 120000 }); }
async function launch(binary, args, pattern, options = {}) {
  const child = spawn(binary, args, { cwd: root, env: { ...process.env, PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.push(child);
  return new Promise((accept, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Startup timeout for ${binary}: ${output}`)), 120000);
    const receive = chunk => { output += chunk; const match = output.match(pattern); if (match) { clearTimeout(timer); accept({ child, match }); } };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Startup failed (${code}): ${output}`)); });
  });
}
try {
  await access(bin);
  await launch(join(root, 'target/debug/examples/synthetic'), [directory], /Fixture directory ready/);
  const configPath = join(directory, 'config.json');
  const fixture = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8'));
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const port = await new Promise(resolvePort => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); }); });
  const origin = `http://127.0.0.1:${port}`;
  config.port = 0; config.origin = origin;
  await writeFile(configPath, JSON.stringify(config));
  run(bin, ['prepare-export', configPath, join(directory, 'deployment.json'), join(directory, 'export')]);
  run(join(root, 'target/debug/damp-audit'), ['export-audit-credentials', join(directory, 'issuer-wallet'), 'elements-regtest', join(directory, 'export/request.json'), join(directory, 'offline-credentials.json')]);
  await launch(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], /Local:.*http/, { cwd: join(root, 'apps/web') });
  browser = await chromium.launch(process.env.DAMP_BROWSER_CHANNEL ? { channel: process.env.DAMP_BROWSER_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let reportOrigin;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.origin === reportOrigin) return route.continue();
    // Only the public catalog is mocked. Report requests always reach Rust.
    if (url.hostname === 'api.github.com') return route.fulfill({ status: 200, contentType: 'application/json', body: url.pathname.includes('/contents/') ? '[]' : '{"default_branch":"main"}' });
    throw new Error(`Unexpected external request: ${url.origin}`);
  });
  await page.goto(`${origin}/#/admin/report`);
  assert.match(await page.title(), /DAMP/i);
  await page.evaluate(async ({ request }) => {
    const store = await import('/src/lib/store.ts');
    const id = request.policies[0].deploymentId;
    await store.putDeployment({ ...request.deployment, deploymentId: id, publication: 'local', confirmations: 2 });
    await store.setActiveDeploymentId(id);
    await store.putPolicySnapshot(request.policies[0], 'synthetic');
  }, fixture);
  await page.reload();
  await page.getByRole('button', { name: 'Open DAMP Signer SDK connection' }).click();
  await page.getByLabel('Recovery phrase or NEW').fill(fixture.mnemonic);
  await page.getByRole('button', { name: 'Connect and save debug signer' }).click();
  await page.getByRole('heading', { name: 'Wallet status' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('Export issuer audit credentials', { exact: true }).click();
  const hex = (await readdir(join(directory, 'export'))).filter(f => f.endsWith('.hex')).map(f => join(directory, 'export', f));
  await page.getByLabel('Issuer transaction hex files').setInputFiles(hex);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download audit credentials' }).click();
  await (await download).saveAs(join(directory, 'audit-credentials.json'));
  await chmod(join(directory, 'audit-credentials.json'), 0o600);
  const credentials = JSON.parse(await readFile(join(directory, 'audit-credentials.json'), 'utf8'));
  const offline = JSON.parse(await readFile(join(directory, 'offline-credentials.json'), 'utf8'));
  assert.equal(credentials.schema, 'damp-audit-credentials/v1');
  assert.equal(JSON.stringify(credentials).includes(fixture.mnemonic), false);
  assert.deepEqual(Object.keys(credentials).sort(), ['auditSecret', 'certificateJson', 'certificateSignature', 'deployment', 'holderAddress', 'issuerOpenings', 'reportSecret', 'schema']);
  for (const key of ['auditSecret', 'reportSecret', 'issuerOpenings']) assert.deepEqual(credentials[key], offline[key]);
  const service = await launch(bin, ['serve', configPath], /listening at (http:\/\/127\.0\.0\.1:\d+)\/report/);
  reportOrigin = service.match[1];
  await page.getByLabel('Report endpoint').fill(`${reportOrigin}/report`);
  await page.getByLabel('Access token', { exact: true }).fill('wrong-token');
  await page.getByRole('button', { name: 'Generate signed report' }).click();
  await page.getByText(/Authentication failed\. Enter/).waitFor();
  // The browser logs the intentional 401; it must not expose a server response body.
  const expectedAuthErrors = errors.splice(0).filter(e => !e.includes('401'));
  assert.deepEqual(expectedAuthErrors, []);
  const token = await readFile(join(directory, 'access-token'), 'utf8');
  await page.getByLabel('Access token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Generate signed report' }).click();
  await page.getByRole('button', { name: 'Download signed JSON' }).waitFor({ timeout: 120000 });
  await page.getByRole('heading', { name: 'Supply reconciled' }).waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  const reportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download signed JSON' }).click();
  await (await reportDownload).saveAs(join(directory, 'downloaded-report.json'));
  const verified = JSON.parse(run(bin, ['verify', join(directory, 'deployment.json'), join(directory, 'downloaded-report.json')]));
  assert.equal(verified.complete, true); assert.equal(verified.signaturesVerified, true);
  assert.equal(verified.supply.knownUnspent, fixture.request.deployment.issuedSupply);
  // Hide private inputs in screenshot evidence while keeping the verified result.
  await page.getByText('Export issuer audit credentials', { exact: true }).click();
  await page.screenshot({ path: join(evidence, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(evidence, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'README.md'), `# Browser evidence\n\nPASS. Disposable Chrome/Chromium at 1440×1100 and 390×844. Browser credential export matches offline Rust export and is accepted by the actual Rust HTTP service. Authentication rejection, native recovery, complete supply, issuer certificate and report signatures, actual signed-JSON download, native verification and no horizontal overflow passed. No app errors beyond the expected 401. All chain data and credentials are synthetic. Provider, exporter, service and verifier ran with empty PATH. Public catalog responses were local fixtures; no external requests or broadcasts occurred.\n`);
  console.log(`PASS: browser export, Rust reporting and downloaded verification. Evidence: ${evidence}`);
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
}
