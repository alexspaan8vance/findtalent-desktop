'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Floating in-app feedback button. Bob clicks it, optionally "picks" an element
 * on the page (a link/button that's broken — its text/href/selector is captured),
 * writes what's wrong, and submits to /api/feedback. Dutch labels (Bob-facing);
 * i18n can be layered later. No external deps.
 */

type Category = 'bug' | 'idea' | 'other';

interface Picked {
  text: string;
  href: string | null;
  selector: string;
}

/** Best-effort, reasonably-stable CSS selector for an element. */
function cssSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 4 && node.tagName.toLowerCase() !== 'body') {
    let part = node.tagName.toLowerCase();
    const cls = (node.getAttribute('class') || '')
      .split(/\s+/)
      .filter((c) => c && !/^ft-/.test(c))
      .slice(0, 2)
      .join('.');
    if (cls) part += `.${cls}`;
    const parent = node.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
    depth += 1;
  }
  return parts.join(' > ');
}

export function FeedbackWidget({ appVersion }: { appVersion?: string }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [category, setCategory] = useState<Category>('bug');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const highlightRef = useRef<HTMLElement | null>(null);

  const clearHighlight = () => {
    if (highlightRef.current) {
      highlightRef.current.style.outline = '';
      highlightRef.current = null;
    }
  };

  // Element-pick mode: highlight on hover, capture on click.
  useEffect(() => {
    if (!picking) return;
    const onMove = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || el.closest('[data-ft-feedback]')) return;
      if (highlightRef.current && highlightRef.current !== el) {
        highlightRef.current.style.outline = '';
      }
      el.style.outline = '2px solid #6366f1';
      highlightRef.current = el;
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || el.closest('[data-ft-feedback]')) return;
      e.preventDefault();
      e.stopPropagation();
      const link = el.closest('a') as HTMLAnchorElement | null;
      setPicked({
        text: (el.innerText || el.textContent || '').trim().slice(0, 300),
        href: link?.href || (el as HTMLAnchorElement).href || null,
        selector: cssSelector(el),
      });
      clearHighlight();
      setPicking(false);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearHighlight();
        setPicking(false);
        setOpen(true);
      }
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      clearHighlight();
    };
  }, [picking]);

  const startPick = () => {
    setOpen(false);
    setPicking(true);
  };

  const submit = useCallback(async () => {
    if (!message.trim()) return;
    setStatus('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category,
          message,
          pageUrl: window.location.href,
          appVersion: appVersion ?? null,
          userAgent: navigator.userAgent,
          targetText: picked?.text ?? null,
          targetHref: picked?.href ?? null,
          targetSelector: picked?.selector ?? null,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setStatus('done');
      setMessage('');
      setPicked(null);
      setTimeout(() => {
        setStatus('idle');
        setOpen(false);
      }, 1800);
    } catch {
      setStatus('error');
    }
  }, [category, message, picked, appVersion]);

  return (
    <div data-ft-feedback>
      {picking && (
        <div
          className="fixed inset-x-0 top-0 z-[9999] bg-indigo-600 px-4 py-2 text-center text-sm font-medium text-white shadow"
          style={{ pointerEvents: 'none' }}
        >
          Klik het element/de link die niet werkt — of druk Esc om te annuleren
        </div>
      )}

      {!open && !picking && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-[9998] rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-indigo-700"
          aria-label="Feedback geven"
        >
          💬 Feedback
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-[9998] w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900">Feedback sturen</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1.5 text-zinc-500 hover:bg-zinc-100"
              aria-label="Sluiten"
            >
              ✕
            </button>
          </div>

          <div className="mb-2 flex gap-1.5">
            {(
              [
                ['bug', '🐞 Werkt niet'],
                ['idea', '💡 Idee'],
                ['other', '💬 Anders'],
              ] as [Category, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setCategory(key)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  category === key
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-zinc-300 text-zinc-600 hover:bg-zinc-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={startPick}
            className="mb-2 w-full rounded-md border border-dashed border-zinc-300 px-2 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50"
          >
            🎯 Selecteer een element / link op de pagina
          </button>

          {picked && (
            <div className="mb-2 rounded-md bg-zinc-50 px-2 py-1.5 text-xs text-zinc-600">
              <div className="font-medium text-zinc-800">Geselecteerd:</div>
              <div className="truncate">{picked.text || '(geen tekst)'}</div>
              {picked.href && <div className="truncate text-indigo-600">{picked.href}</div>}
              <button
                type="button"
                onClick={() => setPicked(null)}
                className="mt-0.5 text-[11px] text-zinc-400 hover:text-zinc-600"
              >
                verwijderen
              </button>
            </div>
          )}

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="Wat is er mis of wat wil je anders? Beschrijf het zo concreet mogelijk."
            className="mb-2 w-full resize-none rounded-md border border-zinc-300 px-2.5 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-500"
          />

          <button
            type="button"
            onClick={submit}
            disabled={status === 'sending' || !message.trim()}
            className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {status === 'sending' ? 'Versturen…' : 'Versturen'}
          </button>

          {status === 'done' && (
            <p className="mt-2 text-center text-xs text-green-600">Bedankt! Verstuurd. ✓</p>
          )}
          {status === 'error' && (
            <p className="mt-2 text-center text-xs text-red-600">
              Er ging iets mis — opgeslagen, we proberen 't later opnieuw.
            </p>
          )}
          <p className="mt-2 text-[11px] text-zinc-400">
            We sturen automatisch de pagina, versie en (indien gekozen) het element mee.
          </p>
        </div>
      )}
    </div>
  );
}
