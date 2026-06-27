import { CheckCircle2, XCircle, Clock } from "lucide-react";

interface TimerRingProps {
  seconds: number;
  total: number;
}

const CIRC = 2 * Math.PI * 30;

export function TimerRing({ seconds, total }: TimerRingProps) {
  const pct = seconds / total;
  const offset = CIRC * (1 - pct);
  // Refined AWS colors
  const color = seconds > 10 ? "#16213e" : seconds > 5 ? "#FF9900" : "#ef4444";
  
  return (
    <div className="timer-ring group">
      <svg viewBox="0 0 72 72">
        <circle className="track opacity-20" cx="36" cy="36" r="30" />
        <circle 
          className="fill" 
          cx="36" 
          cy="36" 
          r="30" 
          strokeDasharray={CIRC} 
          strokeDashoffset={offset} 
          stroke={color} 
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s ease' }}
        />
      </svg>
      <div className="timer-num drop-shadow-sm" style={{ color }}>{seconds}</div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = { 
    pending: "Waiting", 
    admitted: "Admitted", 
    active: "In Progress", 
    completed: "Completed", 
    terminated: "Disqualified" 
  };
  return <span className={`badge-status ${status}`}>{labels[status] || status}</span>;
}

export function ConnDot({ error }: { error: boolean }) {
  return (
    <div className={`conn-dot ${error ? "err" : ""}`}>
      <span className="dot" />
      {error ? "Reconnecting…" : "Live"}
    </div>
  );
}
