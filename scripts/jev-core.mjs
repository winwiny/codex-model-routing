import { TypeSafeClient } from '@typesafe-ai/sdk';
import { MODEL } from './jev-constants.mjs';
import { credentialStatus, resolveCredential } from './jev-credentials.mjs';
import { JevError, stableError } from './jev-errors.mjs';
import { parseAndNormalizeRequest, ResultSchema } from './jev-schemas.mjs';
import { assertSafeRequest } from './jev-security.mjs';

function validateAnswerIds(request, result) {
  const expected = Object.keys(request.questions).sort();
  const actual = Object.keys(result.answers ?? {}).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new JevError('response_schema_invalid', 'The response answer IDs do not match the request.');
  }
  for (const id of expected) {
    const answer = result.answers[id];
    if (!answer || answer.type !== request.questions[id].type) {
      throw new JevError('response_schema_invalid', 'The response answer type is invalid.');
    }
    const unit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    const probabilitiesValid = (value) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length > 0 && Object.values(value).every(unit);
    if (answer.type === 'noul' && !unit(answer.noul)) {
      throw new JevError('response_schema_invalid', 'The Noul answer is invalid.');
    }
    if (answer.type === 'choice') {
      const criteria = request.questions[id].criteria;
      if (!Object.hasOwn(criteria, answer.choice) || !unit(answer.confidence)
        || !probabilitiesValid(answer.probabilities)
        || Object.keys(criteria).some((label) => !Object.hasOwn(answer.probabilities, label))) {
        throw new JevError('response_schema_invalid', 'The Choice answer is invalid.');
      }
    }
    if (answer.type === 'score' && (!Number.isFinite(answer.score) || !unit(answer.confidence)
      || !probabilitiesValid(answer.probabilities) || !answer.legend
      || typeof answer.legend !== 'object' || Array.isArray(answer.legend))) {
      throw new JevError('response_schema_invalid', 'The Score answer is invalid.');
    }
  }
}

function officialAnswers(answers) {
  return Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
    if (answer.type === 'noul') return [id, { type: 'noul', noul: answer.noul }];
    if (answer.type === 'choice') return [id, {
      type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities
    }];
    return [id, {
      type: 'score', score: answer.score, confidence: answer.confidence,
      legend: answer.legend, probabilities: answer.probabilities
    }];
  }));
}

export async function getCredentialStatus(options = {}) {
  return credentialStatus(options);
}

export async function evaluateJev(input, options = {}) {
  try {
    assertSafeRequest(input);
    const request = parseAndNormalizeRequest(input);
    const credential = options.credential ?? await resolveCredential(options);
    if (!credential?.apiKey) throw new JevError('credential_missing', 'No TypeSafe credential is configured.', 3);
    const client = options.clientFactory
      ? options.clientFactory({ apiKey: credential.apiKey, request })
      : new TypeSafeClient({
        apiKey: credential.apiKey,
        defaultModel: MODEL,
        timeout: request.timeoutMs,
        retry: { maxRetries: request.maxRetries },
        logLevel: 'off'
      });
    const result = await client.systemOne({
      state: request.state,
      questions: request.questions,
      model: MODEL
    });
    validateAnswerIds(request, result);
    const output = {
      status: 'success',
      provider: 'typesafe-direct',
      model: result.model,
      answers: officialAnswers(result.answers),
      usage: {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        totalTokens: result.usage.input_tokens + result.usage.output_tokens
      }
    };
    const parsed = ResultSchema.safeParse(output);
    if (!parsed.success) throw new JevError('response_schema_invalid', 'The response schema is invalid.');
    return parsed.data;
  } catch (error) {
    throw stableError(error);
  }
}
