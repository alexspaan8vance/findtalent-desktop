'use client';

/**
 * Drag-and-drop Kanban board (dnd-kit). One droppable column per configurable
 * stage; candidate cards are draggable between columns. Dropping a card calls
 * the `moveCandidate` server action and optimistically re-files the card.
 *
 * Layout: a responsive CSS grid that fits ALL stages in the viewport width
 * (no horizontal board scroll) — columns shrink to `minmax(0, 1fr)` and their
 * bodies scroll vertically. Columns can be collapsed to a thin labelled strip;
 * the collapse state is persisted in localStorage keyed by project + stage.
 *
 * Candidate data is anonymized (opaque id / score / top skills / location);
 * the revealed name is shown only when the user already holds an active reveal
 * lock (resolved server-side). A candidate whose name is NOT revealed may not
 * be moved past the shortlist boundary (the first two stages); post-reveal
 * columns are disabled as drop targets for such cards (reveal-gate, mirrored
 * by the authoritative server-side check in `moveCandidate`).
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { ExperienceYearsBucket } from '@/lib/anonymize/types';
import { ScoreRing } from '@/components/score-ring';
import { stageDisplayName } from '@/lib/pipeline-stage-label';

/**
 * Stage order index at/after which a candidate must be revealed before being
 * moved there. Mirrors `SHORTLIST_BOUNDARY_INDEX` in `@/lib/pipeline` (the
 * first two stages — inflow + shortlist — are pre-reveal). Kept as a local
 * literal so this client component carries no server-only imports.
 */
const SHORTLIST_BOUNDARY_INDEX = 2;

export interface BoardColumn {
  id: string;
  name: string;
  color: string;
  isTerminal: boolean;
}

export interface BoardCard {
  matchId: string;
  opaqueId: string;
  score: number;
  stageId: string;
  position: number;
  favorite: boolean;
  revealedName: string | null;
  /** True when the candidate self-applied (inbound application) — "Gesolliciteerd" badge. */
  applied?: boolean;
  tenantSlug: string;
  location: string | null;
  yearsBucket: ExperienceYearsBucket | null;
  topSkills: { name: string; mustHave: boolean }[];
}

type MoveResult =
  | { ok: true; matchId: string; stageId: string; position: number }
  | { ok: false; reason: string };

interface Props {
  projectId: string;
  columns: BoardColumn[];
  cards: BoardCard[];
  moveAction: (matchId: string, stageId: string, position: number) => Promise<MoveResult>;
  /** When true, a stage change asks the recruiter to confirm before committing. */
  confirmMoves?: boolean;
}

/** A move awaiting confirmation (org `confirmStageMoves` is on). */
interface PendingMove {
  matchId: string;
  targetStageId: string;
  position: number;
  cardName: string;
  fromStage: string;
  toStage: string;
}

