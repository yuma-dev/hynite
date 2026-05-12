import { controllerActionIds, type AppSettings, type ControllerActionId, type ControllerButtonBinding, type ControllerSettings } from "@hynite/core";

export const DEFAULT_CONTROLLER_BINDINGS: Record<ControllerActionId, ControllerButtonBinding> = {
  focusBigPicture: { buttons: [8, 9] },
  exitBigPicture: { buttons: [8, 9] },
  moveUp: { buttons: [12] },
  moveDown: { buttons: [13] },
  moveLeft: { buttons: [14] },
  moveRight: { buttons: [15] },
  previousGroup: { buttons: [4] },
  nextGroup: { buttons: [5] },
  play: { buttons: [0] },
  details: { buttons: [2] },
  filters: { buttons: [3] },
  back: { buttons: [1] },
  toggleGrid: { buttons: [10] },
  favoriteTab: { buttons: [9] }
};

export const CONTROLLER_ACTION_LABELS: Record<ControllerActionId, string> = {
  focusBigPicture: "Focus Big Picture",
  exitBigPicture: "Exit Big Picture",
  moveUp: "Move up",
  moveDown: "Move down",
  moveLeft: "Move left",
  moveRight: "Move right",
  previousGroup: "Previous group",
  nextGroup: "Next group",
  play: "Play / select",
  details: "Details",
  filters: "Filters",
  back: "Back",
  toggleGrid: "Shelf / grid",
  favoriteTab: "Favorite group"
};

export const CONTROLLER_ACTION_HELP: Record<ControllerActionId, string> = {
  focusBigPicture: "Bring Hynite forward and enter Big Picture.",
  exitBigPicture: "Leave Big Picture.",
  moveUp: "Move selection up.",
  moveDown: "Move selection down or enter grid from shelf.",
  moveLeft: "Move selection left.",
  moveRight: "Move selection right.",
  previousGroup: "Move to the group on the left.",
  nextGroup: "Move to the group on the right.",
  play: "Launch the selected game when possible.",
  details: "Open details for the selected game.",
  filters: "Open Big Picture filters.",
  back: "Back, close open Big Picture panels, or return to shelf.",
  toggleGrid: "Switch between shelf and grid.",
  favoriteTab: "Set the current group as the default startup tab, or clear if already default."
};

const STANDARD_BUTTON_LABELS: Record<number, string> = {
  0: "A",
  1: "B",
  2: "X",
  3: "Y",
  4: "LB",
  5: "RB",
  6: "LT",
  7: "RT",
  8: "-",
  9: "+",
  10: "LS",
  11: "RS",
  12: "D-Up",
  13: "D-Down",
  14: "D-Left",
  15: "D-Right",
  16: "Home"
};

export function normalizeControllerSettings(settings: AppSettings | undefined): ControllerSettings {
  return {
    enabled: settings?.controller?.enabled !== false,
    backgroundInput: settings?.controller?.backgroundInput !== false,
    bindings: {
      ...DEFAULT_CONTROLLER_BINDINGS,
      ...(settings?.controller?.bindings ?? {})
    }
  };
}

export function bindingLabel(binding: ControllerButtonBinding | undefined): string {
  const buttons = binding?.buttons?.filter((button) => Number.isInteger(button) && button >= 0) ?? [];
  return buttons.length ? buttons.map((button) => STANDARD_BUTTON_LABELS[button] ?? `B${button}`).join(" ") : "Unbound";
}

export function pressedButtonIndexes(gamepads: readonly (Gamepad | null)[]): number[] {
  const pressed = new Set<number>();
  for (const gamepad of gamepads) {
    if (!gamepad) continue;
    gamepad.buttons.forEach((button, index) => {
      if (button.pressed || button.value >= 0.5) {
        pressed.add(index);
      }
    });
  }
  return [...pressed].sort((a, b) => a - b);
}

export function readGamepadState(): { pressed: Set<number>; axes: number[]; connected: boolean } {
  const pressed = new Set<number>();
  const axes: number[] = [];
  let connected = false;
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gamepad of gamepads) {
    if (!gamepad) continue;
    connected = true;
    for (let index = 0; index < gamepad.buttons.length; index++) {
      const button = gamepad.buttons[index]!;
      if (button.pressed || button.value >= 0.5) pressed.add(index);
    }
    axes.push(...gamepad.axes);
  }
  return { pressed, axes, connected };
}

export function bindingPressed(binding: ControllerButtonBinding | undefined, pressed: ReadonlySet<number>): boolean {
  const buttons = binding?.buttons ?? [];
  return buttons.length > 0 && buttons.every((button) => pressed.has(button));
}

export function firstPressedBinding(buttons: number[]): ControllerButtonBinding | undefined {
  return buttons.length ? { buttons } : undefined;
}

export const controllerBindingOrder = controllerActionIds;
