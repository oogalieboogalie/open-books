import { CATEGORIES, CATEGORY_GROUPS } from "@/lib/categories";

export function CategoryOptions({ includeAuto = false }: { includeAuto?: boolean }) {
  return (
    <>
      {includeAuto && <option value="">Auto-categorize</option>}
      {CATEGORY_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {CATEGORIES.filter((c) => group.kinds.includes(c.kind) && !(includeAuto && c.id === "uncategorized")).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.taxLine ? ` (${c.taxLine})` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
