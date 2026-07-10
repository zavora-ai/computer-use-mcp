---
name: computer-use-forms
description: Fill desktop form fields using accessibility tools (fill_form, set_value) instead of click+type loops.
---

# Form filling via accessibility

1. `list_windows` → pick `window_id`
2. `get_ui_tree(window_id)` or `find_element` for each field (role + label)
3. `fill_form` with `[{ role, label, value }, ...]` in one call
4. Prefer `set_value` for single fields; avoid coordinate `type` unless AX fails
5. Verify with another tree read or `zoom` on the field region

On label miss, use `similarLabels` from the error payload — do not retry the same wrong label.
