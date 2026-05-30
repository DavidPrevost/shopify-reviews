// Public hosted feedback landing pages — the URL we put in campaign emails.
// Lives at /feedback/:key (not under /proxy/ — no App Proxy involved). The
// page is server-rendered HTML with a native form POST so it works without
// JavaScript and without any merchant setup (no Shopify Page to create).
//
// Anonymous by design — no auth, no cookies, IP-rate-limited on submit. The
// access key in the URL is the only gate; it should only have been shared
// via the campaign emails sent to participants.

import crypto from 'node:crypto';
import { Hono } from 'hono';
import {
  findFeedbackFormByAccessKey,
  listFeedbackQuestionsForForm,
  parseQuestionOptions,
  submitFeedbackResponse,
  isFeedbackQuestionType,
  type FeedbackFormRow,
  type FeedbackQuestionRow,
} from '../db/feedback.js';
import { escapeHtml } from '../email/render.js';
import { getSetting } from '../db/queries.js';
import { resolveBrandColors } from '../shopify/brand-info.js';
import { take as rateLimitTake } from '../lib/rate-limit.js';
import { log } from '../lib/logger.js';

const feedbackLanding = new Hono();

const FEEDBACK_LANDING_RATE_LIMIT = 20;
const FEEDBACK_LANDING_WINDOW_SEC = 60;

const hashIp = (ip: string): string =>
  crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);

const getClientIp = (c: import('hono').Context): string => {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '') ??
    'unknown'
  ) || 'unknown';
};

