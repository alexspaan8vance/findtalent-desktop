'use client';

/**
 * Per-template editor card. Edits subject + body, saves via the server action,
 * and can reset to the seeded default. Surfaces inline success/error feedback.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  saveTemplateAction,
  resetTemplateAction,
  type TemplateActionResult,
} from './actions';

export type TemplateEditorLabels = {
  subjectLabel: string;
  bodyLabel: string;
  placeholdersLabel: string;
  save: string;
  reset: string;
  saved: string;
  resetDone: string;
  errors: Record<string, string>;
};

export type TemplateRow = {
  key: string;
  name: string;
  subject: string;
  body: string;
  placeholders: readonly string[];
};

export function TemplateEditor({
  tpl,
  canEdit,
  labels,
}: {
  tpl: TemplateRow;
  canEdit: boolean;
  labels: TemplateEditorLabels;
}): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run(
    action: (fd: FormData) => Promise<TemplateActionResult>,
    fd: FormData,
    okText: string,
  ): void {
    startTransition(async () => {
      const res = await action(fd);
      if (res.ok) {
        setMsg({ ok: true, text: okText });
        router.refresh();
      } else {
        setMsg({ ok: false, text: labels.errors[res.reason] ?? labels.errors.internal });
      }
    });
  }

  function onSave(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    run(saveTemplateAction, fd, labels.saved);
  }

  function onReset(): void {
    const fd = new FormData();
    fd.set('key', tpl.key);
    run(resetTemplateAction, fd, labels.resetDone);
  }

  return (
    <section
      className="overflow-hidden rounded-2xl border"
      style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
    >
      <div
        className="px-5 py-3 text-sm font-medium"
        style={{ color: 'var(--ft-ink)', background: 'var(--ft-accent-soft)' }}
      >
        {tpl.name}
      </div>

      <form onSubmit={onSave} className="space-y-4 px-5 py-4">
        <input type="hidden" name="key" value={tpl.key} />

        <label className="block">
          <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--ft-ink)', opacity: 0.7 }}>
            {labels.subjectLabel}
          </span>
          <input
            type="text"
            name="subject"
            defaultValue={tpl.subject}
            required
            maxLength={300}
            disabled={!canEdit || pending}
            className="w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
            style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-bg)', color: 'var(--ft-ink)' }}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--ft-ink)', opacity: 0.7 }}>
            {labels.bodyLabel}
          </span>
          <textarea
            name="body"
            defaultValue={tpl.body}
            required
            rows={10}
            maxLength={20000}
            disabled={!canEdit || pending}
            className="w-full rounded-lg border px-3 py-2 text-sm leading-relaxed disabled:opacity-60"
            style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-bg)', color: 'var(--ft-ink)' }}
          />
        </label>

        {tpl.placeholders.length > 0 && (
          <p className="text-xs" style={{ color: 'var(--ft-ink)', opacity: 0.6 }}>
            {labels.placeholdersLabel}{' '}
            {tpl.placeholders.map((p) => (
              <code
                key={p}
                className="mr-1 rounded px-1 py-0.5"
                style={{ background: 'var(--ft-accent-soft)', color: 'var(--ft-ink)' }}
              >{`{{${p}}}`}</code>
            ))}
          </p>
        )}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60"
              style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
            >
              {labels.save}
            </button>
            <button
              type="button"
              onClick={onReset}
              disabled={pending}
              className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-60"
              style={{ borderColor: 'var(--ft-border)', color: 'var(--ft-ink)' }}
            >
              {labels.reset}
            </button>
            {msg && (
              <span
                className="text-xs"
                style={{ color: msg.ok ? 'var(--ft-accent)' : '#dc2626' }}
                role="status"
              >
                {msg.text}
              </span>
            )}
          </div>
        )}
      </form>
    </section>
  );
}
