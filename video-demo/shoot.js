const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const dir = process.cwd();
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport:{width:1920,height:1080} });
  const p = await ctx.newPage();
  for (let f=0; f<10; f++){
    await p.goto('file://'+path.join(dir,'render-static.html')+'?f='+f, { waitUntil:'load' });
    await p.waitForTimeout(400);
    await p.screenshot({ path: 'f'+f+'.png' });
  }
  await b.close(); console.log('shot 10 frames');
})().catch(e=>{console.error(e);process.exit(1)});
