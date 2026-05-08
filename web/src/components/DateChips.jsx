import { QUICK_RANGES, fmtDDMMYYYY } from '../lib/format.js';

export function DateChips({ fromDate, toDate, onPick }) {
    return (
        <div className="chip-row" role="group" aria-label="Date quick picks">
            {QUICK_RANGES.map((q) => {
                const target = q.build();
                const pressed = fromDate === fmtDDMMYYYY(target.from) && toDate === fmtDDMMYYYY(target.to);
                return (
                    <button
                        key={q.id}
                        type="button"
                        className="chip"
                        aria-pressed={pressed ? 'true' : 'false'}
                        onClick={() => onPick({ from: fmtDDMMYYYY(target.from), to: fmtDDMMYYYY(target.to) })}
                    >
                        {q.label}
                    </button>
                );
            })}
        </div>
    );
}
