export function YearPicker({ years, year, extra }: { years: number[]; year: number; extra?: Record<string, string> }) {
  const options = [...new Set([year, ...years, new Date().getFullYear()])].sort((a, b) => b - a);
  return (
    <form className="filters" method="get">
      {extra && Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label className="muted">
        Tax year{" "}
        <select name="year" defaultValue={year}>
          {options.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="secondary">Show</button>
    </form>
  );
}
