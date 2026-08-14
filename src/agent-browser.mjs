import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const TAB_CAPABILITIES = [
  { id: "cdp", description: "Raw Chrome DevTools Protocol commands" }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modifierBits(keys = []) {
  return keys.reduce((bits, item) => bits | ({
    Alt: 1,
    Control: 2,
    ControlOrMeta: process.platform === "darwin" ? 4 : 2,
    Meta: 4,
    Shift: 8
  }[item] || 0), 0);
}

function functionSource(value) {
  if (typeof value === "string") return value;
  if (typeof value === "function") return `(${value.toString()})`;
  throw new TypeError("Expected a JavaScript function or expression string");
}

function serializeMatcher(value) {
  if (value instanceof RegExp) return { kind: "regexp", source: value.source, flags: value.flags };
  return { kind: "string", value: String(value) };
}

function navigationUrlMatches(actual, expected) {
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    if (actualUrl.origin !== expectedUrl.origin || actualUrl.pathname !== expectedUrl.pathname) {
      return false;
    }
    // Chrome and SPA routers may preserve or append view-state query parameters
    // (filters, sort order, experiment flags) after committing the requested
    // route. Treat the requested query as a contract subset instead of requiring
    // byte-for-byte equality, while still rejecting a conflicting requested
    // value.
    for (const [key, value] of expectedUrl.searchParams) {
      if (!actualUrl.searchParams.getAll(key).includes(value)) return false;
    }
    return true;
  } catch {
    return String(actual || "") === String(expected || "");
  }
}

function resolverSource(descriptor) {
  return `(() => {
    const descriptor = ${JSON.stringify(descriptor)};
    const textMatches = (value, matcher, exact=false) => {
      const text = String(value || "").replace(/\\s+/g, " ").trim();
      if (!matcher) return true;
      if (matcher.kind === "regexp") return new RegExp(matcher.source, matcher.flags).test(text);
      return exact ? text === matcher.value : text.includes(matcher.value);
    };
    const visible = (el) => {
      if (!el || el.nodeType !== 1) return false;
      if (typeof el.checkVisibility === "function" && !el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true
      })) return false;
      let current = el;
      while (current) {
        const style = current.ownerDocument.defaultView.getComputedStyle(current);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity || 1) === 0) return false;
        if (current.hidden || current.getAttribute?.("aria-hidden") === "true") return false;
        const root = current.getRootNode?.();
        current = current.parentElement || (root && root.host) || null;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const roleOf = (el) => el.getAttribute("role") || ({
      A:"link",BUTTON:"button",SELECT:"combobox",TEXTAREA:"textbox",
      IMG:"img",TABLE:"table",TR:"row",TD:"cell",TH:"columnheader"
    }[el.tagName] || (el.tagName === "INPUT" ? ({
      button:"button",submit:"button",checkbox:"checkbox",radio:"radio",
      search:"searchbox",email:"textbox",text:"textbox",password:"textbox"
    }[el.type] || "textbox") : ""));
    const nameOf = (el) => el.getAttribute("aria-label") || el.getAttribute("title") ||
      (el.labels ? [...el.labels].map(x => x.innerText).join(" ") : "") ||
      el.alt || el.innerText || el.textContent || "";
    const resolve = (input) => {
    if (input.combinator) {
      const left = resolve(input.left);
      const right = resolve(input.right);
      let combined = input.combinator === "and"
        ? left.filter((element) => right.includes(element))
        : [...new Set([...left, ...right])];
      const filter = input.postFilter;
      if (filter?.hasText) combined = combined.filter(el => textMatches(el.innerText || el.textContent, filter.hasText));
      if (filter?.hasNotText) combined = combined.filter(el => !textMatches(el.innerText || el.textContent, filter.hasNotText));
      if (filter?.visible !== undefined) combined = combined.filter(el => visible(el) === filter.visible);
      if (filter?.has) {
        const descendants = resolve(filter.has);
        combined = combined.filter((el) => descendants.some((candidate) => el.contains(candidate)));
      }
      if (filter?.hasNot) {
        const descendants = resolve(filter.hasNot);
        combined = combined.filter((el) => !descendants.some((candidate) => el.contains(candidate)));
      }
      if (Number.isInteger(input.postNth)) {
        const index = input.postNth < 0 ? combined.length + input.postNth : input.postNth;
        combined = combined[index] ? [combined[index]] : [];
      }
      return combined;
    }
    let current = input.base ? resolve(input.base) : [document];
    for (const step of input.steps) {
      let next = [];
      for (const root of current) {
        const queryRoot = root && typeof root.querySelectorAll === "function" ? root : document;
        if (step.type === "frame") {
          let frames = [];
          try { frames = [...queryRoot.querySelectorAll(step.selector)]; } catch { frames = []; }
          next.push(...frames.map((frame) => frame.contentDocument).filter(Boolean));
        } else if (step.type === "css") {
          let selector = step.selector;
          let exactText = null;
          const special = selector.match(/:text-is\\((['"])(.*?)\\1\\)$/);
          if (special) { exactText = special[2]; selector = selector.slice(0, special.index) || "*"; }
          try { next.push(...queryRoot.querySelectorAll(selector)); } catch { next = []; }
          if (exactText !== null) next = next.filter(el => textMatches(el.innerText || el.textContent, {kind:"string",value:exactText}, true));
        } else if (step.type === "text") {
          next.push(...queryRoot.querySelectorAll("*"));
          next = next.filter(el => textMatches(el.innerText || el.textContent, step.matcher, step.exact));
        } else if (step.type === "role") {
          next.push(...queryRoot.querySelectorAll("*"));
          next = next.filter(el => roleOf(el) === step.role && textMatches(nameOf(el), step.name, step.exact));
        } else if (step.type === "label") {
          next.push(...queryRoot.querySelectorAll("input,textarea,select,button,[aria-label]"));
          next = next.filter(el => textMatches(nameOf(el), step.matcher, step.exact));
        } else if (step.type === "placeholder") {
          next.push(...queryRoot.querySelectorAll("[placeholder]"));
          next = next.filter(el => textMatches(el.getAttribute("placeholder"), step.matcher, step.exact));
        } else if (step.type === "testId") {
          next.push(...queryRoot.querySelectorAll('[data-testid="'+CSS.escape(step.value)+'"]'));
        }
      }
      current = [...new Set(next)];
      if (step.filter) {
        if (step.filter.hasText) current = current.filter(el => textMatches(el.innerText || el.textContent, step.filter.hasText));
        if (step.filter.hasNotText) current = current.filter(el => !textMatches(el.innerText || el.textContent, step.filter.hasNotText));
        if (step.filter.visible !== undefined) current = current.filter(el => visible(el) === step.filter.visible);
        if (step.filter.has) {
          const descendants = resolve(step.filter.has);
          current = current.filter((el) => descendants.some((candidate) => el.contains(candidate)));
        }
        if (step.filter.hasNot) {
          const descendants = resolve(step.filter.hasNot);
          current = current.filter((el) => !descendants.some((candidate) => el.contains(candidate)));
        }
      }
      if (Number.isInteger(step.nth)) current = current[step.nth < 0 ? current.length + step.nth : step.nth] ? [current[step.nth < 0 ? current.length + step.nth : step.nth]] : [];
    }
    return current.filter((entry) => entry?.nodeType === 1);
    };
    return resolve(descriptor);
  })()`;
}

