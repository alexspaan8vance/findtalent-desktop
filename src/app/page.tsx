import Link from 'next/link';

import { getTranslations } from 'next-intl/server';

import { getBrandConfig } from '@/lib/brand/config';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { FadeInStyles } from '@/components/marketing/fade-in-styles';
import { HeroVisual } from '@/components/marketing/hero-visual';
import {
  ArrowIcon,
  CheckIcon,
  EuIcon,
  ExclusivityIcon,
  ProjectIcon,
  RevealIcon,
  ShieldIcon,
  ShortlistIcon,
  SkillsIcon,
} from '@/components/marketing/icons';

import { PLAN_TIERS, EXTRA_CREDIT_PRICE_EUR } from '@/lib/stripe/plans';

interface StepDef {
  readonly icon: (props: { className?: string }) => React.ReactElement;
  readonly titleKey: 'step1Title' | 'step2Title' | 'step3Title' | 'step4Title';
  readonly bodyKey: 'step1Body' | 'step2Body' | 'step3Body' | 'step4Body';
}

const STEPS: readonly StepDef[] = [
  { icon: ProjectIcon, titleKey: 'step1Title', bodyKey: 'step1Body' },
  { icon: ShortlistIcon, titleKey: 'step2Title', bodyKey: 'step2Body' },
  { icon: RevealIcon, titleKey: 'step3Title', bodyKey: 'step3Body' },
  { icon: ExclusivityIcon, titleKey: 'step4Title', bodyKey: 'step4Body' },
];

interface TrustDef {
  readonly icon: (props: { className?: string }) => React.ReactElement;
  readonly titleKey: 'trust1Title' | 'trust2Title' | 'trust3Title';
  readonly bodyKey: 'trust1Body' | 'trust2Body' | 'trust3Body';
}

const TRUST: readonly TrustDef[] = [
  { icon: SkillsIcon, titleKey: 'trust1Title', bodyKey: 'trust1Body' },
  { icon: ShieldIcon, titleKey: 'trust2Title', bodyKey: 'trust2Body' },
  { icon: EuIcon, titleKey: 'trust3Title', bodyKey: 'trust3Body' },
];

type TierKey = (typeof PLAN_TIERS)[number]['key'];

const TIER_BLURB_KEY: Record<TierKey, 'tierTryBlurb' | 'tierBasicBlurb' | 'tierProBlurb'> = {
  try: 'tierTryBlurb',
  basic: 'tierBasicBlurb',
  pro: 'tierProBlurb',
};

