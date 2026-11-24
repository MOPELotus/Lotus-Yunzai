let active = false;
let coordinate: ((write: () => unknown) => unknown) | undefined;
export function interactiveTerminalInputActive() { return active; }
export function setInteractiveTerminalInputActive(value: boolean, writer?: (write: () => unknown) => unknown) {
  active = value;
  coordinate = value ? writer : undefined;
}
export function withTerminalOutput<T>(write: () => T): T { return (coordinate ? coordinate(write) : write()) as T; }
