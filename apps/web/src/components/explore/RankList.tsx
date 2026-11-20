// "Areas, most to least dangerous": the neighborhoods ranked by danger index (class app's renderRanking).

import { useState } from 'react';
import { fmt } from '../../lib/format';
import type { RankRow } from '../../lib/risk';
import { LevelBadge } from '../ui';

interface Props {
  ranking: RankRow[];
  caption: string;
  selected: number | null;
  onFocus: (row: RankRow) => void;
}

export default function RankList({ ranking, caption, selected, onFocus }: Props) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? ranking : ranking.slice(0, 10);
  return (
    <div className="section">
      <div className="section-title"><span>Areas, most to least dangerous</span><small>{caption}</small></div>
      <ol className="rank-list">
        {rows.map((r, idx) => (
          <li key={r.hood.key}>
            <button className={`rank-item${idx < 3 ? ' top' : ''}${selected === r.i ? ' is-selected' : ''}`} type="button"
              aria-label={`${idx + 1}. ${r.hood.name}, danger index ${r.index}. Show on map.`} aria-current={selected === r.i}
              onClick={() => onFocus(r)}>
              <span className="rank-num">{idx + 1}</span>
              <span>
                <div className="rank-name">{r.hood.name}</div>
                <div className="rank-meta">{fmt.perYear(r.perYear)} a year · mostly {r.top ? r.top.label.toLowerCase() : 'mixed'}</div>
                <div className="rank-bar" aria-hidden="true"><i style={{ width: `${Math.max(3, r.index)}%` }} /></div>
              </span>
              <LevelBadge level={r.level} text={r.level === 'high' ? 'High' : r.level === 'elevated' ? 'Elevated' : 'Lower'} />
            </button>
          </li>
        ))}
      </ol>
      {ranking.length > 10 && (
        <button className="btn btn-ghost btn-sm rank-more" type="button" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show top 10' : `Show all ${ranking.length} areas`}
        </button>
      )}
      <p className="hint">Danger index = severity-weighted incidents per year per km², for the selected time and crime types.</p>
    </div>
  );
}
