import type { ReactElement } from 'react';

/**
 * One restrained page-load animation: a staggered fade-and-rise.
 * Injected as a scoped <style> so it lives entirely inside the marketing
 * components' file ownership (globals.css is owned elsewhere).
 *
 * Usage: add `ft-fade` to an element, plus `ft-fade-1`…`ft-fade-6` to stagger.
 * Respects prefers-reduced-motion.
 */
export function FadeInStyles(): ReactElement {
  return (
    <style>{`
      @keyframes ft-fade-rise {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .ft-fade {
        opacity: 0;
        animation: ft-fade-rise 0.7s cubic-bezier(0.22, 1, 0.36, 1) forwards;
      }
      .ft-fade-1 { animation-delay: 0.05s; }
      .ft-fade-2 { animation-delay: 0.13s; }
      .ft-fade-3 { animation-delay: 0.21s; }
      .ft-fade-4 { animation-delay: 0.29s; }
      .ft-fade-5 { animation-delay: 0.37s; }
      .ft-fade-6 { animation-delay: 0.45s; }
      @media (prefers-reduced-motion: reduce) {
        .ft-fade {
          opacity: 1;
          animation: none;
        }
      }
    `}</style>
  );
}
