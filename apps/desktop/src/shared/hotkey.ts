type HotkeyInput = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  control?: boolean;
  altKey?: boolean;
  alt?: boolean;
  shiftKey?: boolean;
  shift?: boolean;
  metaKey?: boolean;
  meta?: boolean;
};

const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Ctrl",
  "Meta",
  "OS",
  "Shift",
  "Super"
]);

const ALLOWED_PUNCTUATION = new Set([
  ")",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ":",
  ";",
  "+",
  "=",
  "<",
  ",",
  "_",
  "-",
  ">",
  ".",
  "?",
  "/",
  "~",
  "`",
  "{",
  "]",
  "[",
  "|",
  "\\",
  "}",
  "\""
]);

const KEY_ALIASES = new Map<string, string>([
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["ArrowUp", "Up"],
  ["CapsLock", "Capslock"],
  ["Capslock", "Capslock"],
  ["Del", "Delete"],
  ["Esc", "Escape"],
  ["Escape", "Escape"],
  ["Ins", "Insert"],
  ["NumLock", "Numlock"],
  ["Numlock", "Numlock"],
  ["PageDown", "PageDown"],
  ["PageUp", "PageUp"],
  ["Return", "Return"],
  ["Enter", "Enter"],
  ["ScrollLock", "Scrolllock"],
  ["Scrolllock", "Scrolllock"],
  ["Spacebar", "Space"],
  ["Tab", "Tab"],
  ["Backspace", "Backspace"],
  ["Delete", "Delete"],
  ["Insert", "Insert"],
  ["Home", "Home"],
  ["End", "End"],
  ["AudioVolumeDown", "VolumeDown"],
  ["AudioVolumeMute", "VolumeMute"],
  ["AudioVolumeUp", "VolumeUp"],
  ["MediaNextTrack", "MediaNextTrack"],
  ["MediaPlayPause", "MediaPlayPause"],
  ["MediaPreviousTrack", "MediaPreviousTrack"],
  ["MediaStop", "MediaStop"],
  ["MediaTrackNext", "MediaNextTrack"],
  ["MediaTrackPrevious", "MediaPreviousTrack"],
  ["PrintScreen", "PrintScreen"],
  ["VolumeDown", "VolumeDown"],
  ["VolumeMute", "VolumeMute"],
  ["VolumeUp", "VolumeUp"],
  ["Down", "Down"],
  ["Left", "Left"],
  ["Right", "Right"],
  ["Up", "Up"],
  ["Plus", "Plus"],
  ["Space", "Space"],
  [" ", "Space"]
]);

const CODE_KEY_ALIASES = new Map<string, string>([
  ["Numpad0", "num0"],
  ["Numpad1", "num1"],
  ["Numpad2", "num2"],
  ["Numpad3", "num3"],
  ["Numpad4", "num4"],
  ["Numpad5", "num5"],
  ["Numpad6", "num6"],
  ["Numpad7", "num7"],
  ["Numpad8", "num8"],
  ["Numpad9", "num9"],
  ["NumpadAdd", "numadd"],
  ["NumpadDecimal", "numdec"],
  ["NumpadDivide", "numdiv"],
  ["NumpadMultiply", "nummult"],
  ["NumpadSubtract", "numsub"],
  ["Space", "Space"]
]);

const MODIFIER_ALIASES = new Map<string, string>([
  ["ALT", "Alt"],
  ["ALTGR", "AltGr"],
  ["CMD", "Command"],
  ["COMMAND", "Command"],
  ["COMMANDORCONTROL", "CommandOrControl"],
  ["CMDORCTRL", "CommandOrControl"],
  ["CONTROL", "Ctrl"],
  ["CTRL", "Ctrl"],
  ["META", "Super"],
  ["OPTION", "Alt"],
  ["SHIFT", "Shift"],
  ["SUPER", "Super"],
  ["WIN", "Super"],
  ["WINDOWS", "Super"]
]);

const MODIFIER_ORDER = ["CommandOrControl", "Command", "Ctrl", "Alt", "AltGr", "Shift", "Super"];

function canonicalKeyToken(value: string): string | undefined {
  const token = value.trim();
  if (!token) return undefined;
  const alias = KEY_ALIASES.get(token);
  if (alias) return alias;
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
  if (/^num(?:[0-9]|add|dec|div|mult|sub)$/i.test(token)) return token.toLowerCase();
  if (ALLOWED_PUNCTUATION.has(token)) return token === "+" ? "Plus" : token;
  return undefined;
}

export function acceleratorFromHotkeyInput(input: HotkeyInput): string | undefined {
  if (MODIFIER_KEYS.has(input.key) || input.key === "Dead" || input.key === "Unidentified") {
    return undefined;
  }
  const key = canonicalKeyToken(CODE_KEY_ALIASES.get(input.code ?? "") ?? input.key);
  if (!key) return undefined;
  const parts: string[] = [];
  if (input.ctrlKey ?? input.control) parts.push("Ctrl");
  if (input.altKey ?? input.alt) parts.push("Alt");
  if (input.shiftKey ?? input.shift) parts.push("Shift");
  if (input.metaKey ?? input.meta) parts.push("Super");
  parts.push(key);
  return parts.length > 1 ? parts.join("+") : undefined;
}

export function normalizeAcceleratorText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.trim().replace(/\s+/g, "");
  if (!compact || compact.length > 80 || !compact.includes("+")) return undefined;
  const tokens = compact.split("+");
  if (tokens.some((token) => token.length === 0)) return undefined;

  const modifiers = new Set<string>();
  let key: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) return undefined;
    const modifier = MODIFIER_ALIASES.get(token.toUpperCase());
    if (modifier && index < tokens.length - 1) {
      modifiers.add(modifier);
      continue;
    }
    if (key) return undefined;
    key = canonicalKeyToken(token);
    if (!key) return undefined;
  }
  if (!key || modifiers.size === 0 || modifiers.has(key)) return undefined;
  return [...modifiers].sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b)).concat(key).join("+");
}
