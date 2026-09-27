/**
 * Contextual hints shown over the HUD.
 *
 * Each tip is keyed, and `set` is called every frame with either its text or
 * null — so a tip appears exactly while its situation applies and disappears on
 * its own once handled. Keeping the state here rather than in the caller means
 * a tip never gets re-created each frame, which would restart its fade.
 */
export class Tips {
  private readonly root: HTMLDivElement;
  private readonly shown = new Map<string, HTMLDivElement>();

  /**
   * @param onHide Called by the close mark on a tip. The same setting lives in
   *   the Controls panel, but reaching for a panel to dismiss a hint is a worse
   *   deal than reading the hint you did not want.
   */
  constructor(private readonly onHide: () => void) {
    this.root = document.createElement('div');
    this.root.id = 'tips';
    document.body.appendChild(this.root);
  }

  /** Show `text` for `id`, or pass null to retire that tip. */
  set(id: string, text: string | null): void {
    const existing = this.shown.get(id);

    if (text === null) {
      if (existing) {
        existing.classList.remove('visible');
        // Let the fade finish before removing it from the document.
        const el = existing;
        window.setTimeout(() => el.remove(), 400);
        this.shown.delete(id);
      }
      return;
    }

    if (existing) {
      const label = existing.firstElementChild;
      if (label !== null && label.textContent !== text) label.textContent = text;
      return;
    }

    const el = document.createElement('div');
    el.className = 'tip';
    const label = document.createElement('span');
    label.textContent = text;
    // The close mark rides on the tip itself, in its corner, rather than
    // sitting under the stack as a second thing to look at.
    const close = document.createElement('button');
    close.className = 'tip-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Stop showing tips (the Controls tab brings them back)';
    close.setAttribute('aria-label', 'Stop showing tips');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      close.blur();
      this.onHide();
    });
    el.append(label, close);
    this.root.appendChild(el);
    this.shown.set(id, el);
    // Next frame, so the browser has a pre-transition state to animate from.
    requestAnimationFrame(() => el.classList.add('visible'));
  }

  clear(): void {
    for (const id of [...this.shown.keys()]) this.set(id, null);
  }
}
