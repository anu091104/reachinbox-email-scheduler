import { pino } from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'reachinbox-scheduler' },
  redact: ['req.headers.cookie', 'req.headers.authorization', '*.smtpPass', '*.password'],
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' } }
      : undefined,
});
