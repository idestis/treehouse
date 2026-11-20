// Screen switching and the little bit of state shared between screens.
import type { Me } from "./api/types";

/** Where to go once signed in: two-step setup first if the role needs it. */
export function afterSignIn(me: Me) {
  session.me = me;
  go(me.mfa_setup_needed ? { name: "mfasetup" } : { name: "home" });
}

export type Screen =
  | { name: "find" }
  | { name: "signin" }
  | { name: "twostep"; mfa_token: string }
  | { name: "join"; code?: string }
  | { name: "mfasetup"; back?: Screen }
  | { name: "home" }
  | { name: "settings"; tab?: SettingsTab };

export type SettingsTab = "profile" | "sound" | "security" | "invites" | "computer";

export const session: { server: { address: string; name: string } | null; me: Me | null } = {
  server: null,
  me: null,
};

type Render = (root: HTMLElement, screen: Screen) => (() => void) | void;
const screens = new Map<Screen["name"], Render>();
let cleanup: (() => void) | void;
let root: HTMLElement;

export function register(name: Screen["name"], render: Render) {
  screens.set(name, render);
}

export function start(el: HTMLElement, first: Screen) {
  root = el;
  go(first);
}

export function go(screen: Screen) {
  cleanup?.();
  cleanup = undefined;
  root.replaceChildren();
  root.className = `screen screen-${screen.name}`;
  cleanup = screens.get(screen.name)?.(root, screen);
  root.querySelector<HTMLElement>("[autofocus]")?.focus();
}
