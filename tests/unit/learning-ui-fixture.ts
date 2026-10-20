/** Small DOM/event doubles for local feedback tests; no browser or native application. */
export class LearningElement {
  id = ''; className = ''; text = ''; type = ''; value = ''; title = ''; hidden = false; disabled = false; open = false; checked = false;
  maxLength = 0; autocomplete = ''; placeholder = ''; dataset: Record<string, string> = {};
  children: LearningElement[] = []; parentNode: LearningElement | null = null; isConnected = true;
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();
  readonly classList = { add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); } };
  constructor(readonly tagName: string, readonly ownerDocument: LearningDocument) {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get childElementCount(): number { return this.children.length; }
  append(...children: LearningElement[]): void { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children: LearningElement[]): void { this.text = ''; this.children = []; this.append(...children); }
  after(next: LearningElement): void { const parent = this.parentNode; if (parent) { next.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, next); } }
  remove(): void { const parent = this.parentNode; if (parent) parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  focus(): void {}
  compareDocumentPosition(): number { return 4; }
  all(): LearningElement[] { return this.children.flatMap(child => [child, ...child.all()]); }
  matches(selector: string): boolean {
    const match = /^(\w+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=([^\]]+))?\])?$/.exec(selector);
    return !!match && (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.className.split(' ').includes(match[2])) &&
      (!match[3] || this.attributes.has(match[3]) && (match[4] === undefined || this.attributes.get(match[3]) === match[4]));
  }
  querySelectorAll(selector: string): LearningElement[] { return this.all().filter(child => child.matches(selector)); }
  querySelector(selector: string): LearningElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): LearningElement | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
  addEventListener(type: string, listener: (event: Event) => void): void { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  removeEventListener(type: string, listener: (event: Event) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
  dispatchEvent(event: Event): boolean { for (const listener of this.listeners.get(event.type) ?? []) listener(event); return !event.defaultPrevented; }
  trustedClick(): void {
    const click = { type: 'click', isTrusted: true, defaultPrevented: false, button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false } as unknown as Event;
    this.dispatchEvent(click);
  }
}
export class LearningDocument extends EventTarget {
  readonly root = new LearningElement('MAIN', this);
  readonly defaultView: { location: { origin: string }; CustomEvent: typeof CustomEvent };
  hidden = false;
  constructor(origin = 'http://127.0.0.1:32123') { super(); this.defaultView = { location: { origin }, CustomEvent }; }
  createElement(tag: string): LearningElement { return new LearningElement(tag.toUpperCase(), this); }
  createElementNS(_namespace: string, tag: string): LearningElement { return this.createElement(tag); }
  getElementById(id: string): LearningElement | null { return this.root.all().find(node => node.id === id) ?? null; }
  querySelectorAll(selector: string): LearningElement[] { return this.root.querySelectorAll(selector); }
  asDocument(): Document { return this as unknown as Document; }
}
export const learningTick = () => new Promise<void>(resolve => setImmediate(resolve));
