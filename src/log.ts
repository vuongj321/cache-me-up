/**
 * Tiny dependency-free logging helper. Level is controlled by `LOG_LEVEL`
 * (debug | info | warn | error), default `info`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.message}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

export function createLogger(level: string | undefined = 'info'): Logger {
  const threshold = LEVEL_WEIGHT[isLogLevel(level) ? level : 'info'];

  const write = (lvl: LogLevel, message: string, meta?: unknown): void => {
    if (LEVEL_WEIGHT[lvl] < threshold) return;
    const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${message}${formatMeta(meta)}`;
    if (lvl === 'error' || lvl === 'warn') {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}
