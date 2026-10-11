/**
 * Fields and form layout (structure.md §6 #18): a label, the control, one line of help under it,
 * and an error said by the field itself. Text, select, textarea, search, switch and radios.
 */
import { createContext, forwardRef, useContext, useId, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon } from "./Icon.js";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

interface FieldIds {
  control: string;
  help?: string;
  error?: string;
}
const FieldContext = createContext<FieldIds | null>(null);

/** The ids a control inside a Field takes: its own, and what describes it. */
function useFieldProps(id?: string) {
  const f = useContext(FieldContext);
  const described = [f?.help, f?.error].filter(Boolean).join(" ") || undefined;
  return { id: id ?? f?.control, "aria-describedby": described, "aria-invalid": f?.error ? (true as const) : undefined };
}

export function Field({ label, help, error, children }: { label: string; help?: ReactNode; error?: string | null; children: ReactNode }) {
  const base = useId();
  const ids: FieldIds = { control: `${base}-c`, help: help ? `${base}-h` : undefined, error: error ? `${base}-e` : undefined };
  return (
    <div className="field">
      <label htmlFor={ids.control}>{label}</label>
      <FieldContext.Provider value={ids}>{children}</FieldContext.Provider>
      {help && (
        <span className="help" id={ids.help}>
          {help}
        </span>
      )}
      {error && (
        <span className="err" id={ids.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, id, ...rest }, ref) {
  return <input ref={ref} className={cx("inp", className)} {...useFieldProps(id)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, id, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx("inp", className)} {...useFieldProps(id)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, id, ...rest }, ref) {
  return <textarea ref={ref} className={cx("inp", "area", className)} {...useFieldProps(id)} {...rest} />;
});

/** A search box: the magnifier, then the input. */
export const SearchField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string }>(function SearchField({ label, className, ...rest }, ref) {
  return (
    <div className={cx("inp", "search", className)}>
      <Icon name="search" size={18} />
      <input ref={ref} type="search" aria-label={label} {...rest} />
    </div>
  );
});

/** On or off, at once (no Save needed). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  const f = useFieldProps();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={f.id ? undefined : label}
      id={f.id}
      aria-describedby={f["aria-describedby"]}
      disabled={disabled}
      className="ui-sw"
      onClick={() => onChange(!checked)}
    />
  );
}

/** One of a few choices, each with its own line. Arrow keys move and choose. */
export function RadioGroup<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode; help?: ReactNode }[]; label: string }) {
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % list.length : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i - 1 + list.length) % list.length : -1;
    if (to < 0) return;
    e.preventDefault();
    list[to]!.focus();
    onChange(list[to]!.dataset.id as T);
  };
  return (
    <div className="radios" role="radiogroup" aria-label={label} onKeyDown={move}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} tabIndex={o.id === value ? 0 : -1} data-id={o.id} className="radio-row" onClick={() => onChange(o.id)}>
          <span className={cx("radio", o.id === value && "on")} aria-hidden="true" />
          <span>
            <span className="radio-label">{o.label}</span>
            {o.help && <span className="help">{o.help}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** A form's column: fields stacked, actions at the foot. */
export const Form = ({ children, onSubmit, actions }: { children: ReactNode; onSubmit: () => void; actions?: ReactNode }) => (
  <form
    className="form"
    onSubmit={(e) => {
      e.preventDefault();
      onSubmit();
    }}
  >
    {children}
    {actions && <div className="acts">{actions}</div>}
  </form>
);