export function PipelineBoard({
  projectId,
  columns,
  cards,
  moveAction,
  confirmMoves = false,
}: Props): React.ReactElement {
  const t = useTranslations('pipeline');
  const [, startTransition] = useTransition();
  const [activeId, setActiveId] = useState<string | null>(null);
  // Transient hint surfaced when a move is blocked by the reveal-gate.
  const [gateHint, setGateHint] = useState(false);
  // A drop awaiting confirmation (only when `confirmMoves`).
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  // Local stage overrides keyed by matchId so drops feel instant; the server
  // action also revalidates the route.
  const [stageOverride, setStageOverride] = useState<Record<string, string>>({});

  // Collapsed columns (per project + stage), persisted in localStorage.
  const { collapsed, toggleCollapsed } = useCollapsedColumns(projectId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const effectiveStage = (c: BoardCard): string => stageOverride[c.matchId] ?? c.stageId;

  const byColumn = useMemo<Record<string, BoardCard[]>>(() => {
    const map: Record<string, BoardCard[]> = {};
    for (const col of columns) map[col.id] = [];
    const fallback = columns[0]?.id;
    for (const c of cards) {
      const sid = effectiveStage(c);
      const target = map[sid] ? sid : fallback;
      if (target && map[target]) map[target].push(c);
    }
    // Stable order within a column: manual position, then score desc.
    for (const id of Object.keys(map)) {
      map[id].sort((a, b) => a.position - b.position || b.score - a.score);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, cards, stageOverride]);

  // The candidate currently being dragged (if any) and whether it is revealed.
  const activeCard = activeId ? cards.find((c) => c.matchId === activeId) ?? null : null;
  const activeRevealed = activeCard?.revealedName != null;

  /** A column index is "post-reveal" when it sits at/after the boundary. */
  const isPostRevealIndex = useCallback(
    (index: number): boolean => index >= SHORTLIST_BOUNDARY_INDEX,
    [],
  );

  function onDragStart(e: DragStartEvent): void {
    setActiveId(String(e.active.id));
    setGateHint(false);
  }

  /** Optimistically apply + persist a stage move (post reveal-gate + confirm). */
  const commitMove = useCallback(
    (matchId: string, targetStageId: string, position: number): void => {
      setStageOverride((prev) => ({ ...prev, [matchId]: targetStageId }));
      startTransition(async () => {
        const res = await moveAction(matchId, targetStageId, position);
        if (!res.ok) {
          if (res.reason === 'reveal_required') setGateHint(true);
          // Roll back on failure — but only if a NEWER move hasn't since set this
          // card to a different stage (request-aware): otherwise a fast double-move
          // would have the first rejection clobber the second move's override.
          setStageOverride((prev) => {
            if (prev[matchId] !== targetStageId) return prev;
            const next = { ...prev };
            delete next[matchId];
            return next;
          });
        }
      });
    },
    [moveAction, startTransition],
  );

  function onDragEnd(e: DragEndEvent): void {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const matchId = String(active.id);
    const targetStageId = String(over.id);
    const card = cards.find((c) => c.matchId === matchId);
    if (!card) return;
    const currentStageId = effectiveStage(card);
    if (currentStageId === targetStageId) return;
    const targetIndex = columns.findIndex((col) => col.id === targetStageId);
    if (targetIndex === -1) return;

    // Reveal-gate (client): block dropping a non-revealed candidate into a
    // post-reveal stage. The server enforces the same rule authoritatively.
    const revealed = card.revealedName != null;
    if (!revealed && isPostRevealIndex(targetIndex)) {
      setGateHint(true);
      return;
    }

    // Append to the end of the target column.
    const position = byColumn[targetStageId]?.length ?? 0;

    // Org guard: confirm the move before committing (guards against accidental
    // drops, especially once stage-change automations are attached).
    if (confirmMoves) {
      setPendingMove({
        matchId,
        targetStageId,
        position,
        cardName: card.revealedName ?? t('anonymousCandidate'),
        fromStage: stageDisplayName(
          columns.find((c) => c.id === currentStageId)?.name ?? '',
          t,
        ),
        toStage: stageDisplayName(columns[targetIndex]?.name ?? '', t),
      });
      return;
    }

    commitMove(matchId, targetStageId, position);
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {pendingMove && (
        <ConfirmMoveDialog
          move={pendingMove}
          onConfirm={() => {
            const m = pendingMove;
            setPendingMove(null);
            commitMove(m.matchId, m.targetStageId, m.position);
          }}
          onCancel={() => setPendingMove(null)}
          labels={{
            title: t('confirmMoveTitle'),
            body: t('confirmMoveBody', {
              name: pendingMove.cardName,
              from: pendingMove.fromStage,
              to: pendingMove.toStage,
            }),
            confirm: t('confirmMoveConfirm'),
            cancel: t('confirmMoveCancel'),
          }}
        />
      )}
      {gateHint && (
        <div
          role="status"
          className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-2 text-xs font-medium text-[var(--ft-accent-strong)]"
        >
          <span aria-hidden="true">🔒</span>
          {t('revealGateHint')}
        </div>
      )}
      <div
        className="ft-board mt-5 grid flex-1 gap-3 overflow-hidden pb-2"
        style={{
          // Collapsed columns shrink to a thin fixed strip; expanded columns
          // share the remaining width. (A flat repeat(N,1fr) kept collapsed
          // columns full-width + empty — the reported bug.)
          gridTemplateColumns: columns
            .map((c) => (collapsed[c.id] ? '2.75rem' : 'minmax(0, 1fr)'))
            .join(' '),
        }}
        role="list"
      >
        {columns.map((col, index) => {
          const colCards = byColumn[col.id] ?? [];
          const postReveal = isPostRevealIndex(index);
          // Drop is gated only while dragging a non-revealed card.
          const dropDisabled = activeId != null && !activeRevealed && postReveal;
          return (
            <Column
              key={col.id}
              column={col}
              cards={colCards}
              projectId={projectId}
              activeId={activeId}
              collapsed={collapsed[col.id] ?? false}
              onToggleCollapse={() => toggleCollapsed(col.id)}
              dropDisabled={dropDisabled}
              postReveal={postReveal}
              countLabel={t('cardCount', { count: colCards.length })}
              terminalLabel={t('terminal')}
            />
          );
        })}
      </div>
    </DndContext>
  );
}

/**
 * Modal confirming a candidate's stage change. Click-outside / Escape / Cancel
 * abort the move; Confirm commits it. The confirm button is auto-focused so the
 * common "drag → Enter" path is one keystroke.
 */
function ConfirmMoveDialog({
  move,
  onConfirm,
  onCancel,
  labels,
}: {
  move: PendingMove;
  onConfirm: () => void;
  onCancel: () => void;
  labels: { title: string; body: string; confirm: string; cancel: string };
}): React.ReactElement {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={labels.title}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-[var(--ft-ink)]">{labels.title}</h2>
        <p className="mt-2 text-sm text-[var(--ft-muted)]">{labels.body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-1.5 text-sm font-medium text-[var(--ft-ink)] transition hover:border-[var(--ft-border-strong)] hover:bg-[var(--ft-surface-2)]"
          >
            {labels.cancel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-[var(--ft-accent)] px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
          >
            {labels.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Collapsed-column state, persisted in localStorage keyed by project + stage. */
function useCollapsedColumns(projectId: string): {
  collapsed: Record<string, boolean>;
  toggleCollapsed: (stageId: string) => void;
} {
  const storageKey = `ft:pipeline:collapsed:${projectId}`;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          // Intentional external-store hydration: localStorage can only be read
          // post-mount (an initializer would mismatch the SSR-rendered HTML).
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setCollapsed(parsed as Record<string, boolean>);
        }
      }
    } catch {
      /* ignore unreadable/quota'd storage */
    }
  }, [storageKey]);

  const toggleCollapsed = useCallback(
    (stageId: string) => {
      setCollapsed((prev) => {
        const next = { ...prev, [stageId]: !prev[stageId] };
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* ignore quota'd storage */
        }
        return next;
      });
    },
    [storageKey],
  );

  return { collapsed, toggleCollapsed };
}

