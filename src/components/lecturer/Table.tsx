// Lecturer application shell v1 — shared table primitives. Deliberately
// thin styled wrappers (not a generic data-driven table) so each page's
// existing table markup/columns can be retrofitted without rewriting
// its data logic — every lecturer table's row shape is different enough
// that a single generic <DataTable rows={} columns={}/> would just push
// the same custom-cell code elsewhere. Compact row height, readable
// headers, subtle hover, consistent status/action alignment.
export function TableWrap({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded-xl border border-lecturer-border bg-lecturer-surface">{children}</div>;
}

export function Table({ children }: { children: React.ReactNode }) {
  return <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>;
}

export function Thead({ children }: { children: React.ReactNode }) {
  return <thead className="border-b border-lecturer-border bg-lecturer-border-subtle/60">{children}</thead>;
}

export function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`px-4 py-2.5 text-left text-xs font-medium tracking-wide text-lecturer-text-secondary uppercase ${className}`}>
      {children}
    </th>
  );
}

export function Tbody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-lecturer-border">{children}</tbody>;
}

export function Tr({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <tr className={`hover:bg-lecturer-border-subtle/50 ${className}`}>{children}</tr>;
}

export function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle text-lecturer-text-primary ${className}`}>{children}</td>;
}
