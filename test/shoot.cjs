const puppeteer = require('/tmp/shotenv/node_modules/puppeteer-core');
const [,, url = 'http://localhost:8790/', out = 'shot.png', w = '1440', h = '900', waitMs = '14000', action = ''] = process.argv;
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage();
  const errs = [];
  p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('requestfailed', r => errs.push('reqfail: ' + r.url() + ' ' + r.failure()?.errorText));
  await p.setViewport({ width: +w, height: +h, deviceScaleFactor: +w < 500 ? 2 : 1, isMobile: +w < 500, hasTouch: +w < 500 });
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, +waitMs));
  if (action === 'click2') { await p.evaluate(() => document.querySelectorAll('.conv')[1]?.click()); await new Promise(r => setTimeout(r, 6000)); }
  await p.screenshot({ path: out });
  const info = await p.evaluate(() => ({ caption: document.getElementById('captionMain').textContent, title: document.getElementById('panelTitle').textContent, convs: document.querySelectorAll('.conv').length, srcs: [...document.querySelectorAll('.src')].map(s => s.textContent + ':' + s.className), note: document.querySelector('.note')?.textContent }));
  console.log(JSON.stringify(info, null, 1));
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none');
  await b.close();
})();