function Column({
  column,
  cards,
  projectId,
  activeId,
  collapsed,
  onToggleCollapse,
  dropDisabled,
  postReveal,
  countLabel,
  terminalLabel,
}: {
  column: BoardColumn;
  cards: BoardCard[];
  projectId: string;
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  dropDisabled: boolean;
  postReveal: boolean;
  countLabel: string;
  terminalLabel: string;
}): React.ReactElement {
  const t = useTranslations('pipeline');
  // Seeded default-stage names are canonical English in the DB — localize at
  // render; org-renamed stages render verbatim.
  const columnLabel = stageDisplayName(column.name, t);
  // A disabled column is not a droppable target (dnd-kit `disabled`).
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: dropDisabled });

  if (collapsed) {
    return (
      <section
        role="listitem"
        className="ft-col ft-col-collapsed flex w-full flex-col items-center overflow-hidden rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)]"
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded="false"
          aria-label={t('expandColumn', { name: columnLabel })}
          className="flex w-full flex-1 flex-col items-center gap-3 px-2 py-3 text-[var(--ft-muted)] transition hover:text-[var(--ft-ink)]"
        >
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: column.color }}
            />
            <span className="grid min-w-[1.5rem] place-items-center rounded-full bg-[var(--ft-surface)] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ring-1 ring-inset ring-[var(--ft-border)]">
              {countLabel}
            </span>
          </span>
          <span
            className="text-[0.8125rem] font-semibold tracking-tight text-[var(--ft-ink)]"
            style={{ writingMode: 'vertical-rl' }}
          >
            {columnLabel}
          </span>
        </button>
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      role="listitem"
      data-over={isOver ? 'true' : undefined}
      className={`ft-col flex w-full min-w-0 flex-col overflow-hidden rounded-2xl border bg-[var(--ft-surface-2)] transition-[border-color,box-shadow] ${
        isOver
          ? 'border-[var(--ft-accent)] ring-2 ring-[var(--ft-accent-line)] ring-offset-1 ring-offset-[var(--ft-surface)]'
          : 'border-[var(--ft-border)]'
      } ${dropDisabled ? 'ft-col-locked opacity-70' : ''}`}
    >
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--ft-border)] bg-[var(--ft-surface-2)]/95 px-3.5 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-[var(--ft-surface-2)]"
            style={{ backgroundColor: column.color, boxShadow: `0 0 0 1px ${column.color}33` }}
          />
          <h2 className="truncate text-[0.8125rem] font-semibold tracking-tight text-[var(--ft-ink)]">
            {columnLabel}
          </h2>
          {column.isTerminal && (
            <span className="shrink-0 rounded-full border border-[var(--ft-border)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
              {terminalLabel}
            </span>
          )}
          {dropDisabled && (
            <span
              aria-hidden="true"
              title={t('revealGateHint')}
              className="shrink-0 text-[var(--ft-muted)]"
            >
              🔒
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="grid min-w-[1.5rem] place-items-center rounded-full bg-[var(--ft-surface)] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-[var(--ft-muted)] ring-1 ring-inset ring-[var(--ft-border)]">
            {countLabel}
          </span>
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded="true"
            aria-label={t('collapseColumn', { name: columnLabel })}
            className="grid h-6 w-6 place-items-center rounded-md text-[var(--ft-muted)] transition hover:bg-[var(--ft-surface)] hover:text-[var(--ft-ink)]"
          >
            <span aria-hidden="true" className="text-sm leading-none">
              ⤢
            </span>
          </button>
        </div>
      </header>

      <div className="ft-col-body flex flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
        {cards.length === 0 ? (
          <div className="ft-col-empty m-1 flex flex-1 items-center justify-center rounded-xl border border-dashed border-[var(--ft-border-strong)] p-6 text-center text-xs text-[var(--ft-muted)]">
            {dropDisabled && postReveal ? t('revealGateColumn') : t('emptyColumn')}
          </div>
        ) : (
          cards.map((c) => (
            <Card
              key={c.matchId}
              card={c}
              projectId={projectId}
              dragging={activeId === c.matchId}
            />
          ))
        )}
      </div>
    </section>
  );
}

