import type {
  ElementUpdate,
  ExcalidrawElement,
  SceneElementsMap,
} from "./types";
import Scene from "../scene/Scene";
import { getSizeFromPoints } from "../points";
import { randomInteger } from "../random";
import { getUpdatedTimestamp, toBrandedType } from "../utils";
import type { Mutable } from "../utility-types";
import { ShapeCache } from "../scene/ShapeCache";
import {
  isArrowElement,
  isBindableElement,
  isElbowArrow,
  isTextElement,
} from "./typeChecks";
import { updateElbowArrowPoints } from "./elbowArrow";
import type { Radians } from "@excalidraw/math";

// This function tracks updates of text elements for the purposes for collaboration.
// The version is used to compare updates when more than one user is working in
// the same drawing. Note: this will trigger the component to update. Make sure you
// are calling it either from a React event handler or within unstable_batchedUpdates().
export const mutateElement = <TElement extends Mutable<ExcalidrawElement>>(
  element: TElement,
  updates: ElementUpdate<TElement>,
  informMutation = true,
  options?: {
    // Currently only for elbow arrows.
    // If true, the elbow arrow tries to bind to the nearest element. If false
    // it tries to keep the same bound element, if any.
    isDragging?: boolean;
  },
): TElement => {
  // casting to any because can't use `in` operator
  // (see https://github.com/microsoft/TypeScript/issues/21732)
  const { points, fixedSegments, startBinding, endBinding } = updates as any;

  if (
    isElbowArrow(element) &&
    (Object.keys(updates).length === 0 || // normalization case
      typeof points !== "undefined" || // repositioning
      typeof fixedSegments !== "undefined" || // segment fixing
      typeof startBinding !== "undefined" ||
      typeof endBinding !== "undefined") // manual binding to element
  ) {
    const elementsMap = toBrandedType<SceneElementsMap>(
      Scene.getScene(element)?.getNonDeletedElementsMap() ?? new Map(),
    );

    updates = {
      ...updates,
      angle: 0 as Radians,
      ...updateElbowArrowPoints(
        {
          ...element,
          x: updates.x || element.x,
          y: updates.y || element.y,
        },
        elementsMap,
        {
          fixedSegments,
          points,
          startBinding,
          endBinding,
        },
        {
          isDragging: options?.isDragging,
        },
      ),
    };
  } else if (typeof points !== "undefined") {
    updates = { ...getSizeFromPoints(points), ...updates };
  }

  const scene = Scene.getScene(element);

  const changes = syncBindings(
    element,
    updates,
    scene?.getElementsMapIncludingDeleted(),
  );

  for (const { element: el, updates: update } of changes) {
    innerMutateElement(el, update);
  }

  if (informMutation) {
    scene?.triggerUpdate();
  }

  return element;
};

const innerMutateElement = <TElement extends Mutable<ExcalidrawElement>>(
  element: TElement,
  updates: ElementUpdate<TElement>,
) => {
  // casting to any because can't use `in` operator
  // (see https://github.com/microsoft/TypeScript/issues/21732)
  const { points, fileId } = updates as any;

  let didChange = false;

  for (const key in updates) {
    const value = (updates as any)[key];
    if (typeof value !== "undefined") {
      if (
        (element as any)[key] === value &&
        // if object, always update because its attrs could have changed
        // (except for specific keys we handle below)
        (typeof value !== "object" ||
          value === null ||
          key === "groupIds" ||
          key === "scale")
      ) {
        continue;
      }

      if (key === "scale") {
        const prevScale = (element as any)[key];
        const nextScale = value;
        if (prevScale[0] === nextScale[0] && prevScale[1] === nextScale[1]) {
          continue;
        }
      } else if (key === "points") {
        const prevPoints = (element as any)[key];
        const nextPoints = value;
        if (prevPoints.length === nextPoints.length) {
          let didChangePoints = false;
          let index = prevPoints.length;
          while (--index) {
            const prevPoint = prevPoints[index];
            const nextPoint = nextPoints[index];
            if (
              prevPoint[0] !== nextPoint[0] ||
              prevPoint[1] !== nextPoint[1]
            ) {
              didChangePoints = true;
              break;
            }
          }
          if (!didChangePoints) {
            continue;
          }
        }
      }

      (element as any)[key] = value;
      didChange = true;
    }
  }

  if (!didChange) {
    return;
  }

  if (
    typeof updates.height !== "undefined" ||
    typeof updates.width !== "undefined" ||
    typeof fileId != "undefined" ||
    typeof points !== "undefined"
  ) {
    ShapeCache.delete(element);
  }

  element.version++;
  element.versionNonce = randomInteger();
  element.updated = getUpdatedTimestamp();
};

const syncBindings = <TElement extends Mutable<ExcalidrawElement>>(
  element: TElement,
  updates: ElementUpdate<TElement>,
  elementsMap?: SceneElementsMap,
): { element: TElement; updates: ElementUpdate<TElement> }[] => {
  const changes: { element: TElement; updates: ElementUpdate<TElement> }[] = [
    { element, updates },
  ];

  if (isBindableElement(element)) {
    const { boundElements } = updates as any;

    if (!boundElements) {
      return changes;
    }

    for (const boundElement of boundElements) {
      switch (boundElement.type) {
        case "arrow":
          console.error(
            `Cannot bind an arrow element by updating the boundElements ` +
              `property! Bind it by updating the arrow startBinding or ` +
              `endBinding.`,
          );
          break;
        case "text":
          if (isTextElement(element)) {
            console.error(`Text element cannot bind to another text element`);
            continue;
          }

          const textElement = elementsMap?.get(boundElement.id);

          if (!textElement) {
            console.error(`Text element is not in scene for ${element.id}`);
            continue;
          }

          changes.push({
            element: textElement as TElement,
            updates: {
              containerId: element.id,
            } as any,
          });

          break;
        default:
          console.error(
            `Unknown bound element type ${boundElement.type} ` +
              `for element ${element.id}`,
          );
      }
    }
  } else if (isArrowElement(element)) {
    let { startBinding, endBinding } = updates as any;

    if (startBinding === undefined) {
      startBinding = element.startBinding;
    }

    if (endBinding === undefined) {
      endBinding = element.endBinding;
    }

    if (startBinding) {
      const startElement = elementsMap?.get(startBinding.elementId);

      if (startElement) {
        if (!startElement.boundElements?.find((el) => el.id === element.id)) {
          changes.push({
            element: startElement as TElement,
            updates: {
              boundElements: [
                ...(startElement.boundElements ?? []),
                {
                  id: element.id,
                  type: "arrow",
                },
              ],
            } as any,
          });
        }
      } else {
        // TODO: Should be an invariant
        console.error(
          `Start element with id ${startBinding.elementId} not found while syncing bindings for ${element.id}`,
        );
      }
    }

    if (endBinding) {
      const endElement = elementsMap?.get(endBinding.elementId);

      if (endElement) {
        if (!endElement.boundElements?.find((el) => el.id === element.id)) {
          changes.push({
            element: endElement as TElement,
            updates: {
              boundElements: [
                ...(endElement.boundElements ?? []),
                {
                  id: element.id,
                  type: "arrow",
                },
              ],
            } as any,
          });
        }
      } else {
        // TODO: Should be an invariant
        console.error(
          `End element with id ${endBinding.elementId} not found while syncing bindings for ${element.id}`,
        );
      }
    }
  }

  return changes;
};
