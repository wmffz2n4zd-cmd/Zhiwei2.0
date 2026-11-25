import assert from 'node:assert/strict';
import { runCreativeProgram } from '../src/creative-program-runner.js';

// Exercise the same socket and browser that a private website request will use.
const html = '<button id="toggle">Switch</button><p id="view">Light view</p>' +
  '<script>let dark=false;document.getElementById("toggle").onclick=()=>{' +
  'dark=!dark;document.getElementById("view").textContent=dark?"Dark view":"Light view";' +
  'document.body.style.background=dark?"#222":"white";document.body.style.color=dark?"white":"#222"}</script>';

const {observations, errors} = await runCreativeProgram({html, clicks: ['toggle', 'toggle']});
assert.deepEqual(errors, [], 'The offline browser reported a page error');
assert.deepEqual(observations.map(view => view.action), [null, 'toggle', 'toggle']);
for (const [index, text] of ['Light view', 'Dark view', 'Light view'].entries()) {
  assert.ok(observations[index].text.includes(text), 'Missing expected text after browser action ' + index);
  assert.ok(observations[index].screenshot.length > 150, 'Missing screenshot');
}
assert.ok(!observations[0].screenshot.equals(observations[1].screenshot), 'Screenshots must show the change');
console.log('Offline browser ready: two clicks, three screenshots and both page states verified.');
