/** Renders search snippets where matches are wrapped in \u0002 ... \u0003 by the backend. */
export function Highlight({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\u0002') ? (
          <mark key={i} className="rounded bg-brand-100 px-0.5 text-ink">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
