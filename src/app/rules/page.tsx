import { getCategory } from "@/lib/categories";
import { getBooks } from "@/lib/server";
import { deleteRuleAction, recategorizeAction } from "../actions";
import { CategoryOptions } from "../components/CategoryOptions";
import { RuleForm } from "../components/Forms";

export const dynamic = "force-dynamic";

const MATCH = { contains: "contains", starts_with: "starts with", exact: "is exactly" } as const;
const DIRECTION = { any: "", in: " (money in)", out: " (money out)" } as const;

export default async function RulesPage() {
  const rules = await (await getBooks()).listRules();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rules</h1>
          <p className="muted">
            Rules run before the built-in categorizer. They are created when you change a category with &quot;Always for…&quot; checked, or you can add one here.
          </p>
        </div>
        <form action={recategorizeAction}>
          <button type="submit" className="secondary">Re-run categorization</button>
        </form>
      </div>
      <div className="card table-wrap">
        {rules.length === 0 ? (
          <p className="muted">No rules yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When description</th>
                <th>Category</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    {MATCH[r.matchType]} <strong>{r.pattern}</strong>
                    <span className="muted">{DIRECTION[r.direction]}</span>
                  </td>
                  <td>{getCategory(r.categoryId).name}</td>
                  <td className="num">
                    <form action={deleteRuleAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit" className="danger">Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <RuleForm>
        <CategoryOptions />
      </RuleForm>
    </>
  );
}
