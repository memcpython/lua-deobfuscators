export class DevirtualizationError extends Error {
  constructor(phase, message, options = {}) {
    super(`[${phase}] ${message}`, options);
    this.name = 'DevirtualizationError';
    this.phase = phase;
  }
}

export function runPhase(phase, fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DevirtualizationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DevirtualizationError(phase, message, { cause: error });
  }
}
