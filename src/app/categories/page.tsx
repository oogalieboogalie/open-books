import { CATEGORIES, CATEGORY_GROUPS } from "@/lib/categories";

export default function CategoriesPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Categories</h1>
          <p className="muted">Every category maps to a line on IRS Schedule C or another form, so your totals are ready for tax time.</p>
        </div>
      </div>
      {CATEGORY_GROUPS.filter((g) => !g.kinds.includes("uncategorized")).map((group) => (
        <section className="card cat-group" key={group.label}>
          <h2>{group.label}</h2>
          <div className="cat-list">
            {CATEGORIES.filter((c) => group.kinds.includes(c.kind)).map((c) => (
              <div key={c.id}>
                <strong>
                  {c.name} {c.taxLine && <span className="tag">{c.taxLine}</span>}
                </strong>
                <span className="muted">{c.description}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
