// pino 日志实例
import pino from 'pino';
import config from '../config/index.js';

const logger = pino({
  level: config.logLevel,
});

export default logger;
