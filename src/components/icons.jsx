// SF-Symbols-style line icons drawn for Flobi Pulse (20×20 grid, 1.6 stroke).
const P = {
  overview: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1.8" />
      <rect x="11" y="3" width="6" height="6" rx="1.8" />
      <rect x="3" y="11" width="6" height="6" rx="1.8" />
      <rect x="11" y="11" width="6" height="6" rx="1.8" />
    </>
  ),
  traffic: (
    <>
      <path d="M3 7h12.5M12.5 4l3 3-3 3" />
      <path d="M17 13H4.5M7.5 10l-3 3 3 3" />
    </>
  ),
  errors: (
    <>
      <path d="M8.6 3.6 2.9 13.9A1.6 1.6 0 0 0 4.3 16.3h11.4a1.6 1.6 0 0 0 1.4-2.4L11.4 3.6a1.6 1.6 0 0 0-2.8 0Z" />
      <path d="M10 8v3.4" />
      <circle cx="10" cy="13.6" r=".45" fill="currentColor" />
    </>
  ),
  crashes: (
    <>
      <path d="M11 2.8 5 11h4.4l-1 6.2L15 9h-4.4l.4-6.2Z" />
    </>
  ),
  logs: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="3" />
      <path d="M6.5 7.5 8.5 9.5l-2 2M10.5 12.5h3" />
    </>
  ),
  events: (
    <>
      <path d="M4 5.5h1M4 10h1M4 14.5h1M8 5.5h8M8 10h8M8 14.5h8" />
    </>
  ),
  infrastructure: (
    <>
      <rect x="3" y="3.5" width="14" height="5" rx="1.6" />
      <rect x="3" y="11.5" width="14" height="5" rx="1.6" />
      <path d="M6 6h.01M6 14h.01M9 6h5M9 14h5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.4" />
      <path d="M4 5v10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5" />
      <path d="M4 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4" />
    </>
  ),
  frontends: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2 2.2 2.8 4.5 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3Z" />
    </>
  ),
  timeline: (
    <>
      <path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6" />
      <path d="M3.3 3.6v3.3h3.3M10 6.5V10l2.4 1.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.6v1.8M10 15.6v1.8M17.4 10h-1.8M4.4 10H2.6M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3M15.2 15.2l-1.3-1.3M6.1 6.1 4.8 4.8" />
    </>
  ),
  search: (
    <>
      <circle cx="8.8" cy="8.8" r="5.3" />
      <path d="m12.8 12.8 4 4" />
    </>
  ),
  bell: (
    <>
      <path d="M5.2 13.8V9a4.8 4.8 0 0 1 9.6 0v4.8l1.4 1.6H3.8l1.4-1.6Z" />
      <path d="M8.3 17.2a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  chevronRight: <path d="m8 4.5 5.5 5.5L8 15.5" />,
  chevronDown: <path d="m4.5 8 5.5 5.5L15.5 8" />,
  chevronLeft: <path d="M12 4.5 6.5 10l5.5 5.5" />,
  x: <path d="m5 5 10 10M15 5 5 15" />,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  pause: <path d="M7 4.5v11M13 4.5v11" />,
  play: <path d="M6.5 4.3v11.4a.6.6 0 0 0 .9.5l9-5.7a.6.6 0 0 0 0-1l-9-5.7a.6.6 0 0 0-.9.5Z" />,
  follow: (
    <>
      <path d="M10 3.5v11M5.5 10 10 14.5l4.5-4.5M4.5 17h11" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2.2" />
      <path d="M13 7V5.2A2.2 2.2 0 0 0 10.8 3H5.2A2.2 2.2 0 0 0 3 5.2v5.6A2.2 2.2 0 0 0 5.2 13H7" />
    </>
  ),
  external: (
    <>
      <path d="M11.5 3.5h5v5M16.5 3.5 9.5 10.5" />
      <path d="M14.5 11.5v3a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </>
  ),
  download: (
    <>
      <path d="M10 3.5v9M6 9l4 4 4-4" />
      <path d="M4 16.5h12" />
    </>
  ),
  refresh: (
    <>
      <path d="M16.2 10a6.2 6.2 0 1 1-1.8-4.4" />
      <path d="M16.5 3.3v3.4h-3.4" />
    </>
  ),
  shield: (
    <>
      <path d="M10 2.8 4 5v4.6c0 3.7 2.6 6.4 6 7.6 3.4-1.2 6-3.9 6-7.6V5l-6-2.2Z" />
      <path d="m7.4 10 1.8 1.8 3.5-3.6" />
    </>
  ),
  key: (
    <>
      <circle cx="7" cy="13" r="3.3" />
      <path d="m9.4 10.6 6.8-6.8M13.6 6.4l2 2M15.4 4.6l1.4 1.4" />
    </>
  ),
  person: (
    <>
      <circle cx="10" cy="7.3" r="3.2" />
      <path d="M4 16.6c.9-2.8 3.3-4.3 6-4.3s5.1 1.5 6 4.3" />
    </>
  ),
  pod: (
    <>
      <path d="m10 2.8 6.3 3.6v7.2L10 17.2l-6.3-3.6V6.4L10 2.8Z" />
      <path d="M3.9 6.5 10 10l6.1-3.5M10 10v7" />
    </>
  ),
  cpu: (
    <>
      <rect x="5" y="5" width="10" height="10" rx="2" />
      <rect x="8" y="8" width="4" height="4" rx=".8" />
      <path d="M8 2.8V5M12 2.8V5M8 15v2.2M12 15v2.2M2.8 8H5M2.8 12H5M15 8h2.2M15 12h2.2" />
    </>
  ),
  memory: (
    <>
      <rect x="2.8" y="6" width="14.4" height="7.5" rx="1.6" />
      <path d="M6 13.5V15M10 13.5V15M14 13.5V15M6 9h.01M9 9h.01M12 9h.01" />
    </>
  ),
  scale: (
    <>
      <path d="M10 2.8v14.4M6.5 6.3 10 2.8l3.5 3.5M6.5 13.7l3.5 3.5 3.5-3.5" />
    </>
  ),
  seal: (
    <>
      <path d="m10 2.6 1.9 1.4 2.3-.1.7 2.2 1.9 1.3-.8 2.2.8 2.2-1.9 1.3-.7 2.2-2.3-.1L10 17.4l-1.9-1.4-2.3.1-.7-2.2-1.9-1.3.8-2.2-.8-2.2 1.9-1.3.7-2.2 2.3.1L10 2.6Z" />
      <path d="m7.4 10 1.8 1.8 3.4-3.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.6 1.7" />
    </>
  ),
  cloud: <path d="M6 15.5h8.2a3.3 3.3 0 0 0 .5-6.6 4.8 4.8 0 0 0-9.2-.8A3.8 3.8 0 0 0 6 15.5Z" />,
  bolt: <path d="M11 2.8 5 11h4.4l-1 6.2L15 9h-4.4l.4-6.2Z" />,
  flame: <path d="M10 17.2c3 0 5.2-2 5.2-5 0-2.4-1.4-4-2.7-5.5-.4 1.4-1.2 2.3-2.2 2.6.2-2.6-.6-4.9-2.8-6.5.2 2.2-.8 3.8-2 5.2-1.1 1.3-1.9 2.6-1.9 4.2 0 3 2.3 5 5.4 5Z" />,
  sun: (
    <>
      <circle cx="10" cy="10" r="3.3" />
      <path d="M10 2.6v1.5M10 15.9v1.5M17.4 10h-1.5M4.1 10H2.6M15.2 4.8l-1 1M5.8 14.2l-1 1M15.2 15.2l-1-1M5.8 5.8l-1-1" />
    </>
  ),
  moon: <path d="M15.6 12.4A6.4 6.4 0 0 1 7.6 4.4a6.4 6.4 0 1 0 8 8Z" />,
  info: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5" />
      <circle cx="10" cy="6.5" r=".45" fill="currentColor" />
    </>
  ),
  dot: <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none" />,
  sidebar: (
    <>
      <rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2.4" />
      <path d="M7.5 3.8v12.4" />
    </>
  ),
  link: (
    <>
      <path d="M8.5 11.5 11.5 8.5" />
      <path d="M9 5.8 10.3 4.5a3.2 3.2 0 0 1 4.5 4.5L13.5 10.3M11 14.2 9.7 15.5a3.2 3.2 0 0 1-4.5-4.5l1.3-1.3" />
    </>
  ),
  arrowUpRight: <path d="M6 14 14 6M7.5 6H14v6.5" />,
  sparkles: (
    <>
      <path d="M8.5 3.5 9.6 7a2 2 0 0 0 1.4 1.4l3.5 1.1-3.5 1.1A2 2 0 0 0 9.6 12l-1.1 3.5L7.4 12A2 2 0 0 0 6 10.6L2.5 9.5 6 8.4A2 2 0 0 0 7.4 7l1.1-3.5Z" />
      <path d="M15 3v3M13.5 4.5h3" />
    </>
  ),
  mute: (
    <>
      <path d="M5.2 13.8V9a4.8 4.8 0 0 1 7.7-3.8M14.8 9v4.8l1.4 1.6H6.5" />
      <path d="M3.5 3.5 16.5 16.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.6 10S5.3 4.8 10 4.8 17.4 10 17.4 10 14.7 15.2 10 15.2 2.6 10 2.6 10Z" />
      <circle cx="10" cy="10" r="2.4" />
    </>
  ),
  filter: <path d="M3.5 5h13M6 10h8M8.5 15h3" />,
  globe: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2 2.2 2.8 4.5 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3Z" />
    </>
  ),
  rocket: (
    <>
      <path d="M11.5 13.8 8 10.4c1.7-4.3 4.5-6.9 8.6-7.2-.3 4.1-2.8 6.9-7.1 8.6" />
      <path d="M8 10.4 5.2 10l2.2-2.6h3M11.5 13.8l.4 2.8 2.6-2.2v-3M5.7 14.3c-.9.9-1.2 2.5-1.2 2.5s1.6-.3 2.5-1.2" />
    </>
  ),
  stack: (
    <>
      <path d="m10 3 7 3.6-7 3.6-7-3.6L10 3Z" />
      <path d="m3 10 7 3.6 7-3.6M3 13.4 10 17l7-3.6" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2.4" />
      <path d="m6 8 2.2 2L6 12M10.5 12.5h3.5" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6" />
      <path d="M3.3 3.6v3.3h3.3M10 6.5V10l2.4 1.6" />
    </>
  ),
};

export default function Icon({ name, size = 16, className = '', strokeWidth = 1.6, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true">
      {P[name] || P.dot}
    </svg>
  );
}
