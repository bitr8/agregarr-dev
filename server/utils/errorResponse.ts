/**
 * Utility for creating safe API error responses
 * Prevents leaking internal implementation details in production
 */

import logger from '@server/logger';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Patterns that indicate SAFE, user-friendly error messages
 * Only messages matching these patterns will be shown to users in production
 */
const SAFE_MESSAGE_PATTERNS = [
  /^(not found|invalid|missing|required|failed to|unable to|cannot|unauthorized|forbidden)/i,
  /^(no .+ found|.+ is required|.+ not configured)/i,
  /^(connection|network|timeout)/i,
];

/**
 * Patterns that indicate internal/sensitive error details
 * Messages matching these will always be masked
 */
const SENSITIVE_PATTERNS = [
  /at\s+\S+\s+\([^)]+\)/i, // Stack trace lines
  /\/home\/|\/root\/|\/var\/|\/usr\/|\/mnt\/|C:\\|D:\\/i, // File paths
  /ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i, // System errors
  /password|secret|token|apikey|api_key|authorization/i, // Credentials
  /node_modules|\.ts:\d+|\.js:\d+/i, // Internal paths/source locations
  /sql|query|database|table|column|constraint/i, // Database internals
  /localhost|127\.0\.0\.1|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./i, // Internal IPs
];

/**
 * Check if an error message is safe to show to users
 */
function isSafeMessage(message: string): boolean {
  // First check if it contains anything sensitive
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }
  // Then check if it matches known safe patterns
  return SAFE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Sanitize an error message for client response
 * In production, only shows messages that are explicitly safe
 * This is a whitelist approach - safer than trying to blacklist sensitive data
 */
export function sanitizeErrorMessage(
  error: unknown,
  fallbackMessage = 'An unexpected error occurred'
): string {
  const message = error instanceof Error ? error.message : String(error);

  // In development, always show full error for debugging
  if (isDev) {
    return message;
  }

  // In production, use whitelist approach - only show known-safe messages
  if (isSafeMessage(message)) {
    return message;
  }

  // Default to fallback for unknown/potentially sensitive messages
  return fallbackMessage;
}

/**
 * Create a standardized error response object
 * Logs the full error internally while returning a safe response
 */
export function createErrorResponse(
  error: unknown,
  label: string,
  userMessage: string
): { error: string; message: string } {
  const fullMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  // Log full error details internally
  logger.error(`${userMessage}: ${fullMessage}`, {
    label,
    error: fullMessage,
    stack,
  });

  // Return sanitized response
  const safeMessage = sanitizeErrorMessage(error, userMessage);

  // Always include message field for API compatibility
  // Some clients may depend on this field being present
  return {
    error: userMessage,
    message: safeMessage,
  };
}
