import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { forwardFeedback } from '@/lib/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CATEGORIES = new Set(['bug', 'idea', 'other']);
const MAX_MSG = 5000;
const MAX_TEXT = 2000;
const MAX_SHOT = 3_000_000; // ~3MB data-URL cap; larger screenshots are dropped

function clip(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

export async function POST(req: Request) {
  const user = await requireUser();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const message = clip(body.message, MAX_MSG);
  if (!message) {
    return NextResponse.json({ error: 'message required' }, { status: 400 });
  }
  const category = CATEGORIES.has(String(body.category)) ? String(body.category) : 'bug';
  const shot = typeof body.screenshot === 'string' && body.screenshot.length <= MAX_SHOT
    ? body.screenshot
    : null;

  const row = await prisma.feedback.create({
    data: {
      userId: user.id,
      userEmail: user.email ?? null,
      category,
      message,
      pageUrl: clip(body.pageUrl, 1000),
      appVersion: clip(body.appVersion, 50),
      userAgent: clip(body.userAgent, 500),
      targetText: clip(body.targetText, MAX_TEXT),
      targetHref: clip(body.targetHref, 1000),
      targetSelector: clip(body.targetSelector, 500),
      screenshot: shot,
    },
  });

  // Best-effort forward to us; record the outcome, never fail the request.
  const { delivered, error } = await forwardFeedback({
    id: row.id,
    category: row.category,
    message: row.message,
    pageUrl: row.pageUrl,
    appVersion: row.appVersion,
    userAgent: row.userAgent,
    userEmail: row.userEmail,
    targetText: row.targetText,
    targetHref: row.targetHref,
    targetSelector: row.targetSelector,
    screenshot: row.screenshot,
    createdAt: row.createdAt.toISOString(),
  });
  if (delivered || error) {
    await prisma.feedback.update({
      where: { id: row.id },
      data: { delivered, deliveryError: delivered ? null : (error ?? null) },
    });
  }

  return NextResponse.json({ ok: true, id: row.id, delivered });
}
