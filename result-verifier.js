const ui = require('./ui-state');
const screen = require('./screen');

const SAW_POSTING_MIN_POLLS = parseInt(process.env.SAW_POSTING_MIN_POLLS || '2', 10);

const TRUSTED_POST_CONFIRM_VIAS = new Set([
  'posting_ui',
  'fast_complete',
  'post_button_gone',
  'left_app_after_post',
  'success_toast_early',
]);

function evaluatePublishState(xml, screenProfile, options = {}) {
  const {
    sawPosting = false,
    postingPollCount = 0,
    postingEnded = false,
    postConfirmVia = null,
    elapsedMs = 0,
  } = options;

  if (!xml) {
    return { ok: false, code: 'NO_UI', reason: 'empty_xml' };
  }

  if (ui.findInXml(xml, 'error')) {
    return { ok: false, code: 'POST_FAILED', reason: 'error_dialog' };
  }

  const detected = ui.detectScreen(xml, screenProfile);
  const postZone = screen.getZone(screenProfile, 'post_button');
  const postVisible = ui.findInXml(xml, 'post', { zone: postZone });
  const inMain = ui.MAIN_SCREENS.includes(detected);
  const notInFlow = !ui.isStillInPublishFlow(xml, screenProfile);
  const isPostingNow = ui.findInXml(xml, 'posting') || detected === ui.SCREENS.POSTING;

  if (isPostingNow) {
    return {
      ok: false,
      code: 'POSTING',
      reason: 'still_posting',
      sawPosting: true,
      postingPollCount: postingPollCount + 1,
    };
  }

  if (detected === ui.SCREENS.LOGIN) {
    return { ok: false, code: 'NOT_LOGGED_IN', reason: 'login_screen' };
  }

  const successBase = sawPosting && notInFlow && inMain && !postVisible;

  if (successBase && postingEnded) {
    return { ok: true, code: 'PUBLISH_OK', screen: detected, via: 'posting_completed' };
  }

  if (successBase && postingPollCount >= SAW_POSTING_MIN_POLLS) {
    return { ok: true, code: 'PUBLISH_OK', screen: detected, via: 'saw_posting' };
  }

  if (
    successBase
    && postConfirmVia
    && TRUSTED_POST_CONFIRM_VIAS.has(postConfirmVia)
    && elapsedMs >= 800
  ) {
    return { ok: true, code: 'PUBLISH_OK', screen: detected, via: `confirmed_${postConfirmVia}` };
  }

  if (ui.findInXml(xml, 'upload_success')) {
    if (sawPosting && notInFlow && !postVisible) {
      return { ok: true, code: 'PUBLISH_OK', screen: detected, via: 'success_toast' };
    }
    return { ok: false, code: 'POST_PENDING_CONFIRM', reason: 'toast_without_posting_evidence' };
  }

  if (!sawPosting) {
    if (postVisible) {
      return { ok: false, code: 'POST_NOT_STARTED', reason: 'post_button_visible' };
    }
    if (ui.isStillInPublishFlow(xml, screenProfile)) {
      return { ok: false, code: 'STILL_IN_FLOW', reason: detected };
    }
    return { ok: false, code: 'POST_NOT_STARTED', reason: 'never_saw_posting' };
  }

  if (ui.isStillInPublishFlow(xml, screenProfile)) {
    return { ok: false, code: 'STILL_IN_FLOW', reason: detected };
  }

  if (postVisible) {
    return { ok: false, code: 'POST_STILL_VISIBLE', reason: 'post_button_visible' };
  }

  if (!inMain) {
    return { ok: false, code: 'UNCONFIRMED_SCREEN', reason: detected };
  }

  if (elapsedMs > 90000) {
    return { ok: false, code: 'POST_STUCK', reason: 'posting_evidence_insufficient' };
  }

  return { ok: false, code: 'POST_PENDING_CONFIRM', reason: 'awaiting_posting_confirmation' };
}

module.exports = {
  SAW_POSTING_MIN_POLLS,
  TRUSTED_POST_CONFIRM_VIAS,
  evaluatePublishState,
};
