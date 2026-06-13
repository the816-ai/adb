const assert = require('assert');
const ui = require('../ui-state');
const screen = require('../screen');
const { evaluatePublishState } = require('../result-verifier');

const profile = screen.getScreenSize('test-device');

function fakeXml(screenName, extras = {}) {
  const parts = [];
  if (screenName === 'posting') {
    parts.push('<node text="Đang đăng..." clickable="true" bounds="[0,0][100,100]"/>');
  }
  if (screenName === 'post_edit') {
    parts.push('<node text="Đăng" clickable="true" bounds="[950,50][1050,150]"/>');
    parts.push('<node text="Thêm mô tả" clickable="true" bounds="[50,100][500,300]"/>');
  }
  if (screenName === 'main') {
    parts.push('<node text="Trang chủ" clickable="true" bounds="[50,2200][200,2350]"/>');
    parts.push('<node text="Quay" clickable="true" bounds="[450,2200][600,2350]"/>');
    parts.push('<node desc="Thích" clickable="true" bounds="[980,900][1050,980]"/>');
  }
  if (extras.toast) {
    parts.push('<node text="Video đã được đăng" clickable="false" bounds="[100,100][900,200]"/>');
  }
  if (extras.error) {
    parts.push('<node text="Failed" clickable="true" bounds="[100,500][300,600]"/>');
  }
  return `<hierarchy>${parts.join('')}</hierarchy>`;
}

function run() {
  const posting = evaluatePublishState(fakeXml('posting'), profile, { sawPosting: false });
  assert.strictEqual(posting.ok, false);
  assert.strictEqual(posting.code, 'POSTING');

  const completed = evaluatePublishState(fakeXml('main'), profile, {
    sawPosting: true,
    postingPollCount: 1,
    postingEnded: true,
  });
  assert.strictEqual(completed.ok, true, 'postingEnded should confirm success');
  assert.strictEqual(completed.via, 'posting_completed');

  const toast = evaluatePublishState(fakeXml('main', { toast: true }), profile, {
    sawPosting: true,
    postingPollCount: 1,
  });
  assert.strictEqual(toast.ok, true, 'toast with sawPosting should succeed');

  const toastNoPost = evaluatePublishState(fakeXml('main', { toast: true }), profile, {
    sawPosting: false,
  });
  assert.strictEqual(toastNoPost.ok, false, 'toast without posting must fail');

  const stillEdit = evaluatePublishState(fakeXml('post_edit'), profile, {
    sawPosting: true,
    postingPollCount: 2,
  });
  assert.strictEqual(stillEdit.ok, false);
  assert.strictEqual(stillEdit.code, 'STILL_IN_FLOW');

  const fastComplete = evaluatePublishState(fakeXml('main'), profile, {
    sawPosting: true,
    postingPollCount: 0,
    postConfirmVia: 'fast_complete',
    elapsedMs: 1500,
  });
  assert.strictEqual(fastComplete.ok, true, 'fast_complete from click_post must succeed on main');
  assert.strictEqual(fastComplete.via, 'confirmed_fast_complete');

  const fastTooSoon = evaluatePublishState(fakeXml('main'), profile, {
    sawPosting: true,
    postConfirmVia: 'fast_complete',
    elapsedMs: 100,
  });
  assert.strictEqual(fastTooSoon.ok, false, 'must wait before trusting fast_complete');

  const postButtonGone = evaluatePublishState(fakeXml('main'), profile, {
    sawPosting: true,
    postingPollCount: 0,
    postConfirmVia: 'post_button_gone',
    elapsedMs: 1500,
  });
  assert.strictEqual(postButtonGone.ok, true, 'post_button_gone must confirm success');

  console.log('test-post-verifier: all passed');
}

run();
