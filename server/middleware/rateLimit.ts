import rateLimit from 'express-rate-limit';

export const fileRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
