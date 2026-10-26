// ── Linux implementation — AT-SPI2 stub ──────────────────────────────────────
#[cfg(target_os = "linux")]
mod platform {
    use napi_derive::napi;

    // AT-SPI2 integration would go here. For now, provide stubs that return
    // meaningful errors so the rest of the system works.

    #[napi]
    pub fn get_ui_tree(
        _window_id: u32,
        _max_depth: Option<i32>,
    ) -> napi::Result<serde_json::Value> {
        Err(napi::Error::from_reason("Linux accessibility requires the MCP AT-SPI bridge (python3-gi + gir1.2-atspi-2.0)"))
    }

    #[napi]
    pub fn get_focused_element() -> napi::Result<serde_json::Value> {
        Err(napi::Error::from_reason("Focused accessibility lookup is unavailable on this Linux backend"))
    }

    #[napi]
    pub fn find_element(
        _window_id: u32,
        _role: Option<String>,
        _label: Option<String>,
        _value: Option<String>,
        _max_results: Option<i32>,
    ) -> napi::Result<serde_json::Value> {
        Err(napi::Error::from_reason("Linux accessibility requires the MCP AT-SPI bridge"))
    }

    #[napi]
    pub fn perform_action(
        _window_id: u32,
        _role: String,
        _label: String,
        _action: String,
    ) -> napi::Result<serde_json::Value> {
        Err(napi::Error::from_reason(
            "AT-SPI2 accessibility not yet implemented on Linux",
        ))
    }

    #[napi]
    pub fn set_element_value(
        _window_id: u32,
        _role: String,
        _label: String,
        _value: String,
    ) -> napi::Result<serde_json::Value> {
        Err(napi::Error::from_reason(
            "AT-SPI2 accessibility not yet implemented on Linux",
        ))
    }

    #[napi]
    pub fn get_menu_bar(_bundle_id: String) -> napi::Result<serde_json::Value> {
        Ok(serde_json::json!([]))
    }

    #[napi]
    pub fn press_menu_item(
        _bundle_id: String,
        _menu: String,
        _item: String,
        _submenu: Option<String>,
    ) -> napi::Result<serde_json::Value> {
        Err(napi::Error::from_reason(
            "Menu bar access not yet implemented on Linux",
        ))
    }
}

// ── macOS implementation ──────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
#[path = "accessibility_macos.rs"]
mod platform;

