// Query helpers for the Campaign Feedback Forms feature. Self-contained per
// the convention of one query module per top-level feature.
//
// Access model: every form has an access_key (URL-safe random string).
// Participants reach a form via /pages/<form-page>?key=<access_key>;
// responses are anonymous unless the participant fills in name + email.

import crypto from 'node:crypto';
import { getDb } from './client.js';
import { nowSec } from '../lib/time.js';

// --- Enums ---

export const FEEDBACK_QUESTION_TYPES = [
  'rating_1_5',
  'single_choice',
  'multi_choice',
  'short_text',
  'long_text',
] as const;
export type FeedbackQuestionType = typeof FEEDBACK_QUESTION_TYPES[number];

export const isFeedbackQuestionType = (v: unknown): v is FeedbackQuestionType =>
  typeof v === 'string' && (FEEDBACK_QUESTION_TYPES as readonly string[]).includes(v);

export const FEEDBACK_QUESTION_TYPE_LABELS: Record<FeedbackQuestionType, string> = {
  rating_1_5:    'Rating (1-5)',
  single_choice: 'Single choice',
  multi_choice:  'Multi choice',
  short_text:    'Short text',
  long_text:     'Long text',
};

// --- Row types ---

export interface FeedbackFormRow {
  id: number;
  shop_id: number;
  campaign_id: number;
  shopify_product_id: string | null;
  title: string;
  intro_text: string | null;
  access_key: string;
  created_at: number;
}

export interface FeedbackQuestionRow {
  id: number;
  shop_id: number;
  form_id: number;
  position: number;
  type: FeedbackQuestionType;
  prompt: string;
  required: number;
  options_json: string | null;
  created_at: number;
}

export interface FeedbackResponseRow {
  id: number;
  shop_id: number;
  form_id: number;
  submitted_at: number;
  optional_name: string | null;
  optional_email: string | null;
  ip_hash: string | null;
}

export interface FeedbackAnswerRow {
  response_id: number;
  question_id: number;
  value_text: string | null;
  value_number: number | null;
  value_json: string | null;
}

// --- Forms ---

