// Plafond d'appels à Claude par synchronisation automatique (#12).
//
// Au-delà du plafond, l'appel lève DailyBudgetReachedError : le mail n'est pas marqué traité et le
// historyId n'est pas enregistré (#5), donc le reste est repris tel quel à la synchronisation suivante.

export class DailyBudgetReachedError extends Error {}

export function withBudget<A extends unknown[], R>(
  call: (...args: A) => Promise<R>,
  max: number,
): { call: (...args: A) => Promise<R>; used: () => number } {
  let used = 0;
  return {
    call: async (...args: A) => {
      if (used >= max) throw new DailyBudgetReachedError(`Plafond de ${max} mails envoyés à Claude atteint.`);
      used++;
      return call(...args);
    },
    used: () => used,
  };
}
