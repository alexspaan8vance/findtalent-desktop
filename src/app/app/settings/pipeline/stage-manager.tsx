'use client';

/**
 * Client UI for stage CRUD. Renders the ordered stage list with inline rename /
 * recolor / terminal-toggle, up/down reorder, and remove; plus an add-stage
 * form. Each mutation calls a server action (FormData) and refreshes the route.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  addStage,
  updateStage,
  moveStage,
  removeStage,
  type StageActionResult,
} from './actions';

export interface StageRow {
  id: string;
  name: string;
  color: string;
  isTerminal: boolean;
}

interface Labels {
  addTitle: string;
  namePlaceholder: string;
  terminal: string;
  terminalHint: string;
  add: string;
  save: string;
  moveUp: string;
  moveDown: string;
  remove: string;
  color: string;
  errInvalid: string;
  errLastStage: string;
  errInternal: string;
  saved: string;
}

function errText(res: StageActionResult, labels: Labels): string {
  if (res.ok) return '';
  switch (res.reason) {
    case 'invalid':
      return labels.errInvalid;
    case 'last_stage':
      return labels.errLastStage;
    default:
      return labels.errInternal;
  }
}

export function StageManager({
  stages,
  labels,
}: {
  stages: StageRow[];
  labels: Labels;
}): React.ReactElement {
  const router = useRouter();
  const [error, setError] = useState<string>('');

  function run(action: (fd: FormData) => Promise<StageActionResult>, fd: FormData): void {
    setError('');
    void action(fd).then((res) => {
      if (!res.ok) setError(errText(res, labels));
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" role="alert">
          {error}
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5">
        <ul className="space-y-3">
          {stages.map((s, i) => (
            <StageItem
              key={s.id}
              stage={s}
              isFirst={i === 0}
              isLast={i === stages.length - 1}
              labels={labels}
              run={run}
            />
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {labels.addTitle}
        </h2>
        <AddForm labels={labels} run={run} />
      </section>
    </div>
  );
}

function StageItem({
  stage,
  isFirst,
  isLast,
  labels,
  run,
}: {
  stage: StageRow;
  isFirst: boolean;
  isLast: boolean;
  labels: Labels;
  run: (action: (fd: FormData) => Promise<StageActionResult>, fd: FormData) => void;
}): React.ReactElement {
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);
  const [isTerminal, setIsTerminal] = useState(stage.isTerminal);
  const [pending, startTransition] = useTransition();
  const dirty =
    name !== stage.name || color !== stage.color || isTerminal !== stage.isTerminal;

  function save(): void {
    const fd = new FormData();
    fd.set('stageId', stage.id);
    fd.set('name', name);
    fd.set('color', color);
    if (isTerminal) fd.set('isTerminal', 'on');
    startTransition(() => run(updateStage, fd));
  }

  function move(direction: 'up' | 'down'): void {
    const fd = new FormData();
    fd.set('stageId', stage.id);
    fd.set('direction', direction);
    startTransition(() => run(moveStage, fd));
  }

  function doRemove(): void {
    const fd = new FormData();
    fd.set('stageId', stage.id);
    startTransition(() => run(removeStage, fd));
  }

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50/50 p-3">
      <input
        type="color"
        value={color}
        aria-label={labels.color}
        onChange={(e) => setColor(e.target.value)}
        className="h-8 w-8 shrink-0 cursor-pointer rounded border border-zinc-300 bg-white p-0.5"
      />
      <input
        type="text"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        className="min-w-32 flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
      />
      <label className="flex items-center gap-1.5 text-xs text-zinc-600">
        <input
          type="checkbox"
          checked={isTerminal}
          onChange={(e) => setIsTerminal(e.target.checked)}
          className="h-4 w-4 rounded border-zinc-300"
        />
        {labels.terminal}
      </label>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => move('up')}
          disabled={isFirst || pending}
          aria-label={labels.moveUp}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-white disabled:opacity-40"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => move('down')}
          disabled={isLast || pending}
          aria-label={labels.moveDown}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-white disabled:opacity-40"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || pending}
          className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {labels.save}
        </button>
        <button
          type="button"
          onClick={doRemove}
          disabled={pending}
          aria-label={labels.remove}
          className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-40"
        >
          {labels.remove}
        </button>
      </div>
    </li>
  );
}

function AddForm({
  labels,
  run,
}: {
  labels: Labels;
  run: (action: (fd: FormData) => Promise<StageActionResult>, fd: FormData) => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#1f6f5c');
  const [isTerminal, setIsTerminal] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const fd = new FormData();
    fd.set('name', name);
    fd.set('color', color);
    if (isTerminal) fd.set('isTerminal', 'on');
    startTransition(() => {
      run(addStage, fd);
      setName('');
      setColor('#1f6f5c');
      setIsTerminal(false);
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-wrap items-center gap-3">
      <input
        type="color"
        value={color}
        aria-label={labels.color}
        onChange={(e) => setColor(e.target.value)}
        className="h-9 w-9 shrink-0 cursor-pointer rounded border border-zinc-300 bg-white p-0.5"
      />
      <input
        type="text"
        value={name}
        required
        maxLength={60}
        placeholder={labels.namePlaceholder}
        onChange={(e) => setName(e.target.value)}
        className="min-w-40 flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
      />
      <label className="flex items-center gap-1.5 text-xs text-zinc-600" title={labels.terminalHint}>
        <input
          type="checkbox"
          checked={isTerminal}
          onChange={(e) => setIsTerminal(e.target.checked)}
          className="h-4 w-4 rounded border-zinc-300"
        />
        {labels.terminal}
      </label>
      <button
        type="submit"
        disabled={pending || name.trim().length === 0}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {labels.add}
      </button>
    </form>
  );
}
