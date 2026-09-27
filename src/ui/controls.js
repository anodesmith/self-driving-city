/** Small helpers for building the control panel from a schema. */

export function slider(parent, opts) {
  const wrap = el('div', 'control');
  const label = el('label');
  const name = el('span', null, opts.label);
  const value = el('b', null, format(opts.value));
  label.append(name, value);
  const input = el('input');
  input.type = 'range';
  input.min = opts.min;
  input.max = opts.max;
  input.step = opts.step ?? 1;
  input.value = opts.value;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    value.textContent = format(v);
    opts.onChange(v);
  });
  wrap.append(label, input);
  parent.append(wrap);
  return {
    set(v) {
      input.value = v;
      value.textContent = format(v);
    },
  };
}

export function select(parent, opts) {
  const wrap = el('div', 'control');
  const label = el('label');
  label.append(el('span', null, opts.label));
  const sel = el('select');
  for (const o of opts.options) {
    const opt = el('option', null, o.label);
    opt.value = o.value;
    sel.append(opt);
  }
  sel.value = opts.value;
  sel.addEventListener('change', () => opts.onChange(sel.value));
  wrap.append(label, sel);
  parent.append(wrap);
  return sel;
}

export function checkbox(parent, label, value, onChange) {
  const wrap = el('label', 'check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, document.createTextNode(label));
  parent.append(wrap);
  return input;
}

export function button(id, text, onClick, className) {
  const b = document.getElementById(id);
  if (!b) return null;
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function format(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
