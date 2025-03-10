import { KEYS } from "../keys";
import { register } from "./register";
import { getNonDeletedElements } from "../element";
import { isSomeElementSelected } from "../scene";
import { ToolButton } from "../components/ToolButton";
import { t } from "../i18n";
import { getShortcutKey } from "../utils";
import { LinearElementEditor } from "../element/linearElementEditor";
import { DuplicateIcon } from "../components/icons";
import { CaptureUpdateAction } from "../store";
import { duplicateElementsWithOffset } from "../element/duplication";

export const actionDuplicateSelection = register({
  name: "duplicateSelection",
  label: "labels.duplicateSelection",
  icon: DuplicateIcon,
  trackEvent: { category: "element" },
  perform: (elements, appState, formData, app) => {
    // duplicate selected point(s) if editing a line
    if (appState.editingLinearElement) {
      // TODO: Invariants should be checked here instead of duplicateSelectedPoints()
      try {
        const newAppState = LinearElementEditor.duplicateSelectedPoints(
          appState,
          app.scene.getNonDeletedElementsMap(),
        );

        return {
          elements,
          appState: newAppState,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        };
      } catch {
        return false;
      }
    }

    const nextState = duplicateElementsWithOffset(elements, appState);

    if (app.props.onDuplicate && nextState.elements) {
      const mappedElements = app.props.onDuplicate(
        nextState.elements,
        elements,
      );
      if (mappedElements) {
        nextState.elements = mappedElements;
      }
    }

    return {
      ...nextState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  keyTest: (event) => event[KEYS.CTRL_OR_CMD] && event.key === KEYS.D,
  PanelComponent: ({ elements, appState, updateData }) => (
    <ToolButton
      type="button"
      icon={DuplicateIcon}
      title={`${t("labels.duplicateSelection")} — ${getShortcutKey(
        "CtrlOrCmd+D",
      )}`}
      aria-label={t("labels.duplicateSelection")}
      onClick={() => updateData(null)}
      visible={isSomeElementSelected(getNonDeletedElements(elements), appState)}
    />
  ),
});
