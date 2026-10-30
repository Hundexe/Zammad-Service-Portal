// Darstellung eines Formulars – im Portal und als Live-Vorschau im Formular-Editor.
import { h, icon,            } from './dom.js?v=142b079f7fc6';
import { fieldWrap, nextId } from './ui.js?v=142b079f7fc6';
import { isVisible, LIMITS, validateSubmission,                                                                     } from '../../shared/form.js?v=142b079f7fc6';

const ACCEPT                           = {
  pdf: '.pdf',
  image: '.png,.jpg,.jpeg,.gif,.webp',
  office: '.docx,.xlsx,.pptx,.odt,.ods,.doc,.xls,.msg',
  text: '.txt,.csv,.log',
};

                               
                  
                     
                                
                          
                                                      
 

                                                                           

function formatSize(n        )         {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function renderForm(def                , opts                                                                         = {})               {
  const values             = {};
  const files                         = {};
  let errors                         = {};
  for (const f of def.fields) if (f.default !== undefined && f.default !== '') values[f.id] = f.type === 'checkbox' ? f.default === 'true' : f.default;

  const root = h('div', { class: 'form-fields' });
  const slots = new Map                     ();
  const datalists = new WeakMap                          ();

  function control(f           )              {
    const id = `ff-${f.id}`;
    const set = (v         ) => { values[f.id] = v; if (errors[f.id]) { delete errors[f.id]; clearError(f.id); } refreshVisibility(); };
    const common = { id, name: f.id, required: f.required ? true : undefined, placeholder: f.placeholder };
    switch (f.type) {
      case 'textarea': {
        const el = h('textarea', { attrs: { ...common, rows: 6, maxlength: f.maxLength ?? LIMITS.defaultTextareaLength } });
        el.value = String(values[f.id] ?? '');
        el.addEventListener('input', () => set(el.value));
        return el;
      }
      case 'select': {
        const el = h('select', { attrs: { id, name: f.id } },
          h('option', { attrs: { value: '' } }, f.required ? 'Bitte wählen' : '–'),
          ...(f.options ?? []).map((o) => h('option', { attrs: { value: o.value } }, o.label)));
        el.value = String(values[f.id] ?? '');
        el.addEventListener('change', () => set(el.value || undefined));
        return el;
      }
      case 'multiselect': {
        const current = new Set((values[f.id]                        ) ?? []);
        return h('fieldset', { class: 'choices', id, attrs: { 'aria-label': f.label } }, ...(f.options ?? []).map((o) => {
          const cid = nextId('mc');
          const cb = h('input', { id: cid, attrs: { type: 'checkbox', value: o.value } });
          cb.checked = current.has(o.value);
          cb.addEventListener('change', () => { cb.checked ? current.add(o.value) : current.delete(o.value); set([...current]); });
          return h('div', { class: 'check' }, cb, h('label', { attrs: { for: cid } }, o.label));
        }));
      }
      case 'checkbox': {
        const cb = h('input', { id, attrs: { type: 'checkbox' } });
        cb.checked = values[f.id] === true;
        cb.addEventListener('change', () => set(cb.checked ? true : undefined));
        return cb;
      }
      case 'file': {
        const list = h('ul', { class: 'file-list' });
        const max = f.maxFiles ?? 3;
        const accept = (f.accept?.length ? f.accept : (['pdf', 'image', 'office', 'text']              )).map((k) => ACCEPT[k]).join(',');
        const inputEl = h('input', { id, attrs: { type: 'file', multiple: max > 1, accept, class: 'visually-hidden' } });
        const drawList = () => {
          list.replaceChildren(...(files[f.id] ?? []).map((file, i) => h('li', null,
            icon('file', 16), h('span', { class: 'file-name' }, file.name), h('span', { class: 'muted' }, formatSize(file.size)),
            h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': `${file.name} entfernen` }, on: { click: () => { files[f.id].splice(i, 1); set(files[f.id].map((x) => ({ name: x.name, size: x.size }))); drawList(); } } }, icon('x', 16)))));
        };
        const add = (picked                   ) => {
          files[f.id] = [...(files[f.id] ?? []), ...Array.from(picked)].slice(0, max);
          set(files[f.id].map((x) => ({ name: x.name, size: x.size, type: x.type })));
          drawList();
        };
        inputEl.addEventListener('change', () => { if (inputEl.files) add(inputEl.files); inputEl.value = ''; });
        const zone = h('label', { class: 'dropzone', attrs: { for: id } },
          icon('clip', 20),
          h('span', null, max > 1 ? `Dateien auswählen oder hierher ziehen (bis zu ${max})` : 'Datei auswählen oder hierher ziehen'),
          h('span', { class: 'muted small' }, `je höchstens ${f.maxSizeMb ?? 10} MB`));
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('over'));
        zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer?.files) add(e.dataTransfer.files); });
        drawList();
        return h('div', { class: 'file-field' }, inputEl, zone, list);
      }
      case 'approver': {
        // E-Mail-Adresse mit Vorschlägen aus den Personen, die das Portal schon kennt
        const listId = `${id}-people`;
        const list = h('datalist', { id: listId });
        const el = h('input', { attrs: { ...common, type: 'email', list: listId, autocomplete: 'off', spellcheck: 'false', maxlength: 254 } });
        el.value = values[f.id] === undefined ? '' : String(values[f.id]);
        let timer                                           ;
        let lastQ = '';
        el.addEventListener('input', () => {
          set(el.value.trim() === '' ? undefined : el.value.trim());
          const q = el.value.trim();
          if (!opts.searchPeople || q.length < 3 || q === lastQ || q.includes('@') && list.querySelector(`option[value="${CSS.escape(q.toLowerCase())}"]`)) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            lastQ = q;
            opts.searchPeople (q).then((people) => {
              list.replaceChildren(...people.map((p) => h('option', { attrs: { value: p.email, label: p.department ? `${p.name} · ${p.department}` : p.name } })));
            }).catch(() => undefined);
          }, 250);
        });
        datalists.set(el, list);
        return el;
      }
      default: {
        const type = f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
        const el = h('input', { attrs: { ...common, type, min: f.min, max: f.max, maxlength: f.type === 'text' ? (f.maxLength ?? LIMITS.defaultTextLength) : undefined, autocomplete: f.type === 'email' ? 'email' : 'off' } });
        el.value = values[f.id] === undefined ? '' : String(values[f.id]);
        el.addEventListener('input', () => set(el.value === '' ? undefined : el.value));
        return el;
      }
    }
  }

  function draw(f           )        {
    if (f.type === 'info') return h('div', { class: 'form-info' }, h('p', { class: 'info-title' }, f.label), f.help ? h('p', null, f.help) : null);
    if (f.type === 'checkbox') {
      const el = control(f);
      return h('div', { class: ['field', 'field-check', errors[f.id] && 'has-error'] },
        h('div', { class: 'check' }, el, h('label', { attrs: { for: el.id } }, f.label, f.required ? ' *' : '')),
        f.help ? h('p', { class: 'help' }, f.help) : null,
        errors[f.id] ? h('p', { class: 'error' }, errors[f.id]) : null);
    }
    const el = control(f);
    if (f.type === 'file' || f.type === 'multiselect') {
      return h('div', { class: ['field', errors[f.id] && 'has-error'] },
        h(f.type === 'file' ? 'label' : 'p', { class: 'label', attrs: f.type === 'file' ? { for: `ff-${f.id}` } : {} }, f.label, f.required ? h('span', { class: 'req' }, ' *') : null),
        f.help ? h('p', { class: 'help' }, f.help) : null, el,
        errors[f.id] ? h('p', { class: 'error', attrs: { role: 'alert' } }, errors[f.id]) : null);
    }
    if (f.type === 'approver') {
      return h('div', { class: 'approval-box' },
        h('p', { class: 'approval-box-head' }, icon('shield', 18), h('span', null, 'Diese Anfrage braucht eine Freigabe')),
        fieldWrap(el, { label: f.label, help: f.help, error: errors[f.id], required: true, id: `ff-${f.id}` }),
        datalists.get(el));
    }
    return fieldWrap(el, { label: f.label, help: f.help, error: errors[f.id], required: f.required, id: `ff-${f.id}` });
  }

  function redraw(id        ) {
    const f = def.fields.find((x) => x.id === id);
    const slot = slots.get(id);
    if (f && slot) slot.replaceChildren(draw(f)        );
  }

  function clearError(id        ) {
    const slot = slots.get(id);
    if (!slot) return;
    slot.querySelector('.field')?.classList.remove('has-error');
    slot.querySelector('p.error')?.remove();
    slot.querySelector('[aria-invalid]')?.removeAttribute('aria-invalid');
  }

  function refreshVisibility() {
    for (const f of def.fields) {
      const slot = slots.get(f.id);
      if (slot) slot.hidden = !isVisible(f, values, def.fields);
    }
  }

  for (const f of def.fields) {
    const slot = h('div', { class: 'slot' }, draw(f));
    slots.set(f.id, slot);
    root.appendChild(slot);
  }
  refreshVisibility();
  if (opts.preview && def.fields.length === 0) root.appendChild(h('p', { class: 'muted' }, 'Noch keine Felder.'));

  return {
    el: root,
    values,
    files,
    validate() {
      const r = validateSubmission(def, values);
      errors = r.errors;
      def.fields.forEach((f) => redraw(f.id));
      refreshVisibility();
      const first = Object.keys(errors)[0];
      if (first) document.getElementById(`ff-${first}`)?.focus();
      return r.ok;
    },
    setErrors(e) {
      errors = e ?? {};
      def.fields.forEach((f) => redraw(f.id));
      refreshVisibility();
    },
  };
}
