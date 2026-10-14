import { FileText } from 'lucide-react';

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="empty-state" role="status">
      <div className="empty-art" aria-hidden="true">
        <FileText size={36} strokeWidth={1} />
      </div>
      <h3>{label}</h3>
    </div>
  );
}
