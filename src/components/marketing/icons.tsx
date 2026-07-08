import type { ReactElement, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps): IconProps {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...props,
  };
}

export function ProjectIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 5h16M4 12h10M4 19h7" />
      <circle cx="18" cy="17" r="3" />
      <path d="M18 14.5V17l1.5 1" />
    </svg>
  );
}

export function ShortlistIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  );
}

export function RevealIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function ExclusivityIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 9h17M8 3v4M16 3v4" />
      <path d="m9.5 15 1.8 1.8L15 13" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function SkillsIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 18V9M10 18V5M16 18v-6M22 18V8" />
    </svg>
  );
}

export function EuIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i / 12) * Math.PI * 2;
        const r = 6;
        return (
          <circle
            key={i}
            cx={12 + Math.sin(a) * r}
            cy={12 - Math.cos(a) * r}
            r={0.9}
            fill="currentColor"
            stroke="none"
          />
        );
      })}
    </svg>
  );
}

export function CheckIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}

export function ArrowIcon(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
