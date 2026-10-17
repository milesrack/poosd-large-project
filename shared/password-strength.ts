import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import {
  adjacencyGraphs,
  dictionary as common,
} from "@zxcvbn-ts/language-common";
import { dictionary as english, translations } from "@zxcvbn-ts/language-en";

const estimator = new ZxcvbnFactory({
  dictionary: { ...common, ...english },
  graphs: adjacencyGraphs,
  translations,
});

export function passwordStrength(password: string) {
  const { score } = estimator.check(password.normalize("NFKC"), [
    "zetafly",
    "zetamac",
  ]);

  return score;
}
