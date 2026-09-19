import { useState } from 'react';
import { X, Moon, Play, PushPin } from '@phosphor-icons/react';
import { formatBytes, formatIdle } from '../lib/resourceFormat';

export default function ResourcePanel({ state, panes, titles, error, busy, onAction, onPolicy, onClose, onFocus }) {
  const [policyError, setPolicyError] = useState(null);
  const policy = state?.policy ?? { idle_enabled: false, idle_minutes: 30, pressure_enabled: false };
  const rows = state?.panes ?? [];
  const update = async (patch) => {
    setPolicyError(null);
    try { await onPolicy({ ...policy, ...patch }); } catch (err) { setPolicyError(String(err)); }
  };
  return <aside className="resource-panel" aria-label="Agent resources">
    <header><strong>Agent resources</strong><button className="btn-icon" title="Close resources" onClick={onClose}><X size={16}/></button></header>
    <div className="resource-summary">
      <span>Memory pressure <strong>{state?.pressure ?? 'checking…'}</strong></span>
      <span>{formatBytes(state?.available_bytes)} available / {formatBytes(state?.total_bytes)} total</span>
      <span>{formatBytes(state?.swap_used_bytes)} swap in use</span>
    </div>
    <p className="resource-note">Per-agent memory is resident RAM across its process tree, including tools. Shared pages can be counted more than once; compressed and swapped pages are not included. CPU is a percentage of the whole machine.</p>
    {(error || policyError) && <p className="resource-error" role="alert">{error || policyError}</p>}
    <div className="resource-list">
      {rows.map((r) => {
        const pane = panes.find((p) => p.id === r.id);
        return <article key={r.id} className="resource-row">
          <button className="resource-name" onClick={() => onFocus(pane)} disabled={!pane}>{titles[r.id] || pane?.label || `Agent ${r.id}`}</button>
          <div className="resource-numbers">{r.hibernated ? 'Hibernated' : `${formatBytes(r.resident_bytes)} · ${(r.cpu_percent ?? 0).toFixed(1)}% CPU · ${r.processes} processes`}</div>
          <small>{r.hibernated ? (r.reason || 'Session saved; resume when you need it') : (r.reason || formatIdle(r.idle_seconds))}</small>
          <div className="resource-actions">
            <button className={`btn-sm${r.pinned ? ' active' : ''}`} aria-pressed={!!r.pinned} disabled={!!busy[r.id]}
              onClick={() => onAction('pin',r.id,!r.pinned)}><PushPin size={13}/> {r.pinned ? 'Pinned' : 'Pin'}</button>
            <button className="btn-sm" disabled={!!busy[r.id] || (r.hibernated ? r.can_resume === false : !r.eligible)}
              title={r.reason || undefined} onClick={() => onAction(r.hibernated ? 'resume' : 'hibernate',r.id)}>
              {r.hibernated ? <Play size={13}/> : <Moon size={13}/>} {busy[r.id] || (r.hibernated ? 'Resume' : 'Hibernate')}
            </button>
          </div>
        </article>;
      })}
      {!rows.length && <p className="resource-note">{state?.sampling ? 'Measuring processes…' : 'No agent processes to show.'}</p>}
    </div>
    <fieldset className="resource-policy"><legend>Automatic cleanup</legend>
      <label><input type="checkbox" checked={policy.idle_enabled} onChange={(e) => update({idle_enabled:e.target.checked})}/> Hibernate eligible idle agents</label>
      <label>After <select value={policy.idle_minutes} onChange={(e) => update({idle_minutes:Number(e.target.value)})}>
        {[5,15,30,60,120,240].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></label>
      <label><input type="checkbox" checked={policy.pressure_enabled} onChange={(e) => update({pressure_enabled:e.target.checked})}/> Hibernate eligible agents under memory pressure</label>
      <p className="resource-note">Pinned agents, active turns, approval prompts, and unconfirmed background work are protected. Cleanup handles one eligible agent at a time. Hibernation preserves the conversation, not unsaved process state.</p>
    </fieldset>
  </aside>;
}