export default async function Home(): Promise<React.ReactElement> {
  const brand = getBrandConfig();
  const t = await getTranslations('landing');

  return (
    <div className="min-h-screen bg-[var(--ft-bg)] text-[var(--ft-ink)]">
      <FadeInStyles />

      {/* ---------------------------------------------------------------- Nav */}
      <header className="sticky top-0 z-30 border-b border-[var(--ft-border)] bg-[color-mix(in_srgb,var(--ft-bg)_88%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            {brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brand.logoUrl}
                alt={brand.name}
                className="h-7 w-auto"
              />
            ) : (
              <span
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[13px] font-bold"
                style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
              >
                {brand.name.charAt(0)}
              </span>
            )}
            <span className="text-base font-semibold tracking-tight">{brand.name}</span>
          </div>

          <nav className="flex items-center gap-2 sm:gap-3">
            <Link
              href="#how"
              className="hidden rounded-lg px-2.5 py-1.5 text-sm text-[var(--ft-muted)] transition-colors hover:text-[var(--ft-ink)] sm:inline-block"
            >
              {t('navHow')}
            </Link>
            <Link
              href="#pricing"
              className="hidden rounded-lg px-2.5 py-1.5 text-sm text-[var(--ft-muted)] transition-colors hover:text-[var(--ft-ink)] sm:inline-block"
            >
              {t('navPricing')}
            </Link>
            <Link
              href="/login"
              className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ft-ink)] transition-colors hover:text-[var(--ft-accent-strong)]"
            >
              {t('navLogin')}
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-[var(--ft-accent)] px-3.5 py-1.5 text-sm font-medium text-[var(--ft-accent-fg)] shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ft-accent-strong)] focus-visible:ring-offset-2"
            >
              {t('navSignup')}
            </Link>
            <span className="ml-1 hidden sm:inline-block">
              <LocaleSwitcher />
            </span>
          </nav>
        </div>
      </header>

      {/* -------------------------------------------------------------- Hero */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(80% 50% at 50% -10%, var(--ft-accent-soft), transparent 70%)',
          }}
        />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
          <div>
            <span className="ft-fade ft-fade-1 inline-flex items-center gap-2 rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-surface)] px-3 py-1 text-xs font-medium text-[var(--ft-accent-strong)]">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--ft-accent)]" />
              {t('heroEyebrow')}
            </span>

            <h1 className="ft-fade ft-fade-2 mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.4rem]">
              {t('heroTitle')}
            </h1>

            <p className="ft-fade ft-fade-3 mt-5 max-w-xl text-balance text-lg leading-relaxed text-[var(--ft-muted)]">
              {t('heroBody')}
            </p>

            <div className="ft-fade ft-fade-4 mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--ft-accent)] px-6 py-3 text-sm font-semibold text-[var(--ft-accent-fg)] shadow-sm transition-opacity hover:opacity-90"
              >
                {t('ctaStart')}
                <ArrowIcon aria-hidden="true" className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-xl border border-[var(--ft-border-strong)] bg-[var(--ft-surface)] px-6 py-3 text-sm font-semibold text-[var(--ft-ink)] transition-colors hover:border-[var(--ft-accent-line)]"
              >
                {t('ctaLogin')}
              </Link>
            </div>

            <p className="ft-fade ft-fade-5 mt-5 text-sm text-[var(--ft-muted)]">
              {t('heroReassurance')}
            </p>
          </div>

          <div className="flex justify-center lg:justify-end">
            <HeroVisual
              revealedLabel={t('visualRevealed')}
              matchLabel={t('visualMatch')}
              lockedLabel={t('visualLocked')}
            />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ How it works */}
      <section id="how" className="border-t border-[var(--ft-border)] bg-[var(--ft-surface)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {t('howTitle')}
            </h2>
            <p className="mt-3 text-lg text-[var(--ft-muted)]">{t('howBody')}</p>
          </div>

          <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <li
                  key={step.titleKey}
                  className="relative rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-6"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="flex h-11 w-11 items-center justify-center rounded-xl"
                      style={{ background: 'var(--ft-accent-soft)', color: 'var(--ft-accent-strong)' }}
                    >
                      <Icon aria-hidden="true" className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-[var(--ft-border-strong)]">
                      0{i + 1}
                    </span>
                  </div>
                  <h3 className="mt-4 text-base font-semibold">{t(step.titleKey)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--ft-muted)]">
                    {t(step.bodyKey)}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* ---------------------------------------------------- Trust / privacy */}
      <section className="border-t border-[var(--ft-border)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6">
          <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-surface)] px-3 py-1 text-xs font-medium text-[var(--ft-accent-strong)]">
                {t('trustEyebrow')}
              </span>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
                {t('trustTitle')}
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-[var(--ft-muted)]">
                {t('trustBody')}
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-1">
              {TRUST.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.titleKey}
                    className="flex gap-4 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-5"
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: 'var(--ft-accent-soft)', color: 'var(--ft-accent-strong)' }}
                    >
                      <Icon aria-hidden="true" className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-base font-semibold">{t(item.titleKey)}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-[var(--ft-muted)]">
                        {t(item.bodyKey)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- Pricing */}
      <section id="pricing" className="border-t border-[var(--ft-border)] bg-[var(--ft-surface)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {t('pricingTitle')}
            </h2>
            <p className="mt-3 text-lg text-[var(--ft-muted)]">{t('pricingBody')}</p>
          </div>

          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {PLAN_TIERS.map((tier) => {
              const highlighted = tier.key === 'basic';
              return (
                <div
                  key={tier.key}
                  className="relative flex flex-col rounded-2xl border bg-[var(--ft-surface-2)] p-7"
                  style={{
                    borderColor: highlighted ? 'var(--ft-accent)' : 'var(--ft-border)',
                    boxShadow: highlighted
                      ? '0 24px 60px -34px rgba(31,111,92,0.55)'
                      : undefined,
                  }}
                >
                  {highlighted && (
                    <span
                      className="absolute -top-3 left-7 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
                    >
                      {t('pricingPopular')}
                    </span>
                  )}

                  <div className="text-sm font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
                    {tier.name}
                  </div>

                  <div className="mt-3 flex items-baseline gap-1">
                    <span className="text-4xl font-semibold tracking-tight">€{tier.priceEur}</span>
                    <span className="text-sm text-[var(--ft-muted)]">{t('perPeriod')}</span>
                  </div>

                  <div className="mt-2 text-sm font-medium text-[var(--ft-accent-strong)]">
                    {tier.creditsPerPeriod === 1
                      ? t('revealsIncludedOne', { count: tier.creditsPerPeriod })
                      : t('revealsIncludedOther', { count: tier.creditsPerPeriod })}
                  </div>

                  <p className="mt-4 text-sm leading-relaxed text-[var(--ft-muted)]">
                    {t(TIER_BLURB_KEY[tier.key])}
                  </p>

                  <ul className="mt-5 space-y-2.5 text-sm">
                    <li className="flex items-start gap-2">
                      <CheckIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ft-accent)]" />
                      <span>{t('featureMatching')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ft-accent)]" />
                      <span>{t('featureExclusivity')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ft-accent)]" />
                      <span>{t('featureExtra', { price: EXTRA_CREDIT_PRICE_EUR })}</span>
                    </li>
                  </ul>

                  <Link
                    href="/signup"
                    className="mt-7 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90"
                    style={
                      highlighted
                        ? { background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }
                        : {
                            background: 'var(--ft-surface)',
                            color: 'var(--ft-ink)',
                            border: '1px solid var(--ft-border-strong)',
                          }
                    }
                  >
                    {t('getStarted')}
                  </Link>
                </div>
              );
            })}
          </div>

          <p className="mt-8 text-center text-sm text-[var(--ft-muted)]">
            {t('extraReveals', { price: EXTRA_CREDIT_PRICE_EUR })}
          </p>
        </div>
      </section>

      {/* -------------------------------------------------------- Final CTA */}
      <section className="border-t border-[var(--ft-border)]">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6">
          <div
            className="relative overflow-hidden rounded-3xl border border-[var(--ft-accent-line)] px-8 py-14 text-center sm:px-12"
            style={{ background: 'var(--ft-accent-soft)' }}
          >
            <h2 className="mx-auto max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              {t('finalTitle')}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-[var(--ft-muted)]">
              {t('finalBody')}
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--ft-accent)] px-6 py-3 text-sm font-semibold text-[var(--ft-accent-fg)] shadow-sm transition-opacity hover:opacity-90"
              >
                {t('ctaStart')}
                <ArrowIcon aria-hidden="true" className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-xl border border-[var(--ft-border-strong)] bg-[var(--ft-surface)] px-6 py-3 text-sm font-semibold text-[var(--ft-ink)] transition-colors hover:border-[var(--ft-accent-line)]"
              >
                {t('ctaLogin')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- Footer */}
      <footer className="border-t border-[var(--ft-border)] bg-[var(--ft-surface)]">
        <div className="mx-auto max-w-6xl px-5 py-10 sm:px-6">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-sm">
              <div className="flex items-center gap-2.5">
                {brand.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={brand.logoUrl} alt={brand.name} className="h-6 w-auto" />
                ) : (
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[11px] font-bold"
                    style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
                  >
                    {brand.name.charAt(0)}
                  </span>
                )}
                <span className="text-sm font-semibold">{brand.name}</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-[var(--ft-muted)]">
                {t('footerTagline')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-x-12 gap-y-3 text-sm sm:gap-x-16">
              <div className="flex flex-col gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
                  {t('footerProduct')}
                </span>
                <Link href="#how" className="text-[var(--ft-ink)] hover:text-[var(--ft-accent-strong)]">
                  {t('navHow')}
                </Link>
                <Link href="#pricing" className="text-[var(--ft-ink)] hover:text-[var(--ft-accent-strong)]">
                  {t('navPricing')}
                </Link>
                <Link href="/signup" className="text-[var(--ft-ink)] hover:text-[var(--ft-accent-strong)]">
                  {t('navSignup')}
                </Link>
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
                  {t('footerCompany')}
                </span>
                <a
                  href={`mailto:${brand.supportEmail}`}
                  className="text-[var(--ft-ink)] hover:text-[var(--ft-accent-strong)]"
                >
                  {t('footerSupport')}
                </a>
                <Link href="/privacy" className="text-[var(--ft-ink)] hover:text-[var(--ft-accent-strong)]">
                  {t('footerPrivacy')}
                </Link>
                <Link href="/terms" className="text-[var(--ft-ink)] hover:text-[var(--ft-accent-strong)]">
                  {t('footerTerms')}
                </Link>
              </div>
            </div>
          </div>

          <div className="mt-10 flex flex-col items-start justify-between gap-4 border-t border-[var(--ft-border)] pt-6 text-xs text-[var(--ft-muted)] sm:flex-row sm:items-center">
            <div>
              © {new Date().getFullYear()} {brand.name}. {t('footerRights')}
            </div>
            <LocaleSwitcher />
          </div>
        </div>
      </footer>
    </div>
  );
}
