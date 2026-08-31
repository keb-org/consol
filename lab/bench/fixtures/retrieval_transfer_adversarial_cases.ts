import { ADVERSARIAL_CASES_11_15 } from "@lab/bench/fixtures/retrieval_transfer_adversarial_cases_11_15";
import { adversarialCases16To20 } from "@lab/bench/fixtures/retrieval_transfer_adversarial_cases_16_20";
import type { RetrievalTestCase } from "@lab/bench/retrieval_transfer_cases";

export function ADVERSARIAL_RETRIEVAL_CASES(noiseCount: number): RetrievalTestCase[] {
  return [
    ...ADVERSARIAL_CASES_11_15,
    ...adversarialCases16To20(noiseCount),
  ];
}
