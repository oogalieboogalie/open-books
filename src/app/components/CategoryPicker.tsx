"use client";

import { useRef } from "react";
import { isGenericMerchant } from "@/lib/categorize/normalize";
import { setCategoryAction } from "../actions";

/** Changes a transaction's category as soon as a new one is picked. */
export function CategoryPicker({ id, categoryId, merchant, children }: { id: number; categoryId: string; merchant: string; children: React.ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={setCategoryAction} className="category-picker">
      <input type="hidden" name="id" value={id} />
      <select name="categoryId" defaultValue={categoryId} aria-label="Category" onChange={() => form.current?.requestSubmit()}>
        {children}
      </select>
      {merchant && (
        <label className="remember" title={`Also categorize other "${merchant}" transactions this way`}>
          <input type="checkbox" name="remember" defaultChecked={!isGenericMerchant(merchant)} /> Always for {merchant}
        </label>
      )}
    </form>
  );
}
