const fs = require('fs');
const path = require('path');
const ui = require('../ui-state');
const screen = require('../screen');

const sp = screen.getScreenSize('R94Y60BCW2T');
const cases = [
  ['preview', 'R94Y60BCW2T_follow-205-chuyen-video_edit_1781333185338.xml'],
  ['editor', 'R94Y60BCW2T_state_1781333809068.xml'],
];

for (const [name, file] of cases) {
  const xml = fs.readFileSync(path.join(__dirname, '..', 'screenshots', file), 'utf8');
  const detected = ui.detectScreen(xml, sp);
  const tiep = ui.findNextButton(xml, sp);
  console.log(name, {
    detected,
    tiep: tiep ? { rid: tiep.resourceId.split('/').pop(), cx: tiep.centerX, cy: tiep.centerY } : null,
  });
}
