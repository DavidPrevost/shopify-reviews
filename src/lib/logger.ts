type Level = 'info' | 'warn' | 'error';

export const log = (level: Level, msg: string, meta?: Record<string, unknown>): void => {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
};