const generateAccessKey = (): string => {
  // URL-safe random key, 16 bytes → 22-char base64url (without padding).
  return crypto.randomBytes(16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const listFeedbackFormsForCampaign = (campaignId: number): FeedbackFormRow[] => {
  return getDb()
    .prepare('SELECT * FROM campaign_feedback_forms WHERE campaign_id = ? ORDER BY id ASC')
    .all(campaignId) as FeedbackFormRow[];
};

export const findFeedbackFormById = (id: number): FeedbackFormRow | null => {
  return (getDb()
    .prepare('SELECT * FROM campaign_feedback_forms WHERE id = ?')
    .get(id) as FeedbackFormRow | undefined) ?? null;
};

export const findFeedbackFormByAccessKey = (key: string): FeedbackFormRow | null => {
  return (getDb()
    .prepare('SELECT * FROM campaign_feedback_forms WHERE access_key = ?')
    .get(key) as FeedbackFormRow | undefined) ?? null;
};

export const createFeedbackForm = (input: {
  campaignId: number;
  shopifyProductId: string | null;
  title: string;
  introText: string | null;
}): FeedbackFormRow => {
  const now = nowSec();
  const accessKey = generateAccessKey();
  const result = getDb().prepare(`
    INSERT INTO campaign_feedback_forms
      (campaign_id, shopify_product_id, title, intro_text, access_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.campaignId,
    input.shopifyProductId,
    input.title,
    input.introText,
    accessKey,
    now,
  );
  return findFeedbackFormById(Number(result.lastInsertRowid))!;
};

export const deleteFeedbackForm = (id: number): void => {
  // ON DELETE CASCADE on questions/responses/answers handles the children.
  getDb().prepare('DELETE FROM campaign_feedback_forms WHERE id = ?').run(id);
};

// --- Questions ---

export const listFeedbackQuestionsForForm = (formId: number): FeedbackQuestionRow[] => {
  return getDb()
    .prepare('SELECT * FROM campaign_feedback_questions WHERE form_id = ? ORDER BY position ASC, id ASC')
    .all(formId) as FeedbackQuestionRow[];
};

export const findFeedbackQuestionById = (id: number): FeedbackQuestionRow | null => {
  return (getDb()
    .prepare('SELECT * FROM campaign_feedback_questions WHERE id = ?')
    .get(id) as FeedbackQuestionRow | undefined) ?? null;
};

// Inserts a new question at the end of the form's question list. The
// position is computed as max + 1, so questions land in creation order
// unless the merchant reorders explicitly later.
export const addFeedbackQuestion = (input: {
  formId: number;
  type: FeedbackQuestionType;
  prompt: string;
  required: boolean;
  options: string[] | null;
}): FeedbackQuestionRow => {
  const db = getDb();
  const now = nowSec();
  const posRow = db.prepare(`
    SELECT COALESCE(MAX(position), 0) AS max_pos FROM campaign_feedback_questions WHERE form_id = ?
  `).get(input.formId) as { max_pos: number };
  const position = posRow.max_pos + 1;
  const optionsJson = input.options ? JSON.stringify(input.options) : null;
  const result = db.prepare(`
    INSERT INTO campaign_feedback_questions
      (form_id, position, type, prompt, required, options_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.formId,
    position,
    input.type,
    input.prompt,
    input.required ? 1 : 0,
    optionsJson,
    now,
  );
  return findFeedbackQuestionById(Number(result.lastInsertRowid))!;
};

export const deleteFeedbackQuestion = (id: number): void => {
  getDb().prepare('DELETE FROM campaign_feedback_questions WHERE id = ?').run(id);
};

// Parses a question's options JSON. Returns [] for non-choice types or on
// parse failure so the renderer always has an iterable to map over.
export const parseQuestionOptions = (q: FeedbackQuestionRow): string[] => {
  if (q.type !== 'single_choice' && q.type !== 'multi_choice') return [];
  if (!q.options_json) return [];
  try {
    const parsed = JSON.parse(q.options_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
};

// --- Responses + answers ---

export interface FeedbackAnswerInput {
  questionId: number;
  valueText?: string | null;
  valueNumber?: number | null;
  valueJson?: string | null;
}

// Inserts a response and its per-question answers in one transaction.
// Callers are responsible for value-shape validation (matching the question
// type); this layer just stores what it's given.
export const submitFeedbackResponse = (input: {
  formId: number;
  optionalName: string | null;
  optionalEmail: string | null;
  ipHash: string | null;
  answers: FeedbackAnswerInput[];
}): number => {
  const db = getDb();
  const now = nowSec();
  let responseId = 0;

  db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO campaign_feedback_responses
        (form_id, submitted_at, optional_name, optional_email, ip_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.formId,
      now,
      input.optionalName,
      input.optionalEmail?.toLowerCase() ?? null,
      input.ipHash,
    );
    responseId = Number(result.lastInsertRowid);

    const insertAnswer = db.prepare(`
      INSERT INTO campaign_feedback_answers
        (response_id, question_id, value_text, value_number, value_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const a of input.answers) {
      insertAnswer.run(
        responseId,
        a.questionId,
        a.valueText ?? null,
        a.valueNumber ?? null,
        a.valueJson ?? null,
      );
    }
  })();

  return responseId;
};

// --- Reporting ---

export const countResponsesForForm = (formId: number): number => {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM campaign_feedback_responses WHERE form_id = ?')
    .get(formId) as { n: number };
  return row.n;
};

// Per-question aggregate for the admin reporting view. Returns the right
// shape per type:
//   rating_1_5    → { type, average, distribution: [n1..n5] }
//   single_choice → { type, counts: Record<option, n> }
//   multi_choice  → { type, counts: Record<option, n> }
//   short_text/long_text → { type, responses: [{ text, name?, submittedAt }] }
export type QuestionAggregate =
  | { type: 'rating_1_5'; average: number | null; distribution: [number, number, number, number, number]; total: number }
  | { type: 'single_choice'; counts: Record<string, number>; total: number }
  | { type: 'multi_choice'; counts: Record<string, number>; total: number }
  | { type: 'short_text' | 'long_text'; responses: Array<{ text: string; submittedAt: number; name: string | null }>; total: number };

const aggregateRating = (formId: number, questionId: number): QuestionAggregate => {
  const rows = getDb()
    .prepare(`
      SELECT value_number FROM campaign_feedback_answers
       WHERE question_id = ? AND value_number IS NOT NULL
    `)
    .all(questionId) as Array<{ value_number: number }>;
  void formId;
  const dist: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  let total = 0;
  for (const r of rows) {
    const n = Math.round(r.value_number);
    if (n >= 1 && n <= 5) {
      // The bounds check guarantees the index, but TS narrows tuple index
      // access conservatively — assert non-null to satisfy noUncheckedIndexedAccess.
      dist[n - 1] = (dist[n - 1]!) + 1;
      sum += n;
      total += 1;
    }
  }
  return {
    type: 'rating_1_5',
    average: total > 0 ? sum / total : null,
    distribution: dist,
    total,
  };
};

const aggregateSingleChoice = (formId: number, questionId: number): QuestionAggregate => {
  void formId;
  const rows = getDb()
    .prepare(`SELECT value_text FROM campaign_feedback_answers WHERE question_id = ? AND value_text IS NOT NULL`)
    .all(questionId) as Array<{ value_text: string }>;
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.value_text] = (counts[r.value_text] ?? 0) + 1;
  }
  return { type: 'single_choice', counts, total: rows.length };
};

const aggregateMultiChoice = (formId: number, questionId: number): QuestionAggregate => {
  void formId;
  // Multi-choice values are stored as a JSON array of strings in value_json.
  const rows = getDb()
    .prepare(`SELECT value_json FROM campaign_feedback_answers WHERE question_id = ? AND value_json IS NOT NULL`)
    .all(questionId) as Array<{ value_json: string }>;
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.value_json) as unknown;
      if (!Array.isArray(arr)) continue;
      total += 1;
      for (const v of arr) {
        if (typeof v !== 'string') continue;
        counts[v] = (counts[v] ?? 0) + 1;
      }
    } catch {
      // skip malformed answer
    }
  }
  return { type: 'multi_choice', counts, total };
};

const aggregateText = (
  type: 'short_text' | 'long_text',
  questionId: number,
): QuestionAggregate => {
  const rows = getDb()
    .prepare(`
      SELECT a.value_text, r.optional_name, r.submitted_at
        FROM campaign_feedback_answers a
        JOIN campaign_feedback_responses r ON r.id = a.response_id
       WHERE a.question_id = ?
         AND a.value_text IS NOT NULL
       ORDER BY r.submitted_at DESC
    `)
    .all(questionId) as Array<{ value_text: string; optional_name: string | null; submitted_at: number }>;
  return {
    type,
    responses: rows.map((r) => ({
      text: r.value_text,
      name: r.optional_name,
      submittedAt: r.submitted_at,
    })),
    total: rows.length,
  };
};

export const aggregateFeedbackQuestion = (q: FeedbackQuestionRow): QuestionAggregate => {
  switch (q.type) {
    case 'rating_1_5':    return aggregateRating(q.form_id, q.id);
    case 'single_choice': return aggregateSingleChoice(q.form_id, q.id);
    case 'multi_choice':  return aggregateMultiChoice(q.form_id, q.id);
    case 'short_text':
    case 'long_text':     return aggregateText(q.type, q.id);
  }
};
