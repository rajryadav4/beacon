// Accessible place combobox (class app's PlaceBox): saved places, recent trips and landmarks while you
// type, then Photon search results. Each box also has "My location" and "Pick on map" buttons.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isAbort } from '../../lib/format';
import { searchPlaces, type Place } from '../../lib/places';
import { Icon, KIND_ICON } from '../ui';

export interface Section { title: string | null; items: Place[] }
type Status = 'searching' | 'none' | 'error' | null;

interface Props {
  label: string;
  placeholder: string;
  markerClass: string;
  value: Place | null;
  pendingText?: string;
  local: (q: string) => Section[];
  onPick: (p: Place) => void;
  actions: ReactNode;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

const NOTE: Record<string, string> = {
  searching: 'Searching places in Seattle…',
  none: 'No places found in Seattle.',
  error: 'Place search is offline. Pick a saved place, a landmark, or tap the map.',
};

export default function PlaceBox({ label, placeholder, markerClass, value, pendingText, local, onPick, actions, inputRef }: Props) {
  const listId = useId();
  const ownRef = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownRef;
  const [text, setText] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [status, setStatus] = useState<Status>(null);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);

  // Show the chosen place's name (or "Finding your location…") whenever it changes.
  useEffect(() => { setText(value?.name ?? pendingText ?? ''); }, [value, pendingText]);

  const items = sections.flatMap((s) => s.items);
  const query = () => {
    const q = text.trim();
    return value && q === value.name ? '' : q;
  };

  // Local suggestions at once; remote search 280 ms after typing stops.
  useEffect(() => {
    if (!open) return;
    const q = query();
    const mine = ++seq.current;
    setSections(local(q));
    setActive(-1);
    if (q.length < 3) { setStatus(null); return; }
    setStatus('searching');
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      searchPlaces(q, ctrl.signal).then((found) => {
        if (mine !== seq.current) return;
        const base = local(q);
        const seen = new Set(base.flatMap((s) => s.items).map((i) => i.name.toLowerCase()));
        const fresh = found.filter((p) => !seen.has(p.name.toLowerCase())).slice(0, 6);
        if (fresh.length) base.push({ title: 'Places', items: fresh });
        setSections(base);
        setStatus(base.some((s) => s.items.length) ? null : 'none');
      }).catch((e) => {
        if (isAbort(e) || mine !== seq.current) return;
        setStatus('error');
      });
    }, 280);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
    // `local` changes identity every render; the text and open state drive the search.
  }, [text, open]);

  const pick = (p: Place) => {
    setOpen(false);
    onPick(p);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else if (items.length) setActive((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) setActive((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[active >= 0 ? active : 0]; if (it) pick(it); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
  };

  let idx = -1;
  const showList = open && (items.length > 0 || status !== null);
  return (
    <div className="place-field">
      <span className={`marker ${markerClass}`} aria-hidden="true" />
      <label className="sr-only" htmlFor={`${listId}-input`}>{label}</label>
      <input id={`${listId}-input`} ref={input} type="text" placeholder={placeholder} autoComplete="off" spellCheck={false}
        role="combobox" aria-autocomplete="list" aria-expanded={showList} aria-controls={`${listId}-list`}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={(e) => { e.target.select(); setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey} />
      {actions}
      {showList && (
        <ul className="suggest" id={`${listId}-list`} role="listbox" aria-label={`${label} suggestions`} onMouseDown={(e) => e.preventDefault()}>
          {sections.filter((s) => s.items.length).map((s) => [
            s.title ? <li key={`h-${s.title}`} className="s-head" role="presentation">{s.title}</li> : null,
            ...s.items.map((item) => {
              idx += 1;
              const i = idx;
              return (
                <li key={`${s.title}-${i}-${item.name}`} id={`${listId}-${i}`} role="option" aria-selected={i === active} onClick={() => pick(item)}>
                  <span className="s-icon"><Icon name={KIND_ICON[item.kind] ?? 'pin'} className="icon-sm" /></span>
                  <span><div className="s-name">{item.name}</div>{item.detail && <div className="s-detail">{item.detail}</div>}</span>
                </li>
              );
            }),
          ])}
          {status && <li className="s-empty" role="presentation">{NOTE[status]}</li>}
        </ul>
      )}
    </div>
  );
}
