// Fresh UI import -> public discovery -> downloaded credentials -> Rust service -> verified report.
// All keys, registry and chain data are synthetic. No app state is injected.
import { chromium } from 'playwright';
import { deploymentManifestSchema, policySnapshotSchema } from '../src/lib/domain.ts';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, access, unlink, stat } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = await mkdtemp(join(process.env.DAMP_REPORT_EVIDENCE_PARENT ?? tmpdir(), 'damp-report-browser-'));
const directory = join(evidence, 'fixture');
const serviceDirectory = join(evidence, 'service');
const bin = join(root, 'target/debug/damp-report');
const children = [];
let browser, publicServer, page;
const publicCalls = [];
const metrics = [];
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
  const fixture = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8'));
  const operatorConfig = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  const deployment = deploymentManifestSchema.parse(fixture.request.deployment);
  const policy = policySnapshotSchema.parse(fixture.request.policies[0]);
  const id = policy.deploymentId;
  const scriptHash = createHash('sha256').update(Buffer.from(policy.verifierScriptPubkey, 'hex')).digest('hex');
  const canonical = value => JSON.stringify(value, null, 2) + '\n';
  const blockHash = height => (height + 1).toString(16).padStart(64, '0');
  const txs = fixture.publicTransactions.map((tx, height) => ({
    txid: tx.txid,
    vin: tx.inputs.map(input => ({ txid: input.outpoint.split(':')[0], vout: Number(input.outpoint.split(':')[1]) })),
    vout: tx.outputs.map(out => ({ scriptpubkey: out.scriptPubkey, ...(out.asset ? { asset: out.asset } : {}), ...(out.amount !== null ? { value: Number(out.amount) } : {}) })),
    status: { confirmed: true, block_height: height, block_hash: blockHash(height) },
  }));
  let failDiscovery = false;
  let discoveryDelay = 0;
  publicServer = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    publicCalls.push(path);
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const reply = value => { res.setHeader('Content-Type', 'application/json'); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
    if (path === '/registry/deployments/index.json') return reply([id]);
    if (path === `/registry/deployments/${id}.json`) return reply(canonical(deployment));
    if (path === `/registry/policies/${id}/${scriptHash}.json`) return reply(canonical(policy));
    if (path.startsWith('/api/block-height/')) return reply(blockHash(Number(path.split('/').at(-1))));
    if (path === '/api/blocks/tip/height') return reply('2');
    if (path === '/api/blocks/tip/hash') return reply(blockHash(2));
    if (path === `/api/asset/${deployment.regulatedAsset}`) {
      if (failDiscovery) { res.statusCode = 503; return reply('synthetic provider unavailable'); }
      return setTimeout(() => reply({ asset_id: deployment.regulatedAsset, issuance_txin: { txid: txs[0].txid }, chain_stats: { tx_count: 1, issuance_count: 1 }, mempool_stats: { issuance_count: 0 } }), discoveryDelay);
    }
    if (path.startsWith(`/api/asset/${deployment.regulatedAsset}/txs/chain`)) return reply(path.endsWith('/chain') ? [txs[0]] : []);
    if (path.startsWith('/api/scripthash/')) return reply({ chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 0 } });
    const match = path.match(/^\/api\/tx\/([0-9a-f]{64})(.*)$/);
    if (match) {
      const index = txs.findIndex(tx => tx.txid === match[1]);
      if (index >= 0) {
        if (match[2] === '') return reply(txs[index]);
        if (match[2] === '/hex') return reply(fixture.transactions[index]);
        if (match[2] === '/status') return reply(txs[index].status);
        if (match[2] === '/outspend/0') return reply(index === 0 ? { spent: true, txid: txs[1].txid, vin: 0, status: txs[1].status } : { spent: false });
      }
    }
    res.statusCode = 404; reply({ error: 'unexpected fixture path', path });
  });
  await new Promise(resolveListen => publicServer.listen(0, '127.0.0.1', resolveListen));
  const publicOrigin = `http://127.0.0.1:${publicServer.address().port}`;
  const port = await new Promise(resolvePort => { const server = netServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); }); });
  const origin = `http://127.0.0.1:${port}`;
  // Execute the shipped setup commands. The fixture operator supplies only node connection details.
  run(bin, ['init', serviceDirectory]);
  const configPath = join(serviceDirectory, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.port = 0; config.origin = origin;
  config.provider = { ...operatorConfig.provider, cookie: join(directory, 'cookie') };
  await writeFile(configPath, JSON.stringify(config));
  await launch(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], /Local:.*http/, { cwd: join(root, 'apps/web'), env: { ...process.env, PATH: '', VITE_LOCAL_REGISTRY_BASE_URL: `${publicOrigin}/registry/` } });
  browser = await chromium.launch(process.env.DAMP_BROWSER_CHANNEL ? { channel: process.env.DAMP_BROWSER_CHANNEL } : {});
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let reportOrigin;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if ([origin, publicOrigin, reportOrigin].includes(url.origin)) return route.continue();
    throw new Error(`Unexpected external request: ${url.origin}`);
  });
  async function capture(name, focus) {
    for (const [suffix, width, height] of [['', 1440, 1100], ['-mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      if (focus) await focus();
      else await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name + suffix + ' overflow');
      if (name === 'report-requirements' && width === 1440) {
        const endpointBox = await page.getByLabel('Report endpoint', { exact: true }).boundingBox();
        const tokenBox = await page.getByLabel('Access token', { exact: true }).boundingBox();
        assert.ok(endpointBox && tokenBox);
        assert.ok(Math.abs(endpointBox.y - tokenBox.y) <= 1, 'Report endpoint and Access token top edges must align');
        assert.ok(Math.abs(endpointBox.height - tokenBox.height) <= 1, 'Report endpoint and Access token heights must match');
        metrics.push({ state: 'report-field-alignment', endpoint: endpointBox, token: tokenBox });
      }
      await page.screenshot({ path: join(evidence, name + suffix + '.png'), fullPage: !focus });
      metrics.push({ state: name + suffix, controls: await page.locator('button:visible').evaluateAll(buttons => buttons.map(button => ({ label: button.textContent.trim(), disabled: button.disabled }))) });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
  }
  await page.goto(`${origin}/#/admin/report`);
  await page.getByRole('link', { name: 'Open deployment setup' }).waitFor();
  await capture('report-empty');
  await page.getByRole('button', { name: 'Open DAMP Signer SDK connection' }).click();
  await capture('signer-empty');
  await page.getByLabel('Recovery phrase or NEW').fill('invalid test phrase');
  await page.getByRole('button', { name: 'Connect and save debug signer' }).click();
  await page.locator('.wallet-popover-status').waitFor();
  await capture('signer-error');
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Open deployment setup' }).click();
  await page.getByRole('button', { name: /Existing deployment Import/ }).click();
  await page.getByText('Regtest public provider', { exact: true }).click();
  await capture('provider-empty');
  await page.getByLabel('Regtest Esplora API URL').fill(`${publicOrigin}/api`);
  await page.getByRole('button', { name: 'Save public provider' }).click();
  await page.getByLabel('Public source').fill(`${publicOrigin}/registry/deployments/${id}.json`);
  await page.getByRole('button', { name: 'Import public deployment' }).click();
  await page.getByText('Public import complete', { exact: true }).waitFor();
  await capture('deployment-imported');
  await page.getByRole('link', { name: 'Report', exact: true }).click();
  await page.getByText('Export issuer audit credentials', { exact: true }).click();
  await capture('credentials-disconnected');
  assert.equal(await page.getByRole('button', { name: 'Discover and download credentials' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Connect issuer signer' }).click();
  await capture('signer-regtest');
  await page.getByLabel('Recovery phrase or NEW').fill(fixture.mnemonic);
  await page.getByRole('button', { name: 'Connect and save debug signer' }).click();
  await page.getByRole('heading', { name: 'Wallet status' }).waitFor();
  await page.keyboard.press('Escape');
  await capture('credentials-ready');
  await capture('credentials-focus', async () => { await page.getByRole('button', { name: 'Discover and download credentials' }).focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); });
  failDiscovery = true;
  await page.getByRole('button', { name: 'Discover and download credentials' }).click();
  await page.getByRole('alert').filter({ hasText: 'Public Esplora is unavailable' }).waitFor();
  await capture('provider-error');
  assert.deepEqual(errors.splice(0).filter(error => !error.includes('503')), []);
  failDiscovery = false; discoveryDelay = 2000;
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Discover and download credentials' }).click();
  await page.getByRole('button', { name: 'Discovering and validating…' }).waitFor();
  await capture('credentials-loading');
  const downloadPath = join(evidence, 'audit-credentials.json');
  await (await download).saveAs(downloadPath);
  await chmod(downloadPath, 0o644); // Exercise ordinary browser-download permissions.
  await page.getByRole('status').filter({ hasText: 'Credentials downloaded' }).waitFor();
  await capture('credentials-downloaded');
  run(bin, ['import-credentials', configPath, downloadPath]);
  await unlink(downloadPath);
  const credentialsPath = join(serviceDirectory, 'audit-credentials.json');
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.equal(credentials.schema, 'damp-audit-credentials/v1');
  assert.equal(JSON.stringify(credentials).includes(fixture.mnemonic), false);
  assert.deepEqual(Object.keys(credentials).sort(), ['auditSecret', 'certificateJson', 'certificateSignature', 'deployment', 'holderAddress', 'issuerOpenings', 'reportSecret', 'schema']);
  // Independent offline parity check, performed after the normal browser journey.
  run(bin, ['prepare-export', configPath, join(directory, 'deployment.json'), join(directory, 'export')]);
  run(join(root, 'target/debug/damp-audit'), ['export-audit-credentials', join(directory, 'issuer-wallet'), 'elements-regtest', join(directory, 'export/request.json'), join(directory, 'offline-credentials.json')]);
  const offline = JSON.parse(await readFile(join(directory, 'offline-credentials.json'), 'utf8'));
  for (const key of ['auditSecret', 'reportSecret', 'issuerOpenings']) assert.deepEqual(credentials[key], offline[key]);
  await page.getByText('Offline transaction files', { exact: true }).click();
  await capture('offline-empty');
  await page.getByLabel('Issuer transaction hex files').setInputFiles({ name: 'bad.hex', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
  await page.getByRole('button', { name: 'Download from offline files' }).click();
  await page.getByRole('alert').filter({ hasText: 'lowercase hex' }).waitFor();
  await capture('offline-error');
  await page.getByText('Export issuer audit credentials', { exact: true }).click();
  const service = await launch(bin, ['serve', configPath], /listening at (http:\/\/127\.0\.0\.1:\d+)\/report/);
  reportOrigin = service.match[1];
  await page.getByLabel('Report endpoint').fill(`${reportOrigin}/report`);
  await page.getByText('Service and network requirements', { exact: true }).click();
  await capture('report-requirements');
  await capture('report-focus', async () => { await page.getByLabel('Access token', { exact: true }).focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); });
  await page.getByLabel('Access token', { exact: true }).fill('wrong-token');
  await page.getByRole('button', { name: 'Generate signed report' }).click();
  await page.getByText(/Authentication failed\. Enter/).waitFor();
  await capture('report-auth-error');
  assert.deepEqual(errors.splice(0).filter(error => !error.includes('401')), []);
  await page.getByLabel('Access token', { exact: true }).fill(await readFile(join(serviceDirectory, 'access-token'), 'utf8'));
  await page.getByRole('button', { name: 'Generate signed report' }).click();
  await page.getByRole('button', { name: 'Download signed JSON' }).waitFor({ timeout: 120000 });
  await page.getByRole('heading', { name: 'Supply reconciled' }).waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  const reportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download signed JSON' }).click();
  await (await reportDownload).saveAs(join(evidence, 'downloaded-report.json'));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(evidence, 'downloaded-report.json'), 'utf8'))).sort(), ['reportJson', 'signature']);
  const verified = JSON.parse(run(bin, ['verify', join(directory, 'deployment.json'), join(evidence, 'downloaded-report.json')]));
  assert.equal(verified.complete, true); assert.equal(verified.signaturesVerified, true);
  assert.equal(verified.supply.knownUnspent, deployment.issuedSupply);
  await capture('report-complete');
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '320px overflow');
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'metrics.json'), JSON.stringify(metrics, null, 2));
  await writeFile(join(evidence, 'public-requests.json'), JSON.stringify(publicCalls, null, 2));
  await writeFile(join(evidence, 'README.md'), `# Fresh-user reporting evidence\n\nPASS. Actual desktop 1440×1100 and mobile 390×844 Chrome screenshots, plus a 320px overflow check. Started with an empty browser profile. Visible UI configured regtest Esplora, imported the public manifest from the fixture registry and verified live anchor/policy, connected the existing synthetic issuer, discovered public history, validated it in WASM, and downloaded restricted credentials. No IndexedDB/localStorage injection or prepared credential file supplied to the app. Native init, import-credentials, serve, health-independent report request, download and native verify ran with empty PATH. Import accepted an ordinary mode-644 download, created mode-600 credentials, and the download was deleted. Offline export was used only afterward as an independent parity check.\n\nInputs: the synthetic chain operator provides a public registry URL, Esplora URL, RPC port and cookie path; the issuer owns the fixture BIP39 phrase. The report token comes from damp-report init. Public provider and registry ran as loopback HTTP fixtures; Rust HTTP, recovery, signatures and WASM were real. No external network, broadcast or live wallet used. The scripthash fixture returns no wallet balance; funding is unnecessary for export.\n\nStates: no deployment, signer empty/invalid/regtest, provider empty/unavailable, imported deployment, disconnected/ready/focused/loading/downloaded credentials, optional offline empty/invalid, report requirements/focus/authentication failure, complete report. Both image sets must be viewed by Astra and exact Fable before UX approval. This log records execution, not visual approval.\n`);
  console.log(`PASS: fresh-user UI import, automatic export, native import, Rust report and verified download. Evidence: ${evidence}`);
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true });
  await writeFile(join(evidence, 'failure.txt'), String(error) + '\n' + (await page?.locator('body').innerText()));
  console.error(`Evidence for failed run: ${evidence}`);
  throw error;
} finally {
  await browser?.close();
  publicServer?.closeAllConnections();
  publicServer?.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
}
