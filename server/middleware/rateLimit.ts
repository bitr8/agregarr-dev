import rateLimit from 'express-rate-limit';

export const fileRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

// Unauthenticated route gets its own bucket so a flood of 404s cannot lock admins out.
export const publicFileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
