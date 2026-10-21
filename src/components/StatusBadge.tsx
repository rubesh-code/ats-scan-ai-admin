/**
 * Status always pairs colour with an icon and a word, never colour alone.
 * The tones map to the reserved status palette in styles.css.
 */
export type Tone = 'good' | 'warning' | 'critical' | 'neutral';

const ICON: Record<Tone, string> = {
  good: '✓',
  warning: '!',
  critical: '✕',
  neutral: '•',
};

export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="badge" data-tone={tone}>
      <span className="badge-icon" aria-hidden="true">
        {ICON[tone]}
      </span>
      {label}
    </span>
  );
}

const TONES: Record<string, Tone> = {
  active: 'good',
  completed: 'good',
  paid: 'good',
  ok: 'good',
  suspended: 'critical',
  failed: 'critical',
  down: 'critical',
  refunded: 'warning',
  degraded: 'warning',
  created: 'neutral',
};

const LABELS: Record<string, string> = {
  created: 'Pending',
  ok: 'Healthy',
};

export function StateBadge({ state }: { state: string }) {
  const label = LABELS[state] ?? state.charAt(0).toUpperCase() + state.slice(1);
  return <StatusBadge tone={TONES[state] ?? 'neutral'} label={label} />;
}
