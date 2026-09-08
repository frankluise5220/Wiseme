/**
 * Unified logging module.
 * Used to record critical errors and warnings, replacing silent exception handling.
 */

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  error?: Error | unknown;
  timestamp?: Date;
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

function formatMessage(entry: LogEntry): string {
  const timestamp = formatTimestamp(entry.timestamp ?? new Date());
  const context = entry.context ? '[' + entry.context + '] ' : '';
  const errorDetail = entry.error instanceof Error 
    ? ' ' + entry.error.message 
    : entry.error ? ' ' + String(entry.error) : '';
  
  return '[' + timestamp + '] [' + entry.level.toUpperCase() + '] ' + context + entry.message + errorDetail;
}

export const logger = {
  error(message: string, context?: string, error?: Error | unknown): void {
    const entry: LogEntry = { level: 'error', message, context, error, timestamp: new Date() };
    console.error(formatMessage(entry));
  },
  
  warn(message: string, context?: string, error?: Error | unknown): void {
    const entry: LogEntry = { level: 'warn', message, context, error, timestamp: new Date() };
    console.warn(formatMessage(entry));
  },
  
  info(message: string, context?: string): void {
    const entry: LogEntry = { level: 'info', message, context, timestamp: new Date() };
    console.log(formatMessage(entry));
  },
  
  debug(message: string, context?: string): void {
    if (process.env.NODE_ENV === 'development') {
      const entry: LogEntry = { level: 'debug', message, context, timestamp: new Date() };
      console.log(formatMessage(entry));
    }
  },
  
  catchSilent(operation: string, context?: string): (error: unknown) => void {
    return (error: unknown) => {
      logger.warn(operation + ' failed (silently handled)', context, error);
    };
  },
  
  catchLog(operation: string, context?: string): (error: unknown) => void {
    return (error: unknown) => {
      logger.error(operation + ' failed', context, error);
    };
  }
};

export default logger;
