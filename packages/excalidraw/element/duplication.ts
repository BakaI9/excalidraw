import { getNonDeletedElements } from ".";
import type { ActionResult } from "../actions/types";
import { DEFAULT_GRID_SIZE } from "../constants";
import { syncMovedIndices } from "../fractionalIndex";
import {
  bindElementsToFramesAfterDuplication,
  getFrameChildren,
} from "../frame";
import {
  getElementsInGroup,
  getSelectedGroupForElement,
  selectGroupsForSelectedElements,
} from "../groups";
import { getSelectedElements } from "../scene";
import { excludeElementsInFramesFromSelection } from "../scene/selection";
import type { AppClassProperties, AppState, PointerDownState } from "../types";
import { arrayToMap, castArray, findLastIndex, invariant } from "../utils";
import { mutateElement } from "./mutateElement";
import { duplicateElement } from "./newElement";
import { normalizeElementOrder } from "./sortElements";
import {
  bindTextToShapeAfterDuplication,
  getBoundTextElement,
  getContainerElement,
} from "./textElement";
import {
  hasBoundTextElement,
  isBindingElement,
  isBoundToContainer,
  isFrameLikeElement,
} from "./typeChecks";
import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
  PointBinding,
} from "./types";

export const duplicateElementsWithOffset = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
): Partial<Exclude<ActionResult, false>> => {
  // ---------------------------------------------------------------------------

  const groupIdMap = new Map();
  const newElements: ExcalidrawElement[] = [];
  const oldElements: ExcalidrawElement[] = [];
  const oldIdToDuplicatedId = new Map();
  const duplicatedElementsMap = new Map<string, ExcalidrawElement>();

  const elementsMap = arrayToMap(elements);

  const duplicateAndOffsetElement = <
    T extends ExcalidrawElement | ExcalidrawElement[],
  >(
    element: T,
  ): T extends ExcalidrawElement[]
    ? ExcalidrawElement[]
    : ExcalidrawElement | null => {
    const elements = castArray(element);

    const _newElements = elements.reduce(
      (acc: ExcalidrawElement[], element) => {
        if (processedIds.has(element.id)) {
          return acc;
        }

        processedIds.set(element.id, true);

        const newElement = duplicateElement(
          appState.editingGroupId,
          groupIdMap,
          element,
          {
            x: element.x + DEFAULT_GRID_SIZE / 2,
            y: element.y + DEFAULT_GRID_SIZE / 2,
          },
        );

        processedIds.set(newElement.id, true);

        duplicatedElementsMap.set(newElement.id, newElement);
        oldIdToDuplicatedId.set(element.id, newElement.id);

        oldElements.push(element);
        newElements.push(newElement);

        acc.push(newElement);
        return acc;
      },
      [],
    );

    return (
      Array.isArray(element) ? _newElements : _newElements[0] || null
    ) as T extends ExcalidrawElement[]
      ? ExcalidrawElement[]
      : ExcalidrawElement | null;
  };

  elements = normalizeElementOrder(elements);

  const idsOfElementsToDuplicate = arrayToMap(
    getSelectedElements(elements, appState, {
      includeBoundTextElement: true,
      includeElementsInFrames: true,
    }),
  );

  // Ids of elements that have already been processed so we don't push them
  // into the array twice if we end up backtracking when retrieving
  // discontiguous group of elements (can happen due to a bug, or in edge
  // cases such as a group containing deleted elements which were not selected).
  //
  // This is not enough to prevent duplicates, so we do a second loop afterwards
  // to remove them.
  //
  // For convenience we mark even the newly created ones even though we don't
  // loop over them.
  const processedIds = new Map<ExcalidrawElement["id"], true>();

  const elementsWithClones: ExcalidrawElement[] = elements.slice();

  const insertAfterIndex = (
    index: number,
    elements: ExcalidrawElement | null | ExcalidrawElement[],
  ) => {
    invariant(index !== -1, "targetIndex === -1 ");

    if (!Array.isArray(elements) && !elements) {
      return;
    }

    elementsWithClones.splice(index + 1, 0, ...castArray(elements));
  };

  const frameIdsToDuplicate = new Set(
    elements
      .filter(
        (el) => idsOfElementsToDuplicate.has(el.id) && isFrameLikeElement(el),
      )
      .map((el) => el.id),
  );

  for (const element of elements) {
    if (processedIds.has(element.id)) {
      continue;
    }

    if (!idsOfElementsToDuplicate.has(element.id)) {
      continue;
    }

    // groups
    // -------------------------------------------------------------------------

    const groupId = getSelectedGroupForElement(appState, element);
    if (groupId) {
      const groupElements = getElementsInGroup(elements, groupId).flatMap(
        (element) =>
          isFrameLikeElement(element)
            ? [...getFrameChildren(elements, element.id), element]
            : [element],
      );

      const targetIndex = findLastIndex(elementsWithClones, (el) => {
        return el.groupIds?.includes(groupId);
      });

      insertAfterIndex(targetIndex, duplicateAndOffsetElement(groupElements));
      continue;
    }

    // frame duplication
    // -------------------------------------------------------------------------

    if (element.frameId && frameIdsToDuplicate.has(element.frameId)) {
      continue;
    }

    if (isFrameLikeElement(element)) {
      const frameId = element.id;

      const frameChildren = getFrameChildren(elements, frameId);

      const targetIndex = findLastIndex(elementsWithClones, (el) => {
        return el.frameId === frameId || el.id === frameId;
      });

      insertAfterIndex(
        targetIndex,
        duplicateAndOffsetElement([...frameChildren, element]),
      );
      continue;
    }

    // text container
    // -------------------------------------------------------------------------

    if (hasBoundTextElement(element)) {
      const boundTextElement = getBoundTextElement(element, elementsMap);

      const targetIndex = findLastIndex(elementsWithClones, (el) => {
        return (
          el.id === element.id ||
          ("containerId" in el && el.containerId === element.id)
        );
      });

      if (boundTextElement) {
        insertAfterIndex(
          targetIndex,
          duplicateAndOffsetElement([element, boundTextElement]),
        );
      } else {
        insertAfterIndex(targetIndex, duplicateAndOffsetElement(element));
      }

      continue;
    }

    if (isBoundToContainer(element)) {
      const container = getContainerElement(element, elementsMap);

      const targetIndex = findLastIndex(elementsWithClones, (el) => {
        return el.id === element.id || el.id === container?.id;
      });

      if (container) {
        insertAfterIndex(
          targetIndex,
          duplicateAndOffsetElement([container, element]),
        );
      } else {
        insertAfterIndex(targetIndex, duplicateAndOffsetElement(element));
      }

      continue;
    }

    // default duplication (regular elements)
    // -------------------------------------------------------------------------

    insertAfterIndex(
      findLastIndex(elementsWithClones, (el) => el.id === element.id),
      duplicateAndOffsetElement(element),
    );
  }

  // ---------------------------------------------------------------------------

  bindTextToShapeAfterDuplication(
    elementsWithClones,
    oldElements,
    oldIdToDuplicatedId,
  );
  fixBindingsAfterDuplication(
    elementsWithClones,
    oldElements,
    oldIdToDuplicatedId,
  );
  bindElementsToFramesAfterDuplication(
    elementsWithClones,
    oldElements,
    oldIdToDuplicatedId,
  );

  const nextElementsToSelect =
    excludeElementsInFramesFromSelection(newElements);

  return {
    elements: elementsWithClones,
    appState: {
      ...appState,
      ...selectGroupsForSelectedElements(
        {
          editingGroupId: appState.editingGroupId,
          selectedElementIds: nextElementsToSelect.reduce(
            (acc: Record<ExcalidrawElement["id"], true>, element) => {
              if (!isBoundToContainer(element)) {
                acc[element.id] = true;
              }
              return acc;
            },
            {},
          ),
        },
        getNonDeletedElements(elementsWithClones),
        appState,
        null,
      ),
    },
  };
};

