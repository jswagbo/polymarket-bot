type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_COLORS = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m',  // Green
  warn: '\x1b[33m',  // Yellow
  error: '\x1b[31m', // Red
  reset: '\x1b[0m',
};

class Logger {
  private context: string;

  constructor(context: string = 'Bot') {
    this.context = context;
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const color = LOG_COLORS[level];
    const reset = LOG_COLORS.reset;
    const prefix = `${color}[${timestamp}] [${level.toUpperCase()}] [${this.context}]${reset}`;
    
    let output = `${prefix} ${message}`;
    if (data !== undefined) {
      output += ` ${JSON.stringify(data, null, 2)}`;
    }
    return output;
  }

  debug(message: string, data?: unknown) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: unknown) {
    console.log(this.formatMessage('info', message, data));
  }

  warn(message: string, data?: unknown) {
    console.warn(this.formatMessage('warn', message, data));
  }

  error(message: string, data?: unknown) {
    console.error(this.formatMessage('error', message, data));
  }

  child(context: string): Logger {
    return new Logger(`${this.context}:${context}`);
  }
}

export const logger = new Logger();
export const createLogger = (context: string) => new Logger(context);

