import { ADVERSARIAL_RETRIEVAL_CASES } from "@lab/bench/fixtures/retrieval_transfer_adversarial_cases";
import { BASIC_RETRIEVAL_CASES } from "@lab/bench/fixtures/retrieval_transfer_basic_cases";

export type NoteFixture = {
  filename: string;
  subdir: "memories" | "experiences" | "skills";
  content: string;
};

export type RetrievalExpectation = {
  requiredDocIds?: string[];
  requiredAnyDocIds?: string[];
  bonusDocIds?: string[];
  forbiddenDocIds?: string[];
  expectEmpty?: boolean;
};

export type RetrievalTestCase = {
  id: number;
  category: string;
  question: string;
  expectation: RetrievalExpectation;
  answerCriteria: string;
  notes: NoteFixture[];
};

export type RetrievalVerdict = {
  pass: boolean;
  missing: string[];
  missingAny: string[];
  forbidden: string[];
  bonus: string[];
  emptyViolation: boolean;
};

function configuredNoiseCount(): number {
  const value = Number(process.env.RETRIEVAL_EVAL_DECOYS ?? 100);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error("RETRIEVAL_EVAL_DECOYS must be an integer from 0 to 10000");
  }
  return value;
}

export const TEST_CASES: RetrievalTestCase[] = [
  ...BASIC_RETRIEVAL_CASES,
  ...ADVERSARIAL_RETRIEVAL_CASES(configuredNoiseCount()),
];

export function evaluateRetrievedIds(ids: string[], expectation: RetrievalExpectation): RetrievalVerdict {
  const returned = new Set(ids);
  const missing = (expectation.requiredDocIds ?? []).filter((id) => !returned.has(id));
  const any = expectation.requiredAnyDocIds ?? [];
  const missingAny = any.length > 0 && !any.some((id) => returned.has(id)) ? any : [];
  const forbidden = (expectation.forbiddenDocIds ?? []).filter((id) => returned.has(id));
  const bonus = (expectation.bonusDocIds ?? []).filter((id) => returned.has(id));
  const emptyViolation = expectation.expectEmpty === true && ids.length > 0;
  return {
    pass: missing.length === 0 && missingAny.length === 0 && forbidden.length === 0 && !emptyViolation,
    missing,
    missingAny,
    forbidden,
    bonus,
    emptyViolation,
  };
}