export const dragDuplicateElements = (
  pointerDownState: PointerDownState,
  app: AppClassProperties,
) => {
  // Move the currently selected elements to the top of the z index stack, and
  // put the duplicates where the selected elements used to be.
  // (the origin point where the dragging started)

  pointerDownState.hit.hasBeenDuplicated = true;

  const nextElements = [];
  const elementsToAppend = [];
  const groupIdMap = new Map();
  const oldIdToDuplicatedId = new Map();
  const hitElement = pointerDownState.hit.element;
  const selectedElementIds = new Set(
    app.scene
      .getSelectedElements({
        selectedElementIds: app.state.selectedElementIds,
        includeBoundTextElement: true,
        includeElementsInFrames: true,
      })
      .map((element) => element.id),
  );

  const elements = app.scene.getElementsIncludingDeleted();

  for (const element of elements) {
    const isInSelection =
      selectedElementIds.has(element.id) ||
      // case: the state.selectedElementIds might not have been
      // updated yet by the time this mousemove event is fired
      (element.id === hitElement?.id &&
        pointerDownState.hit.wasAddedToSelection);
    // NOTE (mtolmacs): This is a temporary fix for very large scenes
    if (
      Math.abs(element.x) > 1e7 ||
      Math.abs(element.x) > 1e7 ||
      Math.abs(element.width) > 1e7 ||
      Math.abs(element.height) > 1e7
    ) {
      console.error(
        `Alt+dragging element in scene with invalid dimensions`,
        element.x,
        element.y,
        element.width,
        element.height,
        isInSelection,
      );

      return;
    }

    if (isInSelection) {
      const duplicatedElement = duplicateElement(
        app.state.editingGroupId,
        groupIdMap,
        element,
      );

      // NOTE (mtolmacs): This is a temporary fix for very large scenes
      if (
        Math.abs(duplicatedElement.x) > 1e7 ||
        Math.abs(duplicatedElement.x) > 1e7 ||
        Math.abs(duplicatedElement.width) > 1e7 ||
        Math.abs(duplicatedElement.height) > 1e7
      ) {
        console.error(
          `Alt+dragging duplicated element with invalid dimensions`,
          duplicatedElement.x,
          duplicatedElement.y,
          duplicatedElement.width,
          duplicatedElement.height,
        );

        return;
      }

      const origElement = pointerDownState.originalElements.get(element.id)!;

      // NOTE (mtolmacs): This is a temporary fix for very large scenes
      if (
        Math.abs(origElement.x) > 1e7 ||
        Math.abs(origElement.x) > 1e7 ||
        Math.abs(origElement.width) > 1e7 ||
        Math.abs(origElement.height) > 1e7
      ) {
        console.error(
          `Alt+dragging duplicated element with invalid dimensions`,
          origElement.x,
          origElement.y,
          origElement.width,
          origElement.height,
        );

        return;
      }

      mutateElement(duplicatedElement, {
        x: origElement.x,
        y: origElement.y,
      });

      // put duplicated element to pointerDownState.originalElements
      // so that we can snap to the duplicated element without releasing
      pointerDownState.originalElements.set(
        duplicatedElement.id,
        duplicatedElement,
      );

      nextElements.push(duplicatedElement);
      elementsToAppend.push(element);
      oldIdToDuplicatedId.set(element.id, duplicatedElement.id);
    } else {
      nextElements.push(element);
    }
  }

  let nextSceneElements: ExcalidrawElement[] = [
    ...nextElements,
    ...elementsToAppend,
  ];

  const mappedNewSceneElements = app.props.onDuplicate?.(
    nextSceneElements,
    elements,
  );

  nextSceneElements = mappedNewSceneElements || nextSceneElements;

  syncMovedIndices(nextSceneElements, arrayToMap(elementsToAppend));

  bindTextToShapeAfterDuplication(
    nextElements,
    elementsToAppend,
    oldIdToDuplicatedId,
  );
  fixBindingsAfterDuplication(
    nextSceneElements,
    elementsToAppend,
    oldIdToDuplicatedId,
    "duplicatesServeAsOld",
  );
  bindElementsToFramesAfterDuplication(
    nextSceneElements,
    elementsToAppend,
    oldIdToDuplicatedId,
  );

  return nextSceneElements;
};