export class ChromeTransport {
  constructor(router, profileName) {
    this.router = router;
    this.profileName = profileName;
  }
  request(method, params) {
    return this.router.request(this.profileName, method, params);
  }
  cdp(tabId, cdpMethod, cdpParams = {}) {
    return this.request("cdp.send", { tabId, cdpMethod, cdpParams });
  }
  session(tabId, action, options = {}) {
    return this.request("puppeteer.session", { tabId, action, options });
  }
  async evaluate(tabId, expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.cdp(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }
}


async function removeTabWithRetry(transport, tabId, { attempts = 3, delayMs = 750 } = {}) {
  // chrome.tabs.remove on the extension can exceed its API timeout when Chrome
  // is busy (observed live: heavy TikTok Studio tabs), so the adapter must not
  // treat one failed remove as done. Retry with a bounded backoff and verify
  // via tabs.list that the tab is actually gone before reporting success.
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await transport.request("tabs.remove", { tabId });
    } catch (error) {
      lastError = error?.message || String(error || "tabs.remove failed");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    // Give Chrome a moment to finish tearing the tab down, then verify.
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const open = await transport.request("tabs.list", {});
      const stillOpen = (open || []).some((info) => String(info.id) === String(tabId));
      if (!stillOpen) return { closed: true, attempts: attempt };
    } catch (error) {
      lastError = error?.message || String(error || "tabs.list failed during close verification");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { closed: false, attempts, lastError };
}


class CapabilityCollection {
  constructor(entries, factory) {
    this.entries = entries;
    this.factory = factory;
  }
  async list() { return this.entries; }
  async get(id) {
    if (!this.entries.some((entry) => entry.id === id)) throw new Error(`Unsupported capability: ${id}`);
    return this.factory(id);
  }
}

export class BrowserDocumentationStore {
  constructor(browser) {
    this.browser = browser;
  }
  async api() {
    return "Codex Chrome browser API compatibility baseline 26.721.41059 (22 interfaces, 135 members, 58 types).";
  }
  async get(name) {
    return this.browser.agentDocumentation.get(name);
  }
  async guidance() {
    return {
      exactProfile: this.browser.profile.profileName,
      finalize: "Call markHandoff or markDeliverable before tabs.finalize to preserve a tab.",
      boundary: "No debug profile, copied user-data directory, remote-debugging port, or alternate browser."
    };
  }
  lookupCatalog() {
    return "api\nguidance";
  }
}

export class Locator {
  constructor(tab, descriptor) {
    this.tab = tab;
    this.descriptor = descriptor;
  }
  extend(step) {
    return this.descriptor.steps
      ? new Locator(this.tab, { steps: [...this.descriptor.steps, step] })
      : new Locator(this.tab, { base: this.descriptor, steps: [step] });
  }
  locator(selector, options = {}) {
    const locator = this.extend({ type: "css", selector });
    return Object.keys(options).length ? locator.filter(options) : locator;
  }
  getByText(text, options = {}) { return this.extend({ type: "text", matcher: serializeMatcher(text), exact: !!options.exact }); }
  getByRole(role, options = {}) { return this.extend({ type: "role", role, name: options.name == null ? null : serializeMatcher(options.name), exact: !!options.exact }); }
  getByLabel(text, options = {}) { return this.extend({ type: "label", matcher: serializeMatcher(text), exact: !!options.exact }); }
  getByPlaceholder(text, options = {}) { return this.extend({ type: "placeholder", matcher: serializeMatcher(text), exact: !!options.exact }); }
  getByTestId(value) { return this.extend({ type: "testId", value }); }
  filter(options = {}) {
    const filter = {
      hasText: options.hasText == null ? undefined : serializeMatcher(options.hasText),
      hasNotText: options.hasNotText == null ? undefined : serializeMatcher(options.hasNotText),
      visible: options.visible,
      has: options.has instanceof Locator ? options.has.descriptor : undefined,
      hasNot: options.hasNot instanceof Locator ? options.hasNot.descriptor : undefined
    };
    if (this.descriptor.combinator) {
      return new Locator(this.tab, { ...this.descriptor, postFilter: filter });
    }
    const steps = structuredClone(this.descriptor.steps);
    const last = steps.at(-1);
    if (!last) throw new Error("Cannot filter an empty locator");
    last.filter = filter;
    return new Locator(this.tab, { steps });
  }
  nth(index) {
    if (this.descriptor.combinator) {
      return new Locator(this.tab, { ...this.descriptor, postNth: index });
    }
    const steps = structuredClone(this.descriptor.steps);
    steps.at(-1).nth = index;
    return new Locator(this.tab, { steps });
  }
  first() { return this.nth(0); }
  last() { return this.nth(-1); }
  async all() { return Array.from({ length: await this.count() }, (_, index) => this.nth(index)); }
  and(locator) {
    this.assertCompatible(locator);
    return new Locator(this.tab, { combinator: "and", left: this.descriptor, right: locator.descriptor });
  }
  or(locator) {
    this.assertCompatible(locator);
    return new Locator(this.tab, { combinator: "or", left: this.descriptor, right: locator.descriptor });
  }
  assertCompatible(locator) {
    if (!(locator instanceof Locator) || locator.tab !== this.tab) {
      throw new TypeError("Locator combinations require locators from the same tab");
    }
  }
  async query(operation, arg) {
    const elements = resolverSource(this.descriptor);
    return this.tab.transport.evaluate(this.tab.id, `(() => {
      const elements = ${elements};
      const el = elements[0];
      return (${operation})(el, elements, ${JSON.stringify(arg)});
    })()`);
  }
  count() { return this.query("(_el, elements) => elements.length"); }
  isVisible() { return this.query(`(el) => {
    if (!el) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true
    })) return false;
    let current = el;
    while (current) {
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity || 1) === 0) return false;
      if (current.hidden || current.getAttribute?.("aria-hidden") === "true") return false;
      const root = current.getRootNode?.();
      current = current.parentElement || (root && root.host) || null;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }`); }
  isEnabled() { return this.query("(el) => !!el && !el.disabled && el.getAttribute('aria-disabled')!=='true'"); }
  async innerText({ timeoutMs = 30000 } = {}) { await this.waitFor({ state: "attached", timeoutMs }); return this.query("(el) => el ? el.innerText : ''"); }
  async textContent({ timeoutMs = 30000 } = {}) { await this.waitFor({ state: "attached", timeoutMs }); return this.query("(el) => el ? el.textContent : null"); }
  async allTextContents({ timeoutMs = 30000 } = {}) { await this.waitFor({ state: "attached", timeoutMs }); return this.query("(_el, elements) => elements.map(x => x.textContent || '')"); }
  async getAttribute(name, { timeoutMs = 30000 } = {}) { await this.waitFor({ state: "attached", timeoutMs }); return this.query("(el,_elements,name) => el ? el.getAttribute(name) : null", name); }
  async evaluate(pageFunction, arg, { timeoutMs = 30000 } = {}) {
    await this.waitFor({ state: "attached", timeoutMs });
    const source = functionSource(pageFunction);
    return this.query(`(el,elements,arg) => {
      if (elements.length !== 1) throw new Error("Locator evaluate requires exactly one matching element; found " + elements.length);
      return (${source})(el,arg);
    }`, arg);
  }
  async boundingBox() {
    return this.query(`(el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      let x = r.x, y = r.y, view = el.ownerDocument.defaultView;
      while (view?.frameElement) {
        const frame = view.frameElement.getBoundingClientRect();
        x += frame.x;
        y += frame.y;
        view = view.parent;
      }
      return { x: x + r.width / 2, y: y + r.height / 2, width: r.width, height: r.height };
    }`);
  }
  async click(options = {}) {
    if (typeof this.tab.ensurePageVisible === "function") await this.tab.ensurePageVisible();
    if (!options.force) {
      await this.waitFor({ state: "visible", timeoutMs: options.timeoutMs ?? 30000 });
    }
    const box = await this.query(`(el) => {
      if (!el) return null;
      el.scrollIntoView({block:"center",inline:"center"});
      for (let pass = 0; pass < 2; pass += 1) {
        let ancestor = el.parentElement;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          const elementRect = el.getBoundingClientRect();
          const ancestorRect = ancestor.getBoundingClientRect();
          const clipsY = /(auto|scroll|overlay|hidden)/.test(style.overflowY);
          const clipsX = /(auto|scroll|overlay|hidden)/.test(style.overflowX);
          if (clipsY && ancestor.scrollHeight > ancestor.clientHeight) {
            const top = Math.max(ancestorRect.top, 0);
            const bottom = Math.min(ancestorRect.bottom, innerHeight);
            if (elementRect.top < top || elementRect.bottom > bottom) {
              ancestor.scrollTop += (elementRect.top + elementRect.height / 2) - (top + bottom) / 2;
            }
          }
          if (clipsX && ancestor.scrollWidth > ancestor.clientWidth) {
            const left = Math.max(ancestorRect.left, 0);
            const right = Math.min(ancestorRect.right, innerWidth);
            if (elementRect.left < left || elementRect.right > right) {
              ancestor.scrollLeft += (elementRect.left + elementRect.width / 2) - (left + right) / 2;
            }
          }
          ancestor = ancestor.parentElement;
        }
      }
      const r = el.getBoundingClientRect();
      let x = r.x, y = r.y, view = el.ownerDocument.defaultView;
      while (view?.frameElement) {
        const frame = view.frameElement.getBoundingClientRect();
        x += frame.x;
        y += frame.y;
        view = view.parent;
      }
      const localX = r.x + r.width / 2;
      const localY = r.y + r.height / 2;
      const hit = el.ownerDocument.elementFromPoint(localX, localY);
      const isComposedDescendant = (candidate, ancestor) => {
        let current = candidate;
        const visited = new Set();
        while (current && !visited.has(current)) {
          if (current === ancestor) return true;
          visited.add(current);
          if (current.parentNode) {
            current = current.parentNode;
            continue;
          }
          const root = current.getRootNode?.();
          current = root?.host || null;
        }
        return false;
      };
      const hitTest = !!hit && (hit === el || el.contains(hit) || isComposedDescendant(hit, el));
      return {
        x: x + r.width / 2,
        y: y + r.height / 2,
        width: r.width,
        height: r.height,
        hitTest,
        interceptedBy: hitTest || !hit ? null : {
          tag: hit.tagName?.toLowerCase() || "",
          id: hit.id || "",
          role: hit.getAttribute?.("role") || ""
        }
      };
    }`);
    if (!box) throw new Error("Locator did not resolve to an element");
    if (!options.force && box.hitTest === false) {
      const target = box.interceptedBy || {};
      const label = [target.tag, target.id && `#${target.id}`, target.role && `[role=${target.role}]`].filter(Boolean).join("");
      throw new Error(`Locator click intercepted by ${label || "another element"}`);
    }
    const button = { left: "left", middle: "middle", right: "right" }[options.button || "left"];
    const modifiers = modifierBits(options.modifiers || []);
    await this.tab.transport.cdp(this.tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button, modifiers, clickCount: 1 });
    await this.tab.transport.cdp(this.tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button, modifiers, clickCount: 1 });
  }
  async dblclick(options = {}) {
    if (typeof this.tab.ensurePageVisible === "function") await this.tab.ensurePageVisible();
    if (!options.force) await this.waitFor({ state: "visible", timeoutMs: options.timeoutMs ?? 30000 });
    const box = await this.query(`(el) => {
      if (!el) return null;
      el.scrollIntoView({block:"center",inline:"center"});
      const r = el.getBoundingClientRect();
      let x = r.x, y = r.y, view = el.ownerDocument.defaultView;
      while (view?.frameElement) {
        const frame = view.frameElement.getBoundingClientRect();
        x += frame.x;
        y += frame.y;
        view = view.parent;
      }
      return { x: x + r.width / 2, y: y + r.height / 2, width: r.width, height: r.height };
    }`);
    if (!box) throw new Error("Locator did not resolve to an element");
    const button = options.button || "left";
    const modifiers = modifierBits(options.modifiers || []);
    await this.tab.transport.cdp(this.tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button, modifiers, clickCount: 2 });
    await this.tab.transport.cdp(this.tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button, modifiers, clickCount: 2 });
  }
  async focusResolvedElement() {
    const focused = await this.query(`(el) => {
      if (!el || typeof el.focus !== "function") return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      for (let pass = 0; pass < 2; pass += 1) {
        let ancestor = el.parentElement;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          const elementRect = el.getBoundingClientRect();
          const ancestorRect = ancestor.getBoundingClientRect();
          const clipsY = /(auto|scroll|overlay|hidden)/.test(style.overflowY);
          const clipsX = /(auto|scroll|overlay|hidden)/.test(style.overflowX);
          if (clipsY && ancestor.scrollHeight > ancestor.clientHeight) {
            const top = Math.max(ancestorRect.top, 0);
            const bottom = Math.min(ancestorRect.bottom, innerHeight);
            if (elementRect.top < top || elementRect.bottom > bottom) {
              ancestor.scrollTop += (elementRect.top + elementRect.height / 2) - (top + bottom) / 2;
            }
          }
          if (clipsX && ancestor.scrollWidth > ancestor.clientWidth) {
            const left = Math.max(ancestorRect.left, 0);
            const right = Math.min(ancestorRect.right, innerWidth);
            if (elementRect.left < left || elementRect.right > right) {
              ancestor.scrollLeft += (elementRect.left + elementRect.width / 2) - (left + right) / 2;
            }
          }
          ancestor = ancestor.parentElement;
        }
      }
      el.focus({ preventScroll: true });
      const active = el.ownerDocument.activeElement;
      const body = el.ownerDocument.body;
      const root = el.ownerDocument.documentElement;
      return active === el
        || el.contains(active)
        || (active && active !== body && active !== root && active.contains(el));
    }`);
    if (!focused) throw new Error("Locator target could not receive focus");
  }
  async editableValue() {
    return this.query(`(el) => {
      if (!el) return { editable: false, value: null };
      if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
        return { editable: true, kind: "contenteditable", value: el.innerText ?? el.textContent ?? "" };
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return { editable: true, kind: el.tagName.toLowerCase(), value: el.value };
      }
      return { editable: false, kind: el.tagName.toLowerCase(), value: null };
    }`);
  }
  async fill(value, options = {}) {
    if (typeof this.tab.ensurePageVisible === "function") await this.tab.ensurePageVisible();
    if (!options.force) await this.waitFor({ state: "visible", timeoutMs: options.timeoutMs ?? 30000 });
    // Click the element first to ensure cursor lands in the correct nested editable
    try { await this.click({ force: true }); } catch (_) { /* fall through to focus */ }
    await this.focusResolvedElement();
    const editable = await this.editableValue();
    if (!editable.editable) throw new Error(`Locator fill target is not editable (${editable.kind || "unknown"})`);
    await this.dispatchKey("ControlOrMeta+A");
    await this.dispatchKey("Backspace");
    // Small delay to let framework process deletion before insertion
    await new Promise((r) => setTimeout(r, 120));
    await this.tab.transport.cdp(this.tab.id, "Input.insertText", { text: value });
    await new Promise((r) => setTimeout(r, 200));
    let after = await this.editableValue();
    // Relaxed postcondition for contenteditable: trim and check includes
    const normalize = (s) => (s || "").replace(/\u200b/g, "").trim();
    if (normalize(after.value) !== normalize(value) && !normalize(after.value).includes(normalize(value))) {
      // Fallback: clipboard paste via CDP
      await this.dispatchKey("ControlOrMeta+A");
      await this.dispatchKey("Backspace");
      await new Promise((r) => setTimeout(r, 100));
      await this.tab.transport.cdp(this.tab.id, "Runtime.evaluate", {
        expression: `(async () => {
          const el = document.activeElement;
          if (!el) return 'no_active';
          const dt = new DataTransfer();
          dt.setData('text/plain', ${JSON.stringify(value)});
          const pe = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          el.dispatchEvent(pe);
          return 'paste_dispatched';
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      await new Promise((r) => setTimeout(r, 300));
      after = await this.editableValue();
      if (normalize(after.value) !== normalize(value) && !normalize(after.value).includes(normalize(value))) {
        // Final fallback: execCommand insertText
        await this.dispatchKey("ControlOrMeta+A");
        await this.dispatchKey("Backspace");
        await new Promise((r) => setTimeout(r, 100));
        await this.tab.transport.cdp(this.tab.id, "Runtime.evaluate", {
          expression: `document.execCommand('insertText', false, ${JSON.stringify(value)})`,
          returnByValue: true,
        });
        await new Promise((r) => setTimeout(r, 300));
        after = await this.editableValue();
        if (normalize(after.value) !== normalize(value) && !normalize(after.value).includes(normalize(value))) {
          throw new Error(`Locator fill postcondition failed for ${after.kind}: expected ${JSON.stringify(value)}, received ${JSON.stringify(after.value)}`);
        }
      }
    }
  }
  async type(value, options = {}) {
    if (typeof this.tab.ensurePageVisible === "function") await this.tab.ensurePageVisible();
    if (!options.force) await this.waitFor({ state: "visible", timeoutMs: options.timeoutMs ?? 30000 });
    await this.focusResolvedElement();
    const before = await this.editableValue();
    if (!before.editable) throw new Error(`Locator type target is not editable (${before.kind || "unknown"})`);
    await this.tab.transport.cdp(this.tab.id, "Input.insertText", { text: value });
    const after = await this.editableValue();
    if (value && (after.value === before.value || !String(after.value).includes(String(value)))) {
      throw new Error(`Locator type postcondition failed for ${after.kind}: inserted text was not observed`);
    }
  }
  async dispatchKey(value) {
    const parts = value.split("+");
    const key = parts.at(-1);
    const modifiers = parts.slice(0, -1).reduce((bits, item) => bits | ({ Alt: 1, Control: 2, ControlOrMeta: 2, Meta: 4, Shift: 8 }[item] || 0), 0);
    const named = {
      Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
      Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
      Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
      Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
      ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
      ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
      ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
      ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
      Delete: { code: "Delete", windowsVirtualKeyCode: 46 }
    };
    const keyInfo = named[key] || (
      key.length === 1
        ? { code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) }
        : { code: key }
    );
    const params = {
      key,
      modifiers,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
      nativeVirtualKeyCode: keyInfo.windowsVirtualKeyCode
    };
    await this.tab.transport.cdp(this.tab.id, "Input.dispatchKeyEvent", { type: "keyDown", ...params });
    await this.tab.transport.cdp(this.tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
  }
  async press(value, options = {}) {
    if (typeof this.tab.ensurePageVisible === "function") await this.tab.ensurePageVisible();
    await this.waitFor({ state: "visible", timeoutMs: options.timeoutMs ?? 30000 });
    await this.focusResolvedElement();
    await this.dispatchKey(value);
  }
  async check(options = {}) { return this.setChecked(true, options); }
  async uncheck(options = {}) { return this.setChecked(false, options); }
  async setChecked(checked, options = {}) {
    await this.waitFor({ state: "visible", timeoutMs: options.timeoutMs ?? 30000 });
    if (Boolean(await this.query("(el) => !!el?.checked")) !== checked) await this.click(options);
  }
  async selectOption(value, options = {}) {
    await this.waitFor({ state: "visible", timeoutMs: options.timeoutMs ?? 30000 });
    const values = (Array.isArray(value) ? value : [value]).map((item) => typeof item === "string" ? { value: item } : item);
    await this.query(`(el,_elements,values) => {
      for (const option of el.options) option.selected = values.some(v => v.value === option.value || v.label === option.label || v.index === option.index);
      el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true}));
      return [...el.selectedOptions].map(x => x.value);
    }`, values);
  }
  async downloadMedia({ timeoutMs = 30000 } = {}) {
    const box = await this.boundingBox();
    if (!box) throw new Error("Locator did not resolve to downloadable media");
    return this.tab.cua.downloadMedia({ x: box.x, y: box.y, timeoutMs });
  }
  async waitFor({ state, timeoutMs = 30000 }) {
    if (typeof this.tab.ensurePageVisible === "function") await this.tab.ensurePageVisible();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const count = await this.count();
      const visible = count ? await this.isVisible() : false;
      if ((state === "attached" && count) || (state === "detached" && !count) || (state === "visible" && visible) || (state === "hidden" && !visible)) return;
      await sleep(100);
    }
    throw new Error(`Locator waitFor timed out for state ${state}`);
  }
}

export class FrameLocator {
  constructor(tab, frameSteps) {
    this.tab = tab;
    this.frameSteps = frameSteps;
  }
  descriptor(step) { return { steps: [...this.frameSteps, step] }; }
  locator(selector, options = {}) {
    const locator = new Locator(this.tab, this.descriptor({ type: "css", selector }));
    return Object.keys(options).length ? locator.filter(options) : locator;
  }
  getByText(text, options = {}) { return new Locator(this.tab, this.descriptor({ type: "text", matcher: serializeMatcher(text), exact: !!options.exact })); }
  getByRole(role, options = {}) { return new Locator(this.tab, this.descriptor({ type: "role", role, name: options.name == null ? null : serializeMatcher(options.name), exact: !!options.exact })); }
  getByLabel(text, options = {}) { return new Locator(this.tab, this.descriptor({ type: "label", matcher: serializeMatcher(text), exact: !!options.exact })); }
  getByPlaceholder(text, options = {}) { return new Locator(this.tab, this.descriptor({ type: "placeholder", matcher: serializeMatcher(text), exact: !!options.exact })); }
  getByTestId(value) { return new Locator(this.tab, this.descriptor({ type: "testId", value })); }
  frameLocator(selector) { return new FrameLocator(this.tab, [...this.frameSteps, { type: "frame", selector }]); }
}

export class BrowserDownload {
  constructor(tab, event) {
    this.tab = tab;
    this.resourceId = event.resourceId;
    this.payload = event.payload || {};
  }
  async path({ timeoutMs = 30000 } = {}) {
    const result = await this.tab.transport.session(this.tab.id, "downloadPath", {
      resourceId: this.resourceId,
      timeoutMs
    });
    return result?.path ?? null;
  }
}

export class BrowserFileChooser {
  constructor(tab, event) {
    this.tab = tab;
    this.resourceId = event.resourceId;
    this.multiple = !!event.payload?.multiple;
  }
  isMultiple() { return this.multiple; }
  async setFiles(files, { timeoutMs = 30000 } = {}) {
    await this.tab.transport.session(this.tab.id, "fileChooserSetFiles", {
      resourceId: this.resourceId,
      files: Array.isArray(files) ? files : [files],
      timeoutMs
    });
  }
}

export function browserDialog(tab, event) {
  if (!event) return undefined;
  const type = event.payload?.type;
  const act = (action, text) => tab.transport.session(tab.id, "dialogAct", {
    resourceId: event.resourceId,
    action,
    text
  });
  if (type === "prompt") return { type, accept: (text) => act("accept", text), dismiss: () => act("dismiss") };
  if (type === "confirm") return { type, accept: () => act("accept"), dismiss: () => act("dismiss") };
  if (type === "alert" || type === "beforeunload") return { type, dismiss: () => act("dismiss") };
  return undefined;
}

export class ChromeTab {
  constructor(transport, info, sessionState = undefined) {
    this.transport = transport;
    this.id = String(info.id);
    this.sessionState = sessionState;
    this.capabilities = new CapabilityCollection(TAB_CAPABILITIES, () => ({
      send: (method, params = {}, options = {}) => transport.request("cdp.send", {
        tabId: this.id,
        cdpMethod: method,
        cdpParams: params,
        cdpOptions: options
      }),
      readEvents: (options = {}) => transport.request("cdp.readEvents", { tabId: this.id, options }),
      documentation: async () => "Raw Chrome DevTools Protocol 1.3 via chrome.debugger."
    }));
    this.playwright = {
      locator: (selector) => new Locator(this, { steps: [{ type: "css", selector }] }),
      getByText: (text, options = {}) => new Locator(this, { steps: [{ type: "text", matcher: serializeMatcher(text), exact: !!options.exact }] }),
      getByRole: (role, options = {}) => new Locator(this, { steps: [{ type: "role", role, name: options.name == null ? null : serializeMatcher(options.name), exact: !!options.exact }] }),
      getByLabel: (text, options = {}) => new Locator(this, { steps: [{ type: "label", matcher: serializeMatcher(text), exact: !!options.exact }] }),
      getByPlaceholder: (text, options = {}) => new Locator(this, { steps: [{ type: "placeholder", matcher: serializeMatcher(text), exact: !!options.exact }] }),
      getByTestId: (value) => new Locator(this, { steps: [{ type: "testId", value }] }),
      frameLocator: (selector) => new FrameLocator(this, [{ type: "frame", selector }]),
      evaluate: (fn, arg, options = {}) => this.evaluateReadOnly(fn, arg, options),
      waitForTimeout: sleep,
      waitForLoadState: (options = {}) => this.waitForLoadState(options),
      waitForURL: (url, options = {}) => this.waitForURL(url, options),
      domSnapshot: () => this.domSnapshot(),
      elementInfo: (options) => this.elementInfo(options),
      elementScreenshot: (options) => this.elementScreenshot(options),
      expectNavigation: (action, options = {}) => this.expectNavigation(action, options),
      waitForEvent: (event, options = {}) => this.waitForEvent(event, options)
    };
    this.cua = {
      click: async ({ x, y, button = 1, keypress = [] }) => {
        const mapped = { 1: "left", 2: "middle", 3: "right" }[button] || "left";
        const modifiers = modifierBits(keypress);
        await transport.cdp(this.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: mapped, modifiers, clickCount: 1 });
        await transport.cdp(this.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: mapped, modifiers, clickCount: 1 });
      },
      double_click: async ({ x, y, keypress = [] }) => {
        const modifiers = modifierBits(keypress);
        await transport.cdp(this.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", modifiers, clickCount: 2 });
        await transport.cdp(this.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", modifiers, clickCount: 2 });
      },
      type: ({ text }) => transport.cdp(this.id, "Input.insertText", { text }),
      keypress: async ({ keys }) => new Locator(this, { steps: [{ type: "css", selector: ":focus" }] }).press(keys.join("+")),
      move: ({ x, y, keys = [] }) => transport.cdp(this.id, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y, modifiers: modifierBits(keys)
      }),
      drag: async ({ path, keys = [] }) => {
        if (!Array.isArray(path) || path.length < 2) throw new Error("CUA drag requires at least two path points");
        const modifiers = modifierBits(keys);
        const [first, ...rest] = path;
        await transport.cdp(this.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...first, modifiers });
        await transport.cdp(this.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...first, button: "left", modifiers, clickCount: 1 });
        for (const point of rest) {
          await transport.cdp(this.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "left", buttons: 1, modifiers });
        }
        const last = path.at(-1);
        await transport.cdp(this.id, "Input.dispatchMouseEvent", { type: "mouseReleased", ...last, button: "left", modifiers, clickCount: 1 });
      },
      downloadMedia: ({ x, y, timeoutMs = 30000 }) => this.downloadAtPoint({ x, y, timeoutMs }),
      scroll: async ({ x, y, scrollX, scrollY, deltaX, deltaY }) => {
        const resolvedDeltaX = deltaX ?? scrollX ?? 0;
        const resolvedDeltaY = deltaY ?? scrollY;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("chrome_cua scroll requires finite x and y coordinates");
        }
        if (!Number.isFinite(resolvedDeltaY)) {
          throw new Error("chrome_cua scroll requires deltaY or scrollY");
        }
        await this.ensurePageVisible().catch(() => {});
        return transport.cdp(this.id, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: resolvedDeltaX,
          deltaY: resolvedDeltaY
        });
      }
    };
    this.dev = { logs: (options = {}) => transport.request("dev.logs", { tabId: this.id, ...options }) };
    this.clipboard = {
      readText: async () => (await transport.request("clipboard.readText", { tabId: this.id })).result?.value || "",
      writeText: (text) => transport.request("clipboard.writeText", { tabId: this.id, text }),
      read: () => transport.session(this.id, "clipboardRead", {}),
      write: (items) => transport.session(this.id, "clipboardWrite", { items })
    };
    this.content = {
      export: () => this.exportContent(),
      exportGsuite: (type) => this.exportGsuite(type)
    };
    this.dom_cua = {
      get_visible_dom: () => this.visibleDom(),
      click: ({ node_id }) => this.domNode(node_id).click(),
      double_click: ({ node_id }) => this.domNode(node_id).dblclick(),
      downloadMedia: ({ node_id, timeoutMs = 30000 }) => this.domNode(node_id).downloadMedia({ timeoutMs }),
      keypress: ({ keys }) => this.cua.keypress({ keys }),
      type: ({ text }) => this.cua.type({ text }),
      scroll: ({ node_id, x, y }) => this.scrollDom(node_id, x, y)
    };
  }
  async evaluateReadOnly(pageFunction, arg, { timeoutMs = 30000 } = {}) {
    const source = functionSource(pageFunction);
    const expression = `new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Playwright evaluate timed out")), ${Math.max(1, timeoutMs)});
      Promise.resolve((() => {
        const candidate = (${source});
        return typeof candidate === "function" ? candidate(${JSON.stringify(arg)}) : candidate;
      })()).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    })`;
    return this.transport.evaluate(this.id, expression);
  }
  async domSnapshot() {
    return this.transport.evaluate(this.id, `(() => {
      const clone = document.documentElement.cloneNode(true);
      const originals = [...document.querySelectorAll("iframe")];
      const copies = [...clone.querySelectorAll("iframe")];
      originals.forEach((frame, index) => {
        try {
          const body = frame.contentDocument?.body;
          if (body && copies[index]) {
            const expanded = document.createElement("template");
            expanded.setAttribute("data-agentos-frame-body", "");
            expanded.innerHTML = body.outerHTML;
            copies[index].after(expanded.content);
          }
        } catch {}
      });
      return clone.outerHTML;
    })()`);
  }
  async expectNavigation(action, { timeoutMs = 30000, url, waitUntil = "load" } = {}) {
    const start = await this.url();
    const result = await action();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const current = await this.url();
      const matches = url ? (current === url || current?.startsWith(url)) : current !== start;
      if (matches) {
        if (waitUntil !== "commit") await this.waitForLoadState({ state: waitUntil, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)) });
        return result;
      }
      await sleep(50);
    }
    throw new Error(`expectNavigation timed out after ${timeoutMs}ms`);
  }
  async waitForEvent(event, { timeoutMs = 30000 } = {}) {
    if (!["download", "filechooser"].includes(event)) throw new Error(`Unsupported page event: ${event}`);
    const cursor = (await this.transport.session(this.id, "readEvents", { names: [event], limit: 1 })).cursor;
    const entry = await this.transport.session(this.id, "waitForEvent", { name: event, afterSequence: cursor, timeoutMs });
    return event === "download" ? new BrowserDownload(this, entry) : new BrowserFileChooser(this, entry);
  }
  async downloadAtPoint({ x, y, timeoutMs }) {
    const pending = this.waitForEvent("download", { timeoutMs });
    await this.cua.click({ x, y });
    await pending;
  }
  async visibleDom() {
    return this.transport.evaluate(this.id, `(() => {
      const interactable = "a,button,input,textarea,select,summary,[role],[contenteditable='true'],[tabindex]";
      const nodes = [...document.querySelectorAll(interactable)].filter((el) => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      return nodes.map((el, index) => {
        const node_id = "agentos-" + index;
        el.setAttribute("data-agentos-node-id", node_id);
        const rect = el.getBoundingClientRect();
        return {
          node_id,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          name: el.getAttribute("aria-label") || el.innerText || el.value || "",
          value: "value" in el ? el.value : undefined,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      });
    })()`);
  }
  domNode(nodeId) {
    if (typeof nodeId !== "string" || !nodeId) throw new TypeError("DOM CUA requires a node_id");
    return this.playwright.locator(`[data-agentos-node-id="${nodeId.replaceAll('"', '\\"')}"]`);
  }
  async scrollDom(nodeId, x, y) {
    if (nodeId) {
      await this.domNode(nodeId).evaluate((element, delta) => {
        element.scrollBy(delta.x, delta.y);
      }, { x, y });
      return;
    }
    await this.transport.evaluate(this.id, `window.scrollBy(${Number(x) || 0}, ${Number(y) || 0})`);
  }
  async elementInfo({ x, y, includeNonInteractable = false }) {
    return this.transport.evaluate(this.id, `(() => {
      const nodes = document.elementsFromPoint(${Number(x)}, ${Number(y)});
      const interactable = (el) => el.matches("a,button,input,textarea,select,summary,[role],[contenteditable='true'],[tabindex]");
      return nodes.filter((el) => ${includeNonInteractable ? "true" : "interactable(el)"}).map((el) => {
        const rect = el.getBoundingClientRect();
        const testId = el.getAttribute("data-testid");
        const id = el.id ? "#" + CSS.escape(el.id) : null;
        const tag = el.tagName.toLowerCase();
        const primary = id || (testId ? '[data-testid="' + CSS.escape(testId) + '"]' : tag);
        return {
          ariaName: el.getAttribute("aria-label"),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          nodeId: null,
          preview: el.outerHTML.slice(0, 300),
          role: el.getAttribute("role"),
          selector: { candidates: [primary, tag], primary },
          tagName: tag,
          testId,
          visibleText: el.innerText || ("value" in el ? el.value : null)
        };
      });
    })()`);
  }
  async elementScreenshot(options) {
    await this.activate();
    const info = await this.elementInfo(options);
    const token = `agentos-overlay-${randomUUID()}`;
    await this.transport.evaluate(this.id, `(() => {
      const boxes = ${JSON.stringify(info.map((entry) => entry.boundingBox).filter(Boolean))};
      for (const box of boxes) {
        const overlay = document.createElement("div");
        overlay.dataset.agentosOverlay = ${JSON.stringify(token)};
        Object.assign(overlay.style, {
          position: "fixed", pointerEvents: "none", zIndex: "2147483647",
          left: box.x + "px", top: box.y + "px", width: box.width + "px", height: box.height + "px",
          border: "3px solid #ff2d55", boxSizing: "border-box"
        });
        document.documentElement.append(overlay);
      }
    })()`);
    try {
      const result = await this.transport.cdp(this.id, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false
      });
      return Uint8Array.from(Buffer.from(result.data, "base64"));
    } finally {
      await this.transport.evaluate(this.id, `document.querySelectorAll('[data-agentos-overlay="${token}"]').forEach((element) => element.remove())`).catch(() => {});
    }
  }
  async exportContent() {
    const directory = join(tmpdir(), "agentos-chrome-cdp", randomUUID());
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, "page.html");
    await writeFile(filePath, await this.domSnapshot(), "utf8");
    return filePath;
  }
  async exportGsuite(type) {
    if (!["pdf", "md", "xlsx", "csv", "docx", "pptx"].includes(type)) throw new Error(`Unsupported GSuite export type: ${type}`);
    const url = await this.url();
    if (!/^https:\/\/(?:docs|sheets|slides)\.google\.com\//.test(url || "")) throw new Error("exportGsuite requires a Google Docs, Sheets, or Slides tab");
    const result = await this.transport.session(this.id, "exportGsuite", { type, url, timeoutMs: 120000 });
    if (!result?.path) throw new Error(`Google Workspace ${type} export did not produce a local file`);
    return result.path;
  }
  url() { return this.transport.request("tabs.get", { tabId: this.id }).then((tab) => tab.url); }
  title() { return this.transport.request("tabs.get", { tabId: this.id }).then((tab) => tab.title); }
  async navigationSnapshot() {
    try {
      return await this.transport.evaluate(this.id, `({
        href: location.href,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        timeOrigin: performance.timeOrigin
      })`);
    } catch {
      return null;
    }
  }
  async waitForNavigationCommit({
    url,
    previousHref,
    previousTimeOrigin,
    requireNewDocument = false,
    timeoutMs = 30000
  } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      const tab = await this.transport.request("tabs.get", { tabId: this.id }).catch(() => null);
      const snapshot = await this.navigationSnapshot();
      last = { tab, snapshot };
      const urlCommitted = navigationUrlMatches(tab?.url, url) &&
        navigationUrlMatches(snapshot?.href, url);
      const documentReady = snapshot?.readyState === "interactive" || snapshot?.readyState === "complete";
      const documentChanged = !requireNewDocument ||
        !Number.isFinite(previousTimeOrigin) ||
        (Number.isFinite(snapshot?.timeOrigin) && snapshot.timeOrigin !== previousTimeOrigin) ||
        !navigationUrlMatches(previousHref, url);
      // A usable current document is stronger evidence than chrome.tabs'
      // coarse status. Long-lived SPA/subresource activity can leave the tab at
      // "loading" even after the main document is interactive. Chrome can also
      // report a committed background document as hidden; visibility is an
      // interaction-readiness concern handled by ensurePageVisible(), not
      // evidence that navigation failed to commit.
      // SPA-tolerant commit: some Studio/SPA routes keep `readyState` at
      // "loading" for many seconds while the committed document is already
      // attached and responsive (observed live on TikTok Studio content list,
      // 2026-08-02: "navigation did not commit"). A successful in-document
      // evaluate (snapshot) at the committed URL is proof the new document is
      // attached; callers run their own surface waits afterwards. Require a
      // short settle when the document is still "loading" so we never return
      // during the initial commit transition.
      const stillLoading = snapshot !== null
        && snapshot.readyState !== "interactive"
        && snapshot.readyState !== "complete";
      if (urlCommitted && documentChanged && snapshot !== null
          && (documentReady || (stillLoading && Date.now() - started >= 1500))) {
        return snapshot;
      }
      await sleep(100);
    }
    throw new Error(`navigation did not commit the requested current document for ${url}: ${JSON.stringify(last)}`);
  }
  async resetNavigationAttachment() {
    // chrome.debugger sessions can retain the old main-frame execution context
    // across chrome.tabs.update/reload. Detach before navigation so the first
    // post-commit CDP probe attaches to the new current document.
    await this.transport.request("debugger.detach", { tabId: this.id }).catch(() => {});
  }
  async goto(url, { timeoutMs = 30000 } = {}) {
    await this.activate();
    const current = await this.transport.request("tabs.get", { tabId: this.id });
    const sameUrl = navigationUrlMatches(current?.url, url);
    // Cross-document navigation must not depend on a CDP command against the
    // OLD page. A wedged Studio debugger session can make Page.bringToFront or
    // Runtime.evaluate time out before chrome.tabs.update ever runs, leaving a
    // task-owned tab stranded on the previous URL. Only a same-route reload
    // needs the old document's timeOrigin to prove that a new document loaded.
    const before = sameUrl ? await this.navigationSnapshot() : null;
    await this.resetNavigationAttachment();
    if (sameUrl) {
      await this.transport.request("tabs.reload", { tabId: this.id });
    } else {
      await this.transport.request("tabs.update", { tabId: this.id, updateProperties: { url } });
    }
    const committed = await this.waitForNavigationCommit({
      url,
      previousHref: before?.href,
      previousTimeOrigin: before?.timeOrigin,
      requireNewDocument: sameUrl,
      timeoutMs
    });
    await this.ensurePageVisible();
    return committed;
  }
  activate() { return this.transport.request("tabs.activate", { tabId: this.id }); }
  async reload({ timeoutMs = 30000 } = {}) {
    await this.activate();
    await this.ensurePageVisible();
    const before = await this.navigationSnapshot();
    const url = before?.href || await this.url();
    await this.resetNavigationAttachment();
    await this.transport.request("tabs.reload", { tabId: this.id });
    const committed = await this.waitForNavigationCommit({
      url,
      previousHref: before?.href,
      previousTimeOrigin: before?.timeOrigin,
      requireNewDocument: true,
      timeoutMs
    });
    await this.ensurePageVisible();
    return committed;
  }
  back() { return this.transport.request("tabs.goBack", { tabId: this.id }); }
  forward() { return this.transport.request("tabs.goForward", { tabId: this.id }); }
  async close() {
    const outcome = await removeTabWithRetry(this.transport, this.id);
    if (!outcome.closed) {
      throw new Error(`tab ${this.id} could not be closed: ${outcome.lastError || "tabs.remove failed"}`);
    }
    this.sessionState?.owned.delete(this.id);
    this.sessionState?.keep.delete(this.id);
  }
  ensurePageVisible() {
    return this.transport.cdp(this.id, "Page.bringToFront", {})
      .then(() => this.transport.cdp(this.id, "Emulation.setFocusEmulationEnabled", { enabled: true }));
  }
  async screenshot(options = {}) {
    const result = await this.transport.session(this.id, "screenshot", {
      fullPage: !!options.fullPage,
      clip: options.clip && { ...options.clip }
    });
    return Uint8Array.from(Buffer.from(result.data, "base64"));
  }
  async waitForLoadState({ state = "load", timeoutMs = 30000 } = {}) {
    const expected = state === "domcontentloaded" ? "interactive" : "complete";
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ready = await this.transport.evaluate(this.id, "document.readyState").catch(() => null);
      if (ready === "complete" || ready === expected || (state === "networkidle" && ready === "complete")) return;
      await sleep(100);
    }
    throw new Error(`waitForLoadState timed out: ${state}`);
  }
  async waitForURL(expected, { timeoutMs = 30000 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((await this.url()) === expected || (await this.url())?.startsWith(expected)) return;
      await sleep(100);
    }
    throw new Error(`waitForURL timed out: ${expected}`);
  }
  async getJsDialog() {
    const result = await this.transport.session(this.id, "currentDialog", {});
    return browserDialog(this, result?.event);
  }
  async markDeliverable() {
    this.sessionState?.keep.set(this.id, "deliverable");
  }
  async markHandoff() {
    this.sessionState?.keep.set(this.id, "handoff");
  }
}

export class ChromeBrowser {
  constructor(router, profile, agentDocumentation = undefined) {
    this.router = router;
    this.profile = profile;
    this.agentDocumentation = agentDocumentation;
    this.browserId = `extension:${profile.profileName}`;
    this.transport = new ChromeTransport(router, profile.profileName);
    this.sessionState = { keep: new Map(), owned: new Set(), name: undefined };
    const makeTab = (info) => new ChromeTab(this.transport, info, this.sessionState);
    this.capabilities = new CapabilityCollection([], () => undefined);
    this.tabs = {
      content: (options) => this.tabsContent(options),
      list: () => this.transport.request("tabs.list", {}),
      get: async (id) => makeTab(await this.transport.request("tabs.get", { tabId: id })),
      new: async () => {
        const tab = makeTab(await this.transport.request("tabs.new", {}));
        this.sessionState.owned.add(tab.id);
        return tab;
      },
      activate: async (id) => {
        const tab = makeTab(await this.transport.request("tabs.get", { tabId: id }));
        await tab.activate();
        return tab;
      },
      selected: async () => {
        const tab = await this.transport.request("tabs.selected", {});
        return tab ? makeTab(tab) : undefined;
      },
      finalize: (options = {}) => this.finalizeTabs(options)
    };
    this.user = {
      openTabs: async () => (await this.tabs.list()).map((entry) => ({
        id: String(entry.id),
        providerTabId: String(entry.id),
        ...(entry.lastAccessed ? { lastOpened: new Date(entry.lastAccessed).toISOString() } : {}),
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.url ? { url: entry.url } : {})
      })).sort((left, right) => (right.lastOpened || "").localeCompare(left.lastOpened || "")),
      claimTab: (tab) => this.tabs.get(typeof tab === "string" ? tab : (tab.providerTabId || tab.id)),
      history: async (options = {}) => (await this.transport.request("history.search", {
        query: { text: options.queries?.join(" ") || "", startTime: options.from ? new Date(options.from).getTime() : 0, endTime: options.to ? new Date(options.to).getTime() : Date.now(), maxResults: options.limit || 100 }
      })).map((entry) => ({
        dateVisited: new Date(entry.lastVisitTime || 0).toISOString(),
        ...(entry.title ? { title: entry.title } : {}),
        url: entry.url
      })).sort((left, right) => right.dateVisited.localeCompare(left.dateVisited))
    };
    this.docs = new BrowserDocumentationStore(this);
  }
  async tabsContent({ urls, contentType, timeoutMs = 30000 }) {
    if (!Array.isArray(urls)) throw new TypeError("tabs.content requires an array of URLs");
    if (!["html", "text", "domSnapshot"].includes(contentType)) throw new Error(`Unsupported tabs.content contentType: ${contentType}`);
    const results = [];
    for (const requestedUrl of urls) {
      let tab;
      try {
        tab = await this.tabs.new();
        await tab.goto(requestedUrl);
        await tab.waitForLoadState({ state: "domcontentloaded", timeoutMs });
        const content = contentType === "text"
          ? await tab.playwright.evaluate(() => document.body?.innerText || "")
          : contentType === "html"
            ? await tab.playwright.evaluate(() => document.documentElement.outerHTML)
            : await tab.playwright.domSnapshot();
        results.push({ content, title: await tab.title() ?? null, url: await tab.url() ?? requestedUrl });
      } catch {
        results.push({ content: null, title: null, url: tab ? (await tab.url().catch(() => requestedUrl)) : requestedUrl });
      } finally {
        await tab?.close().catch(() => {});
      }
    }
    return results;
  }
  async finalizeTabs({ keep = [] } = {}) {
    const explicit = new Map();
    for (const item of keep) {
      const value = item?.tab;
      const id = typeof value === "string" ? value : value?.id;
      if (id) explicit.set(String(id), item.status);
    }
    for (const [id, status] of this.sessionState.keep) if (!explicit.has(id)) explicit.set(id, status);
    const open = await this.tabs.list();
    const openIds = new Set(open.map((info) => String(info.id)));
    const closeIds = [...this.sessionState.owned]
      .filter((id) => openIds.has(id) && !explicit.has(id));
    const closed = [];
    const closeFailures = [];
    for (const id of closeIds) {
      const outcome = await removeTabWithRetry(this.transport, id);
      if (outcome.closed) {
        this.sessionState.owned.delete(id);
        closed.push(id);
      } else {
        // Keep unclosed tabs in the owned set so a later finalize pass can
        // retry them and so callers can audit the leak instead of forgetting
        // it silently (previously a timed-out tabs.remove was dropped from
        // owned and the tab leaked forever).
        closeFailures.push({ tabId: id, lastError: outcome.lastError || "tabs.remove failed" });
      }
    }
    for (const id of [...this.sessionState.owned]) {
      if (!openIds.has(id)) {
        this.sessionState.owned.delete(id);
        explicit.delete(id);
      }
    }
    this.sessionState.keep = explicit;
    const openAfter = await this.tabs.list().catch(() => []);
    const openAfterIds = new Set(openAfter.map((info) => String(info.id)));
    return {
      closedTabIds: closed,
      preservedTabIds: [...explicit.keys()].filter((id) => openAfterIds.has(id)),
      ownedOpenTabIds: [...this.sessionState.owned].filter((id) => openAfterIds.has(id)),
      closeFailures,
    };
  }
  async nameSession(name) {
    if (typeof name !== "string" || !name.trim()) throw new TypeError("Session name must be a non-empty string");
    this.sessionState.name = name.trim();
  }
  async documentation() {
    return "Agent OS Chrome CDP mirrors the Codex Chrome 26.721.41059 browser API over an exact-profile Chrome extension and chrome.debugger. Select metadata.profileName explicitly whenever multiple profiles are connected.";
  }
}

export async function createTabWithNavigation(browser, url) {
  const tab = await browser.tabs.new();
  try {
    if (url) await tab.goto(url);
    return tab;
  } catch (error) {
    try {
      await tab.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `new tab ${tab.id} navigation failed and rollback could not close the created tab`
      );
    }
    throw error;
  }
}

export function createAgent(router) {
  const browserCache = new Map();
  const targets = async () => (await router.list()).map((profile) => ({
    id: `extension:${profile.profileName}`,
    name: `Chrome (${profile.profileName})`,
    type: "extension",
    metadata: {
      profileName: profile.profileName,
      extensionId: profile.extensionId,
      version: profile.version,
      buildId: profile.buildId,
      bindingVerified: profile.bindingVerified === true,
      verifiedProfileDirectory: profile.bindingVerified === true
        ? profile.verifiedProfileDirectory
        : null
    },
    capabilities: { browser: [], tab: TAB_CAPABILITIES }
  }));
  const documentation = {
      get: async (name) => {
        const key = String(name || "").replace(/^\/+|\.md$/g, "");
        const docs = {
          api: "Codex Chrome compatibility baseline 26.721.41059: agent.browsers, tabs, Playwright-style locators, CUA, DOM CUA, content, clipboard, dialogs, downloads, and developer logs.",
          guidance: "Bind one exact profile by metadata.profileName before controlling tabs. The optional finalize operation closes only tabs created by this agent session and preserves user-owned tabs; callers decide whether and when cleanup is appropriate. Mark an agent-created tab handoff or deliverable when it should remain open."
        };
        if (!(key in docs)) throw new Error(`Browser documentation not found: ${name}`);
        return docs[key];
      }
    };
  const getBrowser = async (id) => {
    const profileName = id.startsWith("extension:") ? id.slice("extension:".length) : id;
    const profile = (await router.list()).find((item) => item.profileName === profileName);
    if (!profile) throw new Error(`Chrome profile not found: ${profileName}`);
    let browser = browserCache.get(profileName);
    if (!browser) {
      browser = new ChromeBrowser(router, profile, documentation);
      browserCache.set(profileName, browser);
    }
    return browser;
  };
  return {
    documentation,
    browsers: {
      list: async () => targets(),
      get: getBrowser,
      getDefault: async () => {
        const all = await targets();
        if (all.length !== 1) throw new Error(`No unique default Chrome profile; connected profiles: ${all.map((x) => x.metadata.profileName).join(", ") || "none"}`);
        return getBrowser(all[0].id);
      },
      getForUrl: async () => {
        const all = await targets();
        if (all.length !== 1) throw new Error("getForUrl is ambiguous across multiple Chrome profiles; select metadata.profileName explicitly");
        return getBrowser(all[0].id);
      }
    }
  };
}
