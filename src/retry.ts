// Réessaie un appel à l'API Gmail quand la limite de débit est atteinte.
//
// Gmail répond 429, ou 403 avec un motif « rate limit / quota », quand on va trop vite.
// On attend alors de plus en plus longtemps (1 s, 2 s, 4 s…) avant de réessayer.

// 8 tentatives : jusqu'à ~2 min d'attente cumulée, de quoi couvrir une fenêtre de quota par minute.
const MAX_ATTEMPTS = 8;

export function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}

export async function withRetry<T>(call: () => Promise<T>, attempts = MAX_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!isRateLimited(err) || attempt >= attempts) throw err;
      const delayMs = 1000 * 2 ** (attempt - 1) + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function isRateLimited(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 429) return true;
  if (status !== 403) return false;
  const message = String((err as { message?: string })?.message ?? "");
  return /rate limit|quota exceeded|too many/i.test(message);
}