// Shared shell — minimal, mobile-friendly, picks up brand colors from the
// stored shop_brand_json so the page doesn't feel completely off-brand.
const renderShell = (input: { title: string; body: string }): string => {
  const colors = resolveBrandColors(getSetting('shop_brand_json'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root {
      --accent: ${colors.ctaBackground};
      --accent-text: ${colors.ctaForeground};
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      margin: 0; padding: 0; background: #fafafa; color: #222;
      line-height: 1.5;
    }
    main { max-width: 640px; margin: 0 auto; padding: 32px 20px; }
    h1 { margin: 0 0 8px; font-size: 26px; font-weight: 600; }
    p.intro { margin: 0 0 24px; color: #555; }
    .card { background: #fff; padding: 24px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .question { margin: 0 0 24px; }
    .question-prompt { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
    .required-mark { color: #b00; margin-left: 4px; }
    input[type=text], input[type=email], textarea {
      width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 4px;
      font-size: 15px; font-family: inherit;
    }
    .rating-options, .choice-options { display: flex; flex-wrap: wrap; gap: 12px; }
    .rating-options label, .choice-options label {
      display: inline-flex; align-items: center; gap: 6px; font-weight: normal;
      cursor: pointer; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px;
      background: #f7f7f7;
    }
    .rating-options input, .choice-options input { margin: 0; }
    button[type=submit] {
      background: var(--accent); color: var(--accent-text);
      border: none; padding: 12px 24px; font-size: 16px; font-weight: 600;
      border-radius: 4px; cursor: pointer;
    }
    button[type=submit]:hover { opacity: 0.9; }
    .err { background: #fee; border: 1px solid #fcc; color: #933; padding: 12px; border-radius: 4px; margin-bottom: 16px; }
    .ok { padding: 24px; background: #efe; border-radius: 8px; }
    .ok h1 { color: #2d572c; }
    footer { text-align: center; padding: 24px; color: #888; font-size: 12px; }
  </style>
</head>
<body>
  <main>${input.body}</main>
</body>
</html>`;
};

const renderQuestionHtml = (q: FeedbackQuestionRow): string => {
  const required = q.required === 1 ? '<span class="required-mark">*</span>' : '';
  const name = `q_${q.id}`;
  const promptHtml = `<div class="question-prompt">${escapeHtml(q.prompt)}${required}</div>`;
  const requiredAttr = q.required === 1 ? 'required' : '';

  if (q.type === 'rating_1_5') {
    const radios = [1, 2, 3, 4, 5].map((n) => `
      <label><input type="radio" name="${name}" value="${n}" ${requiredAttr} /><span>${n}</span></label>
    `).join('');
    return `<div class="question">${promptHtml}<div class="rating-options">${radios}</div></div>`;
  }
  if (q.type === 'single_choice') {
    const radios = parseQuestionOptions(q).map((opt) => `
      <label><input type="radio" name="${name}" value="${escapeHtml(opt)}" ${requiredAttr} /><span>${escapeHtml(opt)}</span></label>
    `).join('');
    return `<div class="question">${promptHtml}<div class="choice-options">${radios}</div></div>`;
  }
  if (q.type === 'multi_choice') {
    const boxes = parseQuestionOptions(q).map((opt) => `
      <label><input type="checkbox" name="${name}" value="${escapeHtml(opt)}" /><span>${escapeHtml(opt)}</span></label>
    `).join('');
    return `<div class="question">${promptHtml}<div class="choice-options">${boxes}</div></div>`;
  }
  if (q.type === 'short_text') {
    return `<div class="question">${promptHtml}<input type="text" name="${name}" maxlength="500" ${requiredAttr} /></div>`;
  }
  // long_text
  return `<div class="question">${promptHtml}<textarea name="${name}" rows="4" maxlength="5000" ${requiredAttr}></textarea></div>`;
};

const renderForm = (form: FeedbackFormRow, questions: FeedbackQuestionRow[], errorMsg?: string): string => {
  const errHtml = errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : '';
  const questionsHtml = questions.map(renderQuestionHtml).join('');
  const introHtml = form.intro_text
    ? `<p class="intro">${escapeHtml(form.intro_text)}</p>`
    : '';
  return renderShell({
    title: form.title,
    body: `
      <h1>${escapeHtml(form.title)}</h1>
      ${introHtml}
      ${errHtml}
      <form method="POST" action="/feedback/${encodeURIComponent(form.access_key)}" class="card">
        ${questionsHtml}
        <div class="question">
          <label for="optionalName">Name (optional)</label>
          <input type="text" name="optionalName" id="optionalName" maxlength="160" />
        </div>
        <div class="question">
          <label for="optionalEmail">Email (optional)</label>
          <input type="email" name="optionalEmail" id="optionalEmail" maxlength="254" />
        </div>
        <p style="font-size:12px; color:#666; margin: 0 0 16px;">Your response is anonymous unless you fill in name and email above.</p>
        <button type="submit">Submit feedback</button>
      </form>
      <footer>Powered by self-hosted reviews</footer>
    `,
  });
};

// GET /feedback/:key — render the form
feedbackLanding.get('/feedback/:key', (c) => {
  const key = c.req.param('key');
  const form = findFeedbackFormByAccessKey(key);
  if (!form) {
    return c.html(renderShell({
      title: 'Form not found',
      body: '<div class="card"><h1>Form not found</h1><p>This feedback form is not available. Check the URL or contact the merchant.</p></div>',
    }), 404);
  }
  const questions = listFeedbackQuestionsForForm(form.id);
  return c.html(renderForm(form, questions));
});

// POST /feedback/:key — handle native form submission
feedbackLanding.post('/feedback/:key', async (c) => {
  const key = c.req.param('key');
  const ip = getClientIp(c);
  if (!rateLimitTake(`feedback-landing:${ip}`, FEEDBACK_LANDING_RATE_LIMIT, FEEDBACK_LANDING_WINDOW_SEC)) {
    return c.html(renderShell({
      title: 'Too many submissions',
      body: '<div class="card"><h1>Too many submissions</h1><p>Please wait a minute and try again.</p></div>',
    }), 429);
  }

  const form = findFeedbackFormByAccessKey(key);
  if (!form) return c.notFound();
  const questions = listFeedbackQuestionsForForm(form.id);

  // parseBody({all:true}) returns string|File for single-valued names and
  // (string|File)[] for multi-valued ones (checkbox groups). We narrow each
  // value to string before storing — file uploads aren't supported here.
  const body = await c.req.parseBody({ all: true });

  const answers: Array<{
    questionId: number;
    valueText?: string | null;
    valueNumber?: number | null;
    valueJson?: string | null;
  }> = [];
  const missingRequired: number[] = [];

  for (const q of questions) {
    if (!isFeedbackQuestionType(q.type)) continue;
    const rawVal = body[`q_${q.id}`];

    if (q.type === 'rating_1_5') {
      const v = typeof rawVal === 'string' ? Number(rawVal) : NaN;
      if (Number.isInteger(v) && v >= 1 && v <= 5) {
        answers.push({ questionId: q.id, valueNumber: v });
      } else if (q.required === 1) {
        missingRequired.push(q.id);
      }
    } else if (q.type === 'single_choice') {
      const v = typeof rawVal === 'string' ? rawVal : '';
      if (v && parseQuestionOptions(q).includes(v)) {
        answers.push({ questionId: q.id, valueText: v });
      } else if (q.required === 1) {
        missingRequired.push(q.id);
      }
    } else if (q.type === 'multi_choice') {
      const arr = Array.isArray(rawVal)
        ? rawVal.filter((v): v is string => typeof v === 'string')
        : (typeof rawVal === 'string' ? [rawVal] : []);
      const opts = new Set(parseQuestionOptions(q));
      const filtered = arr.filter((v) => opts.has(v));
      if (filtered.length > 0) {
        answers.push({ questionId: q.id, valueJson: JSON.stringify(filtered) });
      } else if (q.required === 1) {
        missingRequired.push(q.id);
      }
    } else {
      // text types
      const s = typeof rawVal === 'string' ? rawVal.trim().slice(0, 5000) : '';
      if (s) {
        answers.push({ questionId: q.id, valueText: s });
      } else if (q.required === 1) {
        missingRequired.push(q.id);
      }
    }
  }

  if (missingRequired.length > 0) {
    return c.html(
      renderForm(form, questions, 'Please answer all required questions before submitting.'),
      400,
    );
  }

  const optionalName = typeof body.optionalName === 'string'
    ? body.optionalName.trim().slice(0, 160) || null
    : null;
  const optionalEmail = typeof body.optionalEmail === 'string'
    ? body.optionalEmail.trim().toLowerCase().slice(0, 254) || null
    : null;

  const responseId = submitFeedbackResponse({
    formId: form.id,
    optionalName,
    optionalEmail,
    ipHash: hashIp(ip),
    answers,
  });
  log('info', 'feedback landing response submitted', { formId: form.id, responseId });

  return c.html(renderShell({
    title: 'Thanks for your feedback',
    body: `
      <div class="ok">
        <h1>Thanks!</h1>
        <p>Your feedback has been recorded. You can close this tab.</p>
      </div>
    `,
  }));
});

export default feedbackLanding;