// ── Windows implementation — IUIAutomation COM ───────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use napi_derive::napi;
    use windows::core::Interface;
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Accessibility::*;

    /// 7.7.0 (W7): how long UI Automation may wait to reach an app, and for one request to finish. A hung or busy app
    /// otherwise held a tree walk or an element search for the library's own timeouts; these return an error instead.
    const UIA_CONNECTION_TIMEOUT_MS: u32 = 2_000;
    const UIA_TRANSACTION_TIMEOUT_MS: u32 = 5_000;

    thread_local! {
        // One client per thread (the JavaScript thread and each worker, K4): creating it is a COM activation per call.
        static UIA: std::cell::RefCell<Option<IUIAutomation>> = const { std::cell::RefCell::new(None) };
    }

    /// UI Automation 8 (Windows 8 and later) with the timeouts above; the original client where it is missing.
    fn create_uia() -> napi::Result<IUIAutomation> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if let Ok(client) = CoCreateInstance::<_, IUIAutomation2>(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) {
                let _ = client.SetConnectionTimeout(UIA_CONNECTION_TIMEOUT_MS);
                let _ = client.SetTransactionTimeout(UIA_TRANSACTION_TIMEOUT_MS);
                return client
                    .cast::<IUIAutomation>()
                    .map_err(|e| napi::Error::from_reason(format!("IUIAutomation init: {e}")));
            }
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| napi::Error::from_reason(format!("IUIAutomation init: {e}")))
        }
    }

    fn uia() -> napi::Result<IUIAutomation> {
        UIA.with(|cell| {
            if let Some(client) = cell.borrow().as_ref() {
                return Ok(client.clone());
            }
            let client = create_uia()?;
            *cell.borrow_mut() = Some(client.clone());
            Ok(client)
        })
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

    /// What `control_type_to_role` reports for a control type it has no name for.
    const UNKNOWN_ROLE: &str = "AXUnknown";

    /// 7.7.0: every role `get_ui_tree` reports, with all the control types it stands for, so a search by a reported
    /// role finds the element: `AXGroup` is a group or a pane, `AXRadioButton` a radio button or a tab item, and
    /// `AXWebArea` a document. `AXTextArea` stays accepted as another name for an edit control.
    const ROLES: &[(&str, &[UIA_CONTROLTYPE_ID])] = &[
        ("AXButton", &[UIA_ButtonControlTypeId]),
        ("AXTextField", &[UIA_EditControlTypeId]),
        ("AXTextArea", &[UIA_EditControlTypeId]),
        ("AXStaticText", &[UIA_TextControlTypeId]),
        ("AXCheckBox", &[UIA_CheckBoxControlTypeId]),
        ("AXComboBox", &[UIA_ComboBoxControlTypeId]),
        ("AXList", &[UIA_ListControlTypeId]),
        ("AXCell", &[UIA_ListItemControlTypeId]),
        ("AXMenu", &[UIA_MenuControlTypeId]),
        ("AXMenuItem", &[UIA_MenuItemControlTypeId]),
        ("AXMenuBar", &[UIA_MenuBarControlTypeId]),
        ("AXTabGroup", &[UIA_TabControlTypeId]),
        ("AXRadioButton", &[UIA_RadioButtonControlTypeId, UIA_TabItemControlTypeId]),
        ("AXOutline", &[UIA_TreeControlTypeId]),
        ("AXRow", &[UIA_TreeItemControlTypeId]),
        ("AXWindow", &[UIA_WindowControlTypeId]),
        ("AXGroup", &[UIA_GroupControlTypeId, UIA_PaneControlTypeId]),
        ("AXSlider", &[UIA_SliderControlTypeId]),
        ("AXProgressIndicator", &[UIA_ProgressBarControlTypeId]),
        ("AXScrollBar", &[UIA_ScrollBarControlTypeId]),
        ("AXToolbar", &[UIA_ToolBarControlTypeId]),
        ("AXLink", &[UIA_HyperlinkControlTypeId]),
        ("AXImage", &[UIA_ImageControlTypeId]),
        ("AXWebArea", &[UIA_DocumentControlTypeId]),
    ];

    fn role_control_types(role: &str) -> Option<&'static [UIA_CONTROLTYPE_ID]> {
        ROLES.iter().find(|(name, _)| *name == role).map(|(_, types)| *types)
    }

    /// Every control type some role names; `AXUnknown` is the rest.
    fn mapped_control_types() -> Vec<UIA_CONTROLTYPE_ID> {
        let mut all: Vec<UIA_CONTROLTYPE_ID> = ROLES.iter().flat_map(|(_, types)| types.iter().copied()).collect();
        all.sort_by_key(|ct| ct.0);
        all.dedup();
        all
    }

    /// The roles a search accepts (`find_element`, `click_element`, `set_value`): the table's names and `AXUnknown`.
    #[napi]
    pub fn uia_roles() -> Vec<String> {
        ROLES.iter().map(|(name, _)| name.to_string()).chain(std::iter::once(UNKNOWN_ROLE.to_string())).collect()
    }

    /// One condition that is true for any of the control types.
    fn any_control_type(automation: &IUIAutomation, types: &[UIA_CONTROLTYPE_ID]) -> napi::Result<IUIAutomationCondition> {
        unsafe {
            let mut combined: Option<IUIAutomationCondition> = None;
            for ct in types {
                let v = windows::core::VARIANT::from(ct.0);
                let c = automation
                    .CreatePropertyCondition(UIA_ControlTypePropertyId, &v)
                    .map_err(|e| napi::Error::from_reason(format!("condition: {e}")))?;
                combined = Some(match combined {
                    None => c,
                    Some(previous) => automation
                        .CreateOrCondition(&previous, &c)
                        .map_err(|e| napi::Error::from_reason(format!("or_cond: {e}")))?,
                });
            }
            match combined {
                Some(c) => Ok(c),
                None => automation.CreateFalseCondition().map_err(|e| napi::Error::from_reason(format!("false_cond: {e}"))),
            }
        }
    }

    /// The condition for a role: its control types; for `AXUnknown`, none of the mapped ones. A role the table does
    /// not name matches nothing (before 7.7.0 it was dropped and the search matched every role).
    fn role_condition(automation: &IUIAutomation, role: &str) -> napi::Result<IUIAutomationCondition> {
        if role == UNKNOWN_ROLE {
            let mapped = any_control_type(automation, &mapped_control_types())?;
            return unsafe { automation.CreateNotCondition(&mapped) }
                .map_err(|e| napi::Error::from_reason(format!("not_cond: {e}")));
        }
        any_control_type(automation, role_control_types(role).unwrap_or(&[]))
    }

    fn element_to_json(elem: &IUIAutomationElement) -> serde_json::Value {
        unsafe {
            let role = elem
                .CurrentControlType()
                .map(|ct| control_type_to_role(ct))
                .unwrap_or("AXUnknown");
            let label = elem.CurrentName().ok().map(|s| s.to_string());
            let label_sensitive = label
                .as_deref()
                .map(|value| {
                    let lower = value.to_ascii_lowercase();
                    lower.contains("password")
                        || lower.contains("passcode")
                        || lower.contains("one-time")
                        || lower.contains("one time")
                        || lower.contains("otp")
                        || lower.contains("pin")
                        || lower.contains("cvv")
                        || lower.contains("cvc")
                })
                .unwrap_or(false);
            let uia_password = elem
                .CurrentIsPassword()
                .map(|value| value.as_bool())
                .unwrap_or(false);
            let sensitive = uia_password || label_sensitive;
            let mut sensitivity_signals: Vec<&str> = Vec::new();
            if uia_password {
                sensitivity_signals.push("uia_is_password");
            }
            if label_sensitive {
                sensitivity_signals.push("sensitive_label");
            }
            let value = if sensitive {
                None
            } else {
                elem.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .ok()
                    .and_then(|p| p.CurrentValue().ok().map(|s| s.to_string()))
            };
            let rect = elem.CurrentBoundingRectangle().unwrap_or_default();
            let mut actions = Vec::new();
            if elem
                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .is_ok()
            {
                actions.push("AXPress");
            }
            if elem
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .is_ok()
            {
                actions.push("AXSetValue");
            }
            if elem
                .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                .is_ok()
                && !actions.contains(&"AXPress")
            {
                actions.push("AXPress");
            }
            serde_json::json!({
                "role": role, "label": label, "value": value,
                "sensitive": sensitive, "sensitivitySignals": sensitivity_signals,
                "bounds": { "x": rect.left, "y": rect.top,
                    "width": rect.right - rect.left, "height": rect.bottom - rect.top },
                "actions": actions,
            })
        }
    }

    const NODE_LIMIT: usize = 500;

    fn walk_tree(
        elem: &IUIAutomationElement,
        walker: &IUIAutomationTreeWalker,
        depth: i32,
        max_depth: i32,
        count: &mut usize,
    ) -> serde_json::Value {
        if *count >= NODE_LIMIT {
            return serde_json::json!({"truncated": true});
        }
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
        if *count >= NODE_LIMIT {
            node["truncated"] = serde_json::json!(true);
        }
        node
    }

    fn build_condition(
        automation: &IUIAutomation,
        role: Option<&str>,
        label: Option<&str>,
    ) -> napi::Result<IUIAutomationCondition> {
        unsafe {
            let mut conds: Vec<IUIAutomationCondition> = Vec::new();
            if let Some(r) = role {
                conds.push(role_condition(automation, r)?);
            }
            if let Some(name) = label {
                let bstr = windows::core::BSTR::from(name);
                let v = windows::core::VARIANT::from(bstr);
                if let Ok(c) = automation.CreatePropertyCondition(UIA_NamePropertyId, &v) {
                    conds.push(c);
                }
            }
            if conds.is_empty() {
                return automation
                    .CreateTrueCondition()
                    .map_err(|e| napi::Error::from_reason(format!("true_cond: {e}")));
            }
            if conds.len() == 1 {
                return Ok(conds.into_iter().next().unwrap());
            }
            let mut combined = conds[0].clone();
            for c in &conds[1..] {
                combined = automation
                    .CreateAndCondition(&combined, c)
                    .map_err(|e| napi::Error::from_reason(format!("and_cond: {e}")))?;
            }
            Ok(combined)
        }
    }

    fn find_first(
        automation: &IUIAutomation,
        hwnd: HWND,
        role: &str,
        label: &str,
    ) -> napi::Result<Option<IUIAutomationElement>> {
        unsafe {
            let root = automation
                .ElementFromHandle(hwnd)
                .map_err(|e| napi::Error::from_reason(format!("ElementFromHandle: {e}")))?;
            let cond = build_condition(
                automation,
                Some(role),
                if label.is_empty() { None } else { Some(label) },
            )?;
            let elems = root
                .FindAll(TreeScope_Descendants, &cond)
                .map_err(|e| napi::Error::from_reason(format!("FindAll: {e}")))?;
            let count = elems.Length().unwrap_or(0);
            for i in 0..count {
                if let Ok(elem) = elems.GetElement(i) {
                    let name = elem.CurrentName().ok().map(|s| s.to_string());
                    let n = name.as_deref().unwrap_or("");
                    if label.is_empty()
                        || n.to_lowercase() == label.to_lowercase()
                        || n.to_lowercase().contains(&label.to_lowercase())
                    {
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
            let root = a
                .ElementFromHandle(HWND(window_id as *mut _))
                .map_err(|e| napi::Error::from_reason(format!("ElementFromHandle: {e}")))?;
            let w = a
                .ControlViewWalker()
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
    pub fn find_element(
        window_id: u32,
        role: Option<String>,
        label: Option<String>,
        value: Option<String>,
        max_results: Option<i32>,
    ) -> napi::Result<serde_json::Value> {
        let max_r = max_results.unwrap_or(25).clamp(1, 100) as usize;
        let a = uia()?;
        unsafe {
            let root = a
                .ElementFromHandle(HWND(window_id as *mut _))
                .map_err(|e| napi::Error::from_reason(format!("ElementFromHandle: {e}")))?;
            let cond = build_condition(&a, role.as_deref(), label.as_deref())?;
            let elems = root
                .FindAll(TreeScope_Descendants, &cond)
                .map_err(|e| napi::Error::from_reason(format!("FindAll: {e}")))?;
            let count = elems.Length().unwrap_or(0) as usize;
            let mut results = Vec::new();
            for i in 0..count.min(max_r * 2) {
                if let Ok(elem) = elems.GetElement(i as i32) {
                    let mut node = element_to_json(&elem);
                    if let Some(ref v) = value {
                        let ev = node.get("value").and_then(|x| x.as_str()).unwrap_or("");
                        if !ev.to_lowercase().contains(&v.to_lowercase()) {
                            continue;
                        }
                    }
                    if let Some(ref l) = label {
                        let el = node.get("label").and_then(|x| x.as_str()).unwrap_or("");
                        if !el.to_lowercase().contains(&l.to_lowercase()) {
                            continue;
                        }
                    }
                    node["path"] = serde_json::json!([i]);
                    results.push(node);
                    if results.len() >= max_r {
                        break;
                    }
                }
            }
            Ok(serde_json::json!(results))
        }
    }

    #[napi]
    pub fn perform_action(
        window_id: u32,
        role: String,
        label: String,
        action: String,
    ) -> napi::Result<serde_json::Value> {
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
                // 7.6.1: a failed Invoke or Toggle used to be reported as performed.
                if let Ok(inv) =
                    elem.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                {
                    return Ok(match inv.Invoke() {
                        Ok(()) => serde_json::json!({"performed": true}),
                        Err(error) => serde_json::json!({
                            "performed": false,
                            "reason": "invoke_failed",
                            "detail": error.to_string(),
                        }),
                    });
                }
                if let Ok(tog) =
                    elem.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                {
                    return Ok(match tog.Toggle() {
                        Ok(()) => serde_json::json!({"performed": true}),
                        Err(error) => serde_json::json!({
                            "performed": false,
                            "reason": "toggle_failed",
                            "detail": error.to_string(),
                        }),
                    });
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
    pub fn set_element_value(
        window_id: u32,
        role: String,
        label: String,
        value: String,
    ) -> napi::Result<serde_json::Value> {
        let a = uia()?;
        let hwnd = HWND(window_id as *mut _);
        let elem = find_first(&a, hwnd, &role, &label)?;
        let Some(elem) = elem else {
            return Ok(serde_json::json!({"set": false, "reason": "not_found"}));
        };
        unsafe {
            let pat: Result<IUIAutomationValuePattern, _> =
                elem.GetCurrentPatternAs(UIA_ValuePatternId);
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
    pub fn press_menu_item(
        _bundle_id: String,
        _menu: String,
        _item: String,
        _submenu: Option<String>,
    ) -> napi::Result<serde_json::Value> {
        Ok(
            serde_json::json!({"pressed": false, "reason": "windows_menu_navigation_not_yet_implemented"}),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Every control type `control_type_to_role` names, so the table can be checked against it.
        const NAMED: &[UIA_CONTROLTYPE_ID] = &[
            UIA_ButtonControlTypeId, UIA_EditControlTypeId, UIA_TextControlTypeId, UIA_CheckBoxControlTypeId,
            UIA_ComboBoxControlTypeId, UIA_ListControlTypeId, UIA_ListItemControlTypeId, UIA_MenuControlTypeId,
            UIA_MenuItemControlTypeId, UIA_MenuBarControlTypeId, UIA_TabControlTypeId, UIA_TabItemControlTypeId,
            UIA_TreeControlTypeId, UIA_TreeItemControlTypeId, UIA_WindowControlTypeId, UIA_GroupControlTypeId,
            UIA_SliderControlTypeId, UIA_ProgressBarControlTypeId, UIA_ScrollBarControlTypeId, UIA_ToolBarControlTypeId,
            UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId, UIA_RadioButtonControlTypeId, UIA_DocumentControlTypeId,
            UIA_PaneControlTypeId,
        ];

        #[test]
        fn every_reported_role_finds_its_control_type() {
            for &ct in NAMED {
                let role = control_type_to_role(ct);
                assert_ne!(role, UNKNOWN_ROLE, "control type {} has a name", ct.0);
                let types = role_control_types(role).unwrap_or_else(|| panic!("{role} is missing from ROLES"));
                assert!(types.contains(&ct), "{role} does not search control type {}", ct.0);
            }
        }

        #[test]
        fn panes_are_groups_and_tab_items_are_radio_buttons() {
            assert!(role_control_types("AXGroup").unwrap().contains(&UIA_PaneControlTypeId));
            assert!(role_control_types("AXRadioButton").unwrap().contains(&UIA_TabItemControlTypeId));
            assert_eq!(role_control_types("AXWebArea"), Some(&[UIA_DocumentControlTypeId][..]));
        }

        #[test]
        fn unknown_names_are_not_roles_and_unknown_is_the_rest() {
            assert_eq!(role_control_types("AXButon"), None);
            assert_eq!(role_control_types(""), None);
            let mapped = mapped_control_types();
            for &ct in NAMED {
                assert!(mapped.contains(&ct));
            }
            assert!(!mapped.contains(&UIA_CustomControlTypeId));
            assert_eq!(control_type_to_role(UIA_CustomControlTypeId), UNKNOWN_ROLE);
            let roles = uia_roles();
            assert!(roles.iter().any(|r| r == UNKNOWN_ROLE));
            assert_eq!(roles.len(), ROLES.len() + 1);
        }
    }
}

// ── 7.7.0 (K4): the walks on a worker thread ─────────────────────────────────
// A walk of a large window takes seconds. These resolve a promise with what the synchronous call returns, so the
// JavaScript thread (and the status card's Stop) is never held by one.

#[napi_derive::napi]
pub fn get_ui_tree_async(
    window_id: u32,
    max_depth: Option<i32>,
) -> napi::bindgen_prelude::AsyncTask<crate::async_task::JsonTask> {
    crate::async_task::spawn(move || platform::get_ui_tree(window_id, max_depth))
}

#[napi_derive::napi]
pub fn find_element_async(
    window_id: u32,
    role: Option<String>,
    label: Option<String>,
    value: Option<String>,
    max_results: Option<i32>,
) -> napi::bindgen_prelude::AsyncTask<crate::async_task::JsonTask> {
    crate::async_task::spawn(move || platform::find_element(window_id, role, label, value, max_results))
}

#[napi_derive::napi]
pub fn get_menu_bar_async(bundle_id: String) -> napi::bindgen_prelude::AsyncTask<crate::async_task::JsonTask> {
    crate::async_task::spawn(move || platform::get_menu_bar(bundle_id))
}
