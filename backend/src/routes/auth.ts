import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { users, type User } from '../db/schema.js';
import { badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { clearSession, currentUser, issueSession, requireAuth } from '../middleware/auth.js';

export const authRouter = Router();
const google = new OAuth2Client();

// Slow down password guessing / token spraying.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false });

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl });

authRouter.get('/config', (_req, res) => {
  res.json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
});

/**
 * Google Sign-In. The browser obtains a token from Google and posts it here. We accept:
 *   - credential:  a signed ID token (JWT) from the One Tap / Sign-In button, or
 *   - accessToken: an OAuth access token from the popup flow (used by our custom button).
 * Either way we ask Google to confirm the token was issued for OUR client id,
 * then we issue our own session cookie. The browser's word is never trusted alone.
 */
const googleBody = z.union([
  z.object({ credential: z.string().min(20) }),
  z.object({ accessToken: z.string().min(20) }),
]);

interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

async function profileFromIdToken(idToken: string): Promise<GoogleProfile> {
  const ticket = await google.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email || !p.sub) throw new Error('token has no email');
  return { sub: p.sub, email: p.email, emailVerified: Boolean(p.email_verified), name: p.name, picture: p.picture };
}

async function profileFromAccessToken(accessToken: string): Promise<GoogleProfile> {
  const info = await google.getTokenInfo(accessToken);
  if (info.aud !== env.GOOGLE_CLIENT_ID) throw new Error('token was issued for a different app');
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo returned ${res.status}`);
  const u = (await res.json()) as { sub: string; email: string; email_verified: boolean; name?: string; picture?: string };
  if (u.sub !== info.sub) throw new Error('token subject mismatch');
  return { sub: u.sub, email: u.email, emailVerified: u.email_verified, name: u.name, picture: u.picture };
}

authRouter.post('/google', authLimiter, async (req, res) => {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(501, 'Google sign-in is not configured on the server');
  const body = googleBody.parse(req.body);

  const p = await ('credential' in body ? profileFromIdToken(body.credential) : profileFromAccessToken(body.accessToken)).catch(
    () => {
      throw unauthorized('Google sign-in could not be verified');
    },
  );
  if (!p.emailVerified) throw unauthorized('Google account email is not verified');

  const email = p.email.toLowerCase();
  const name = p.name ?? email;
  const [user] = await db
    .insert(users)
    .values({ email, name, avatarUrl: p.picture ?? null, googleSub: p.sub })
    .onConflictDoUpdate({ target: users.email, set: { name, avatarUrl: p.picture ?? null, googleSub: p.sub } })
    .returning();

  issueSession(res, { id: user!.id, email: user!.email });
  res.json({ user: publicUser(user!) });
});

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address, like name@example.com'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

authRouter.post('/register', authLimiter, async (req, res) => {
  const body = credentials.extend({ name: z.string().trim().min(1, 'Enter your name').max(120) }).parse(req.body);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
  if (existing) throw badRequest('An account with this email already exists');
  const [user] = await db
    .insert(users)
    .values({ email: body.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 12) })
    .returning();
  issueSession(res, { id: user!.id, email: user!.email });
  res.status(201).json({ user: publicUser(user!) });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = credentials.parse(req.body);
  const [user] = await db.select().from(users).where(eq(users.email, body.email));
  // Same message whether the email or the password is wrong: don't reveal which accounts exist.
  if (!user?.passwordHash || !(await bcrypt.compare(body.password, user.passwordHash))) {
    throw unauthorized('Incorrect email or password');
  }
  issueSession(res, { id: user.id, email: user.email });
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, currentUser(req).id));
  if (!user) throw unauthorized();
  res.json({ user: publicUser(user) });
});
