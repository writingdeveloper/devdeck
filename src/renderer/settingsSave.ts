import { tr } from './i18n-runtime';
import { reportSaveError } from './loadError';

type Control = HTMLInputElement | HTMLSelectElement;
interface Setting<T> {
  read(): T;
  restore(value: T): void;
  write(value: T): Promise<unknown>;
  apply?(value: T): void;
  validate?(value: T): string | null;
  busyControls?: Control[];
}

/** Saved state, visible selection and runtime agree, or roll back. No optimistic effects. */
export function bindSetting<T>(controls: Control[], setting: Setting<T>): void {
  let committed = setting.read();
  let pending = false;
  const changed = async (): Promise<void> => {
    if (pending) return;
    const value = setting.read();
    const row = controls[0].closest<HTMLElement>('.set-row');
    let status = row?.querySelector<HTMLElement>('.set-save-status');
    if (!status && row) {
      status = document.createElement('div'); status.className = 'set-save-status';
      status.id = `save-${controls[0].id}`;
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      row.appendChild(status);
      controls.forEach(c => c.setAttribute('aria-describedby', status!.id));
    }
    const message = (key: string) => { if (status) status.textContent = tr(key); };
    const invalid = setting.validate?.(value);
    controls.forEach(c => c.setAttribute('aria-invalid', invalid ? 'true' : 'false'));
    if (invalid) { message(invalid); return; }
    pending = true;
    const locked = setting.busyControls ?? controls;
    const wasDisabled = locked.map(c => c.disabled);
    locked.forEach(c => { c.disabled = true; });
    row?.setAttribute('aria-busy', 'true'); message('common.saving');
    let succeeded = false;
    try {
      await setting.write(value);
      committed = value; succeeded = true; message('common.saved');
    } catch (error) {
      setting.restore(committed);
      message('common.save_failed'); reportSaveError(error);
    } finally {
      pending = false;
      locked.forEach((c, i) => { c.disabled = wasDisabled[i]; });
      row?.removeAttribute('aria-busy');
    }
    if (succeeded) setting.apply?.(value);
  };
  controls.forEach(c => c.addEventListener('change', () => { void changed(); }));
}

export function bindChoice<T extends string>(control: HTMLSelectElement, write: (v: T) => Promise<unknown>, apply?: (v: T) => void): void {
  bindSetting([control], { read: () => control.value as T, restore: v => { control.value = v; }, write, apply });
}
export function bindCheck(control: HTMLInputElement, write: (v: boolean) => Promise<unknown>, apply?: (v: boolean) => void, busyControls?: Control[]): void {
  bindSetting([control], { read: () => control.checked, restore: v => { control.checked = v; }, write, apply, busyControls });
}
