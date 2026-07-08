'use client';

/**
 * Client wrappers for the team server-actions so we can surface inline
 * success/error feedback (the actions return a typed result object).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  inviteMemberAction,
  removeMemberAction,
  resendInviteAction,
  type TeamActionResult,
} from './actions';

type InviteLabels = {
  emailPlaceholder: string;
  invite: string;
  attached: string;
  pending: string;
  emailSent: string;
  emailFailed: string;
  copyLink: string;
  copied: string;
  errors: Record<string, string>;
};

/**
 * Read-only invite-link field + "copy" button. The link carries only the
 * invitee's email (no secret); it lets an owner share the signup link manually
 * when the deploy has no email configured. Client component (clipboard access).
 */
export function CopyLinkButton({
  link,
  copyLabel,
  copiedLabel,
}: {
  link: string;
  copyLabel: string;
  copiedLabel: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard API blocked (insecure context / permissions) — fall back to
      // selecting the input so the user can copy manually. Non-fatal.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        readOnly
        value={link}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs text-zinc-700"
      />
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        aria-label={copyLabel}
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}

export function InviteForm({ labels }: { labels: InviteLabels }): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Link returned by the last successful invite — shown so the owner can copy
  // + send it manually when email isn't configured.
  const [link, setLink] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    startTransition(async () => {
      const res: TeamActionResult = await inviteMemberAction(data);
      if (res.ok) {
        const base = res.kind === 'pending' ? labels.pending : labels.attached;
        // Append a non-fatal hint about the invite email outcome.
        const hint =
          res.emailSent === true
            ? ` ${labels.emailSent}`
            : res.emailSent === false
              ? ` ${labels.emailFailed}`
              : '';
        setMsg({ ok: true, text: `${base}${hint}` });
        setLink(res.link ?? null);
        form.reset();
        router.refresh();
      } else {
        setMsg({ ok: false, text: labels.errors[res.reason] ?? labels.errors.internal });
        setLink(null);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex-1">
        <input
          type="email"
          name="email"
          required
          placeholder={labels.emailPlaceholder}
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
        {link ? (
          <div className="mt-2">
            <CopyLinkButton
              link={link}
              copyLabel={labels.copyLink}
              copiedLabel={labels.copied}
            />
          </div>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
      >
        {labels.invite}
      </button>
    </form>
  );
}

export function RemoveButton({
  userId,
  label,
  errors,
}: {
  userId: string;
  label: string;
  errors: Record<string, string>;
}): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick(): void {
    setError(null);
    const data = new FormData();
    data.set('userId', userId);
    startTransition(async () => {
      const res: TeamActionResult = await removeMemberAction(data);
      if (res.ok) {
        router.refresh();
      } else {
        setError(errors[res.reason] ?? errors.internal);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      >
        {label}
      </button>
      {error ? (
        <p className="text-xs text-rose-700" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ResendButton({
  userId,
  label,
  sentLabel,
  failedLabel,
  errors,
}: {
  userId: string;
  label: string;
  sentLabel: string;
  failedLabel: string;
  errors: Record<string, string>;
}): React.ReactElement {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onClick(): void {
    setMsg(null);
    const data = new FormData();
    data.set('userId', userId);
    startTransition(async () => {
      const res: TeamActionResult = await resendInviteAction(data);
      if (res.ok) {
        setMsg({ ok: res.emailSent !== false, text: res.emailSent === false ? failedLabel : sentLabel });
      } else {
        setMsg({ ok: false, text: errors[res.reason] ?? errors.internal });
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      >
        {label}
      </button>
      {msg ? (
        <p
          className={`text-xs ${msg.ok ? 'text-emerald-700' : 'text-rose-700'}`}
          role="status"
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
