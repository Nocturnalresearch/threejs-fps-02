// input.js — keyboard + mouse, owned by one module. The main loop polls
// this every frame; nothing else touches the DOM listeners.
//
// The wiring rule: attach() registers the real listeners, and the handlers
// it registers are the ones that run. Keydown handling (B/R/G/Q/1-4),
// mouse look and the Space jump queue all live here, so a handler that is
// assigned but never called cannot happen again.

export function createInput() {
  const input = {
    keys: new Set(), // currently held codes
    pressed: new Set(), // edge-triggered codes, consumed once per frame
    lookDX: 0, // accumulated mouse-look deltas, consumed by the loop
    lookDY: 0,
    jumpQueued: false,
    firing: false, // left mouse held
    scoping: false, // right mouse held
    locked: false,
    attached: false,
    _el: null,

    attach(el) {
      if (this.attached || typeof window === 'undefined' || !el) return;
      this.attached = true;
      this._el = el;
      el.addEventListener('click', this._onClick);
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      document.addEventListener('mousemove', this._onMouseMove);
      document.addEventListener('mousedown', this._onMouseDown);
      document.addEventListener('mouseup', this._onMouseUp);
      document.addEventListener('pointerlockchange', this._onLockChange);
      document.addEventListener('contextmenu', this._onContextMenu);
    },

    detach() {
      if (!this.attached || typeof window === 'undefined') return;
      this.attached = false;
      const el = this._el;
      if (el) el.removeEventListener('click', this._onClick);
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      document.removeEventListener('mousemove', this._onMouseMove);
      document.removeEventListener('mousedown', this._onMouseDown);
      document.removeEventListener('mouseup', this._onMouseUp);
      document.removeEventListener('pointerlockchange', this._onLockChange);
      document.removeEventListener('contextmenu', this._onContextMenu);
    },

    // The loop consumes the look queue every frame — mouse look is applied
    // from here and nowhere else.
    consumeLook() {
      const dx = this.lookDX;
      const dy = this.lookDY;
      this.lookDX = 0;
      this.lookDY = 0;
      return { dx, dy };
    },

    consumeJump() {
      const j = this.jumpQueued;
      this.jumpQueued = false;
      return j;
    },

    // One-shot key presses: main polls these once per frame.
    consumePressed(code) {
      if (!this.pressed.has(code)) return false;
      this.pressed.delete(code);
      return true;
    },

    endFrame() {
      this.pressed.clear();
    },

    lock() {
      if (this._el && this._el.requestPointerLock) {
        this._el.requestPointerLock();
      }
    },

    unlock() {
      if (typeof document !== 'undefined' && document.exitPointerLock) {
        document.exitPointerLock();
      }
    },

    _onClick: () => {
      input.lock();
    },

    _onKeyDown: (e) => {
      // This handler IS registered by attach() — see the module header.
      if (e.repeat) return;
      input.keys.add(e.code);
      input.pressed.add(e.code);
      if (e.code === 'Space') {
        input.jumpQueued = true;
        e.preventDefault();
      }
    },

    _onKeyUp: (e) => {
      input.keys.delete(e.code);
    },

    _onBlur: () => {
      input.keys.clear();
      input.firing = false;
      input.scoping = false;
    },

    _onMouseMove: (e) => {
      if (!input.locked) return;
      input.lookDX += e.movementX || 0;
      input.lookDY += e.movementY || 0;
    },

    _onMouseDown: (e) => {
      if (!input.locked) return;
      if (e.button === 0) input.firing = true;
      if (e.button === 2) input.scoping = true;
    },

    _onMouseUp: (e) => {
      if (e.button === 0) input.firing = false;
      if (e.button === 2) input.scoping = false;
    },

    _onLockChange: () => {
      input.locked =
        typeof document !== 'undefined' &&
        document.pointerLockElement === input._el;
      if (!input.locked) {
        input.firing = false;
        input.scoping = false;
      }
    },

    _onContextMenu: (e) => {
      e.preventDefault();
    },
  };
  return input;
}
