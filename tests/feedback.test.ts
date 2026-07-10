import { afterEach, describe, expect, it, vi } from 'vitest';

import { forwardFeedback, type FeedbackPayload } from '@/lib/feedback';

const payload: FeedbackPayload = {
  id: 'fb1',
  category: 'bug',
  message: 'link broken',
  createdAt: new Date(0).toISOString(),
};

describe('forwardFeedback', () => {
  afterEach(() => {
    delete process.env.FEEDBACK_WEBHOOK_URL;
    vi.restoreAllMocks();
  });

  it('no-ops when no webhook is configured', async () => {
    const res = await forwardFeedback(payload);
    expect(res.delivered).toBe(false);
    expect(res.error).toMatch(/no FEEDBACK_WEBHOOK_URL/);
  });

  it('POSTs to the webhook and reports delivered on 2xx', async () => {
    process.env.FEEDBACK_WEBHOOK_URL = 'https://hook.example/feedback';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const res = await forwardFeedback(payload);
    expect(res.delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hook.example/feedback');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      source: 'findtalent-desktop',
      id: 'fb1',
      message: 'link broken',
    });
  });

  it('reports the status on a non-2xx response', async () => {
    process.env.FEEDBACK_WEBHOOK_URL = 'https://hook.example/feedback';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    const res = await forwardFeedback(payload);
    expect(res.delivered).toBe(false);
    expect(res.error).toMatch(/500/);
  });
});