// We need to:
// 1: Update elements not selected to point to duplicated elements
// 2: Update duplicated elements to point to other duplicated elements
const fixBindingsAfterDuplication = (
  sceneElements: readonly ExcalidrawElement[],
  oldElements: readonly ExcalidrawElement[],
  oldIdToDuplicatedId: Map<ExcalidrawElement["id"], ExcalidrawElement["id"]>,
  // There are three copying mechanisms: Copy-paste, duplication and alt-drag.
  // Only when alt-dragging the new "duplicates" act as the "old", while
  // the "old" elements act as the "new copy" - essentially working reverse
  // to the other two.
  duplicatesServeAsOld?: "duplicatesServeAsOld" | undefined,
): void => {
  // First collect all the binding/bindable elements, so we only update
  // each once, regardless of whether they were duplicated or not.
  const allBoundElementIds: Set<ExcalidrawElement["id"]> = new Set();
  const allBindableElementIds: Set<ExcalidrawElement["id"]> = new Set();
  const shouldReverseRoles = duplicatesServeAsOld === "duplicatesServeAsOld";
  const duplicateIdToOldId = new Map(
    [...oldIdToDuplicatedId].map(([key, value]) => [value, key]),
  );
  oldElements.forEach((oldElement) => {
    const { boundElements } = oldElement;
    if (boundElements != null && boundElements.length > 0) {
      boundElements.forEach((boundElement) => {
        if (shouldReverseRoles && !oldIdToDuplicatedId.has(boundElement.id)) {
          allBoundElementIds.add(boundElement.id);
        }
      });
      allBindableElementIds.add(oldIdToDuplicatedId.get(oldElement.id)!);
    }
    if (isBindingElement(oldElement)) {
      if (oldElement.startBinding != null) {
        const { elementId } = oldElement.startBinding;
        if (shouldReverseRoles && !oldIdToDuplicatedId.has(elementId)) {
          allBindableElementIds.add(elementId);
        }
      }
      if (oldElement.endBinding != null) {
        const { elementId } = oldElement.endBinding;
        if (shouldReverseRoles && !oldIdToDuplicatedId.has(elementId)) {
          allBindableElementIds.add(elementId);
        }
      }
      if (oldElement.startBinding != null || oldElement.endBinding != null) {
        allBoundElementIds.add(oldIdToDuplicatedId.get(oldElement.id)!);
      }
    }
  });

  // Update the linear elements
  (
    sceneElements.filter(({ id }) =>
      allBoundElementIds.has(id),
    ) as ExcalidrawLinearElement[]
  ).forEach((element) => {
    const { startBinding, endBinding } = element;
    mutateElement(element, {
      startBinding: newBindingAfterDuplication(
        startBinding,
        oldIdToDuplicatedId,
      ),
      endBinding: newBindingAfterDuplication(endBinding, oldIdToDuplicatedId),
    });
  });

  // Update the bindable shapes
  sceneElements
    .filter(({ id }) => allBindableElementIds.has(id))
    .forEach((bindableElement) => {
      const oldElementId = duplicateIdToOldId.get(bindableElement.id);
      const boundElements = sceneElements.find(
        ({ id }) => id === oldElementId,
      )?.boundElements;

      if (boundElements && boundElements.length > 0) {
        mutateElement(bindableElement, {
          boundElements: boundElements.map((boundElement) =>
            oldIdToDuplicatedId.has(boundElement.id)
              ? {
                  id: oldIdToDuplicatedId.get(boundElement.id)!,
                  type: boundElement.type,
                }
              : boundElement,
          ),
        });
      }
    });
};

const newBindingAfterDuplication = (
  binding: PointBinding | null,
  oldIdToDuplicatedId: Map<ExcalidrawElement["id"], ExcalidrawElement["id"]>,
): PointBinding | null => {
  if (binding == null) {
    return null;
  }
  return {
    ...binding,
    elementId: oldIdToDuplicatedId.get(binding.elementId) ?? binding.elementId,
  };
};