function Card({
  card,
  projectId,
  dragging,
}: {
  card: BoardCard;
  projectId: string;
  dragging: boolean;
}): React.ReactElement {
  const t = useTranslations('pipeline');
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: card.matchId,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  const maxChips = 3;
  const visibleSkills = card.topSkills.slice(0, maxChips);
  const overflow = card.topSkills.length - visibleSkills.length;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`ft-card group relative rounded-xl border bg-[var(--ft-surface)] p-3 transition-[border-color,box-shadow,transform] ${
        dragging
          ? 'ft-card-dragging border-[var(--ft-accent)] opacity-70 shadow-lg'
          : card.revealedName
            ? 'border-[var(--ft-accent-line)] ring-1 ring-inset ring-[var(--ft-accent-line)]'
            : 'border-[var(--ft-border)]'
      }`}
    >
      {card.favorite && (
        <span
          aria-label={t('favorite')}
          className="absolute right-2.5 top-2.5 text-sm leading-none text-[var(--ft-accent-strong)]"
        >
          ★
        </span>
      )}

      <div className="flex items-start justify-between gap-2.5">
        <button
          type="button"
          {...listeners}
          {...attributes}
          aria-label={t('dragHandle')}
          className="ft-card-grab min-w-0 flex-1 cursor-grab pr-4 text-left active:cursor-grabbing"
        >
          {card.revealedName ? (
            <span className="block truncate text-sm font-semibold leading-snug text-[var(--ft-ink)]">
              {card.revealedName}
            </span>
          ) : (
            <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
              {t('anonymousCandidate')}
            </span>
          )}
          <span className="mt-1 flex items-center gap-1 truncate text-xs text-[var(--ft-muted)]">
            <span aria-hidden="true" className="text-[var(--ft-border-strong)]">◍</span>
            <span className="truncate">{card.location ?? t('locationUnknown')}</span>
          </span>
          {card.applied && (
            <span
              data-testid="applied-badge"
              className="mt-1.5 inline-flex items-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white"
            >
              {t('appliedBadge')}
            </span>
          )}
        </button>
        <ScoreRing score={card.score} size="sm" />
      </div>

      {visibleSkills.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap items-center gap-1">
          {visibleSkills.map((s) => (
            <li
              key={s.name}
              className={`max-w-full truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                s.mustHave
                  ? 'border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                  : 'border border-[var(--ft-border)] text-[var(--ft-muted)]'
              }`}
            >
              {s.name}
            </li>
          ))}
          {overflow > 0 && (
            <li
              title={`+${overflow}`}
              className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ft-muted)]"
            >
              +{overflow}
            </li>
          )}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-[var(--ft-border)] pt-2">
        <span className="font-mono text-[10px] tracking-tight text-[var(--ft-border-strong)]">
          {card.opaqueId.slice(0, 8)}
        </span>
        <Link
          href={`/app/projects/${projectId}/talent/${card.opaqueId}`}
          className="text-[11px] font-semibold text-[var(--ft-accent-strong)] underline-offset-2 transition hover:underline"
        >
          {t('viewDetail')}
        </Link>
      </div>
    </article>
  );
}
