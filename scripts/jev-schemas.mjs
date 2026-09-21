import { z } from 'zod';
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, MAX_QUESTIONS, MODEL } from './jev-constants.mjs';

export const JsonValueSchema = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)
]));

// Official EntryType: string | JSON object | JSON array | null.
export const EntrySchema = z.union([
  z.string(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)
]);

const InstructionsSchema = EntrySchema.optional();
const NoulCriteriaSchema = z.object({
  true: EntrySchema.optional(),
  false: EntrySchema.optional()
}).strict();

const NoulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: InstructionsSchema,
  criteria: NoulCriteriaSchema.nullable().optional()
}).strict();

const BooleanQuestionSchema = z.object({
  type: z.literal('boolean'),
  instructions: InstructionsSchema,
  criteria: NoulCriteriaSchema.nullable().optional()
}).strict();

const ChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: InstructionsSchema,
  criteria: z.record(z.string().min(1).max(120), EntrySchema)
    .refine((value) => Object.keys(value).length >= 2, 'Choice requires at least two options.')
    .refine((value) => Object.keys(value).length <= 255, 'Choice supports at most 255 options.')
}).strict();

const ScoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: InstructionsSchema,
  criteria: z.array(EntrySchema).min(2).max(10)
}).strict();

export const QuestionSchema = z.discriminatedUnion('type', [
  NoulQuestionSchema, BooleanQuestionSchema, ChoiceQuestionSchema, ScoreQuestionSchema
]);

export const QuestionsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/),
  QuestionSchema
).refine((value) => Object.keys(value).length >= 1, 'At least one question is required.')
  .refine((value) => Object.keys(value).length <= MAX_QUESTIONS, `At most ${MAX_QUESTIONS} questions are allowed.`);

export const RequestSchema = z.object({
  state: EntrySchema,
  questions: QuestionsSchema,
  model: z.literal(MODEL).optional().default(MODEL),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional().default(DEFAULT_TIMEOUT_MS),
  maxRetries: z.number().int().min(0).max(5).optional().default(DEFAULT_MAX_RETRIES)
}).strict();

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
}).strict();

export const ResultSchema = z.object({
  status: z.literal('success'),
  provider: z.literal('typesafe-direct'),
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: UsageSchema
}).strict();

export function normalizeQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [
    id,
    question.type === 'boolean' ? { ...question, type: 'noul' } : question
  ]));
}

export function parseAndNormalizeRequest(input) {
  const parsed = RequestSchema.parse(input);
  return { ...parsed, questions: normalizeQuestions(parsed.questions) };
}
