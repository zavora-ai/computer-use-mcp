// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
#[path = "accessibility_macos.rs"]
mod platform;

// ── Windows implementation — IUIAutomation COM ───────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use napi_derive::napi;
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Accessibility::*;

    fn uia() -> napi::Result<IUIAutomation> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| napi::Error::from_reason(format!("IUIAutomation init: {e}")))
        }
    }

    fn control_type_to_role(ct: UIA_CONTROLTYPE_ID) -> &'static str {
        match ct {
            UIA_ButtonControlTypeId => "AXButton",
            UIA_EditControlTypeId => "AXTextField",
            UIA_TextControlTypeId => "AXStaticText",
            UIA_CheckBoxControlTypeId => "AXCheckBox",
            UIA_ComboBoxControlTypeId => "AXComboBox",
            UIA_ListControlTypeId => "AXList",
            UIA_ListItemControlTypeId => "AXCell",
            UIA_MenuControlTypeId => "AXMenu",
            UIA_MenuItemControlTypeId => "AXMenuItem",
            UIA_MenuBarControlTypeId => "AXMenuBar",
            UIA_TabControlTypeId => "AXTabGroup",
            UIA_TabItemControlTypeId => "AXRadioButton",
            UIA_TreeControlTypeId => "AXOutline",
            UIA_TreeItemControlTypeId => "AXRow",
            UIA_WindowControlTypeId => "AXWindow",
            UIA_GroupControlTypeId => "AXGroup",
            UIA_SliderControlTypeId => "AXSlider",
            UIA_ProgressBarControlTypeId => "AXProgressIndicator",
            UIA_ScrollBarControlTypeId => "AXScrollBar",
            UIA_ToolBarControlTypeId => "AXToolbar",
            UIA_HyperlinkControlTypeId => "AXLink",
            UIA_ImageControlTypeId => "AXImage",
            UIA_RadioButtonControlTypeId => "AXRadioButton",
            UIA_DocumentControlTypeId => "AXWebArea",
            UIA_PaneControlTypeId => "AXGroup",
            _ => "AXUnknown",
        }
    }

    fn role_to_control_type(role: &str) -> UIA_CONTROLTYPE_ID {
        match role {
            "AXButton" => UIA_ButtonControlTypeId,
            "AXTextField" | "AXTextArea" => UIA_EditControlTypeId,
            "AXStaticText" => UIA_TextControlTypeId,
            "AXCheckBox" => UIA_CheckBoxControlTypeId,
            "AXComboBox" => UIA_ComboBoxControlTypeId,
            "AXList" => UIA_ListControlTypeId,
            "AXCell" => UIA_ListItemControlTypeId,
            "AXMenu" => UIA_MenuControlTypeId,
            "AXMenuItem" => UIA_MenuItemControlTypeId,
            "AXMenuBar" => UIA_MenuBarControlTypeId,
            "AXTabGroup" => UIA_TabControlTypeId,
            "AXOutline" => UIA_TreeControlTypeId,
            "AXRow" => UIA_TreeItemControlTypeId,
            "AXWindow" => UIA_WindowControlTypeId,
            "AXGroup" => UIA_GroupControlTypeId,
            "AXSlider" => UIA_SliderControlTypeId,
            "AXProgressIndicator" => UIA_ProgressBarControlTypeId,
            "AXScrollBar" => UIA_ScrollBarControlTypeId,
            "AXToolbar" => UIA_ToolBarControlTypeId,
            "AXLink" => UIA_HyperlinkControlTypeId,
            "AXImage" => UIA_ImageControlTypeId,
            "AXRadioButton" => UIA_RadioButtonControlTypeId,
            _ => UIA_CONTROLTYPE_ID(0),
        }
    }

    fn element_to_json(elem: &IUIAutomationElement) -> serde_json::Value {
        unsafe {
            let role = elem.CurrentControlType()
                .map(|ct| control_type_to_role(ct)).unwrap_or("AXUnknown");
            let label = elem.CurrentName().ok().map(|s| s.to_string());
            let value = elem.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok().and_then(|p| p.CurrentValue().ok().map(|s| s.to_string()));
            let rect = elem.CurrentBoundingRectangle().unwrap_or_default();
            let mut actions = Vec::new();
            if elem.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).is_ok() {
                actions.push("AXPress");
            }
            if elem.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).is_ok() {
                actions.push("AXSetValue");
            }
            if elem.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).is_ok()
                && !actions.contains(&"AXPress") {
                actions.push("AXPress");
            }
            serde_json::json!({
                "role": role, "label": label, "value": value,
                "bounds": { "x": rect.left, "y": rect.top,
                    "width": rect.right - rect.left, "height": rect.bottom - rect.top },
                "actions": actions,
            })
        }
    }

    const NODE_LIMIT: usize = 500;

    fn walk_tree(elem: &IUIAutomationElement, walker: &IUIAutomationTreeWalker,
        depth: i32, max_depth: i32, count: &mut usize) -> serde_json::Value {
        if *count >= NODE_LIMIT { return serde_json::json!({"truncated": true}); }
        *count += 1;
        let mut node = element_to_json(elem);
        let mut children = Vec::new();
        if depth < max_depth {
            unsafe {
                if let Ok(child) = walker.GetFirstChildElement(elem) {
                    let mut cur = child;
                    while *count < NODE_LIMIT {
                        children.push(walk_tree(&cur, walker, depth + 1, max_depth, count));
                        match walker.GetNextSiblingElement(&cur) {
                            Ok(next) => cur = next,
                            Err(_) => break,
                        }
                    }
                }
            }
        }
        node["children"] = serde_json::json!(children);
        if *count >= NODE_LIMIT { node["truncated"] = serde_json::json!(true); }
        node
    }

    fn build_condition(automation: &IUIAutomation, role: Option<&str>, label: Option<&str>)
        -> napi::Result<IUIAutomationCondition> {
        unsafe {
            let mut conds: Vec<IUIAutomationCondition> = Vec::new();
            if let Some(r) = role {
                let ct = role_to_control_type(r);
                if ct.0 != 0 {
                    let v = windows::core::VARIANT::from(ct.0 as i32);
                    let c = automation.CreatePropertyCondition(
                        UIA_ControlTypePropertyId, &v)
                        .map_err(|e| napi::Error::from_reason(format!("condition: {e}")))?;
                    conds.push(c);
                }
            }
            if let Some(name) = label {
                let bstr = windows::core::BSTR::from(name);
                let v = windows::core::VARIANT::from(bstr);
                if let Ok(c) = automation.CreatePropertyCondition(UIA_NamePropertyId, &v) {
                    conds.push(c);
                }
            }
            if conds.is_empty() {
                return automation.CreateTrueCondition()
                    .map_err(|e| napi::Error::from_reason(format!("true_cond: {e}")));
            }
            if conds.len() == 1 { return Ok(conds.into_iter().next().unwrap()); }
            let mut combined = conds[0].clone();
            for c in &conds[1..] {
                combined = automation.CreateAndCondition(&combined, c)
                    .map_err(|e| napi::Error::from_reason(format!("and_cond: {e}")))?;
            }
            Ok(combined)
        }
    }

    fn find_first(automation: &IUIAutomation, hwnd: HWND, role: &str, label: &str)
        -> napi::Result<Option<IUIAutomationElement>> {
        unsafe {
            let root = automation.ElementFromHandle(hwnd)
                .map_err(|e| napi::Error::from_reason(format!("ElementFromHandle: {e}")))?;
            let cond = build_condition(automation, Some(role),
                if label.is_empty() { None } else { Some(label) })?;
            let elems = root.FindAll(TreeScope_Descendants, &cond)
                .map_err(|e| napi::Error::from_reason(format!("FindAll: {e}")))?;
            let count = elems.Length().unwrap_or(0);
            for i in 0..count {
                if let Ok(elem) = elems.GetElement(i) {
                    let name = elem.CurrentName().ok().map(|s| s.to_string());
                    let n = name.as_deref().unwrap_or("");
                    if label.is_empty() || n.to_lowercase() == label.to_lowercase()
                        || n.to_lowercase().contains(&label.to_lowercase()) {
                        return Ok(Some(elem));
                    }
                }
            }
            Ok(None)
        }
    }

    #[napi]
    pub fn get_ui_tree(window_id: u32, max_depth: Option<i32>) -> napi::Result<serde_json::Value> {
        let md = max_depth.unwrap_or(10).clamp(1, 20);
        let a = uia()?;
        unsafe {
            let root = a.ElementFromHandle(HWND(window_id as *mut _))
                .map_err(|e| napi::Error::from_reason(format!("ElementFromHandle: {e}")))?;
            let w = a.ControlViewWalker()
                .map_err(|e| napi::Error::from_reason(format!("ControlViewWalker: {e}")))?;
            let mut count = 0;
            Ok(walk_tree(&root, &w, 0, md, &mut count))
        }
    }

    #[napi]
    pub fn get_focused_element() -> napi::Result<serde_json::Value> {
        let a = uia()?;
        unsafe {
            match a.GetFocusedElement() {
                Ok(elem) => Ok(element_to_json(&elem)),
                Err(_) => Ok(serde_json::json!(null)),
            }
        }
    }

    #[napi]
    pub fn find_element(window_id: u32, role: Option<String>, label: Option<String>,
        value: Option<String>, max_results: Option<i32>) -> napi::Result<serde_json::Value> {
        let max_r = max_results.unwrap_or(25).clamp(1, 100) as usize;
        let a = uia()?;
        unsafe {
            let root = a.ElementFromHandle(HWND(window_id as *mut _))
                .map_err(|e| napi::Error::from_reason(format!("ElementFromHandle: {e}")))?;
            let cond = build_condition(&a, role.as_deref(), label.as_deref())?;
            let elems = root.FindAll(TreeScope_Descendants, &cond)
                .map_err(|e| napi::Error::from_reason(format!("FindAll: {e}")))?;
            let count = elems.Length().unwrap_or(0) as usize;
            let mut results = Vec::new();
            for i in 0..count.min(max_r * 2) {
                if let Ok(elem) = elems.GetElement(i as i32) {
                    let mut node = element_to_json(&elem);
                    if let Some(ref v) = value {
                        let ev = node.get("value").and_then(|x| x.as_str()).unwrap_or("");
                        if !ev.to_lowercase().contains(&v.to_lowercase()) { continue; }
                    }
                    if let Some(ref l) = label {
                        let el = node.get("label").and_then(|x| x.as_str()).unwrap_or("");
                        if !el.to_lowercase().contains(&l.to_lowercase()) { continue; }
                    }
                    node["path"] = serde_json::json!([i]);
                    results.push(node);
                    if results.len() >= max_r { break; }
                }
            }
            Ok(serde_json::json!(results))
        }
    }

    #[napi]
    pub fn perform_action(window_id: u32, role: String, label: String, action: String)
        -> napi::Result<serde_json::Value> {
        let a = uia()?;
        let hwnd = HWND(window_id as *mut _);
        let elem = find_first(&a, hwnd, &role, &label)?;
        let Some(elem) = elem else {
            return Ok(serde_json::json!({"performed": false, "reason": "not_found"}));
        };
        unsafe {
            if let Ok(enabled) = elem.CurrentIsEnabled() {
                if !enabled.as_bool() {
                    return Ok(serde_json::json!({"performed": false, "reason": "disabled"}));
                }
            }
            if action == "AXPress" {
                if let Ok(inv) = elem.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                    let _ = inv.Invoke();
                    return Ok(serde_json::json!({"performed": true}));
                }
                if let Ok(tog) = elem.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
                    let _ = tog.Toggle();
                    return Ok(serde_json::json!({"performed": true}));
                }
                let rect = elem.CurrentBoundingRectangle().unwrap_or_default();
                return Ok(serde_json::json!({
                    "performed": false, "reason": "unsupported_action",
                    "bounds": {"x": rect.left, "y": rect.top,
                        "width": rect.right - rect.left, "height": rect.bottom - rect.top},
                }));
            }
            Ok(serde_json::json!({"performed": false, "reason": "unknown_action"}))
        }
    }

    #[napi]
    pub fn set_element_value(window_id: u32, role: String, label: String, value: String)
        -> napi::Result<serde_json::Value> {
        let a = uia()?;
        let hwnd = HWND(window_id as *mut _);
        let elem = find_first(&a, hwnd, &role, &label)?;
        let Some(elem) = elem else {
            return Ok(serde_json::json!({"set": false, "reason": "not_found"}));
        };
        unsafe {
            let pat: Result<IUIAutomationValuePattern, _> = elem.GetCurrentPatternAs(UIA_ValuePatternId);
            match pat {
                Ok(vp) => {
                    if let Ok(ro) = vp.CurrentIsReadOnly() {
                        if ro.as_bool() {
                            return Ok(serde_json::json!({"set": false, "reason": "read_only"}));
                        }
                    }
                    let bstr = windows::core::BSTR::from(value.as_str());
                    vp.SetValue(&bstr)
                        .map_err(|e| napi::Error::from_reason(format!("SetValue: {e}")))?;
                    Ok(serde_json::json!({"set": true}))
                }
                Err(_) => Ok(serde_json::json!({"set": false, "reason": "no_value_pattern"})),
            }
        }
    }

    #[napi]
    pub fn get_menu_bar(_bundle_id: String) -> napi::Result<serde_json::Value> {
        // Menu bar walking via UI Automation — find the MenuBar element
        // For now return empty array; full implementation requires walking
        // the app's menu bar tree which varies per application
        Ok(serde_json::json!([]))
    }

    #[napi]
    pub fn press_menu_item(_bundle_id: String, _menu: String, _item: String,
        _submenu: Option<String>) -> napi::Result<serde_json::Value> {
        Ok(serde_json::json!({"pressed": false, "reason": "windows_menu_navigation_not_yet_implemented"}))
    }
}
