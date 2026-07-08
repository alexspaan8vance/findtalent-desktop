'use client';

/**
 * Client wrappers for the staffing-rule server-actions so we can surface inline
 * success/error feedback (the actions return a typed result object).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  addRuleAction,
  toggleRuleAction,
  deleteRuleAction,
  type RuleActionResult,
} from './actions';

type AddLabels = {
  kindName: string;
  kindDescription: string;
  patternPlaceholder: string;
  labelPlaceholder: string;
  add: string;
  added: string;
  errors: Record<string, string>;
};

export function AddRuleForm({ labels }: { labels: AddLabels }): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const kind = String(data.get('kind') ?? '');
    const pattern = String(data.get('pattern') ?? '');
    const label = String(data.get('label') ?? '');
    startTransition(async () => {
      const res: RuleActionResult = await addRuleAction({ kind, pattern, label });
      if (res.ok) {
        setMsg({ ok: true, text: labels.added });
        form.reset();
        router.refresh();
      } else {
        setMsg({ ok: false, text: labels.errors[res.reason] ?? labels.errors.internal });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <select
        name="kind"
        defaultValue="NAME"
        disabled={pending}
        className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
      >
        <option value="NAME">{labels.kindName}</option>
        <option value="DESCRIPTION">{labels.kindDescription}</option>
      </select>
      <div className="flex-1">
        <input
          type="text"
          name="pattern"
          required
          placeholder={labels.patternPlaceholder}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          disabled={pending}
        />
        {msg ? (
          <p
            className={`mt-2 text-xs ${msg.ok ? 'text-emerald-700' : 'text-rose-700'}`}
            role="status"
          >
            {msg.text}
          </p>
        ) : null}
      </div>
      <input
        type="text"
        name="label"
        placeholder={labels.labelPlaceholder}
        className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        disabled={pending}
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
      >
        {labels.add}
      </button>
    </form>
  );
}

type RowLabels = {
  enable: string;
  disable: string;
  delete: string;
  confirmDelete: string;
  errors: Record<string, string>;
};

export function RuleRow({
  id,
  kind,
  pattern,
  label,
  enabled,
  labels,
}: {
  id: string;
  kind: string;
  pattern: string;
  label: string | null;
  enabled: boolean;
  labels: RowLabels;
}): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onToggle(): void {
    setError(null);
    startTransition(async () => {
      const res: RuleActionResult = await toggleRuleAction(id, !enabled);
      if (res.ok) {
        router.refresh();
      } else {
        setError(labels.errors[res.reason] ?? labels.errors.internal);
      }
    });
  }

  function onDelete(): void {
    setError(null);
    if (!window.confirm(labels.confirmDelete)) return;
    startTransition(async () => {
      const res: RuleActionResult = await deleteRuleAction(id);
      if (res.ok) {
        router.refresh();
      } else {
        setError(labels.errors[res.reason] ?? labels.errors.internal);
      }
    });
  }

  return (
    <tr className="align-top">
      <td className="px-4 py-3 text-zinc-700">{kind}</td>
      <td className="px-4 py-3 font-mono text-zinc-900">{pattern}</td>
      <td className="px-4 py-3 text-zinc-500">{label ?? '—'}</td>
      <td className="px-4 py-3">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-zinc-100 text-zinc-500'
          }`}
        >
          {enabled ? labels.enable : labels.disable}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              disabled={pending}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
            >
              {enabled ? labels.disable : labels.enable}
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={pending}
              className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
            >
              {labels.delete}
            </button>
          </div>
          {error ? (
            <p className="text-xs text-rose-700" role="status">
              {error}
            </p>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
