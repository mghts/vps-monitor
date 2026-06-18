import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type SelectDrawerOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

export function SelectDrawer({
  value,
  options,
  onChange,
  className = '',
  ariaLabel,
  placeholder,
  icon
}: {
  value: string;
  options: SelectDrawerOption[];
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
  placeholder?: ReactNode;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = useMemo(() => options.find((option) => option.value === value), [options, value]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`select-drawer ${open ? 'open' : ''} ${className}`}>
      <button
        type="button"
        className="select-drawer-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {icon && <span className="select-drawer-icon">{icon}</span>}
        <span className="select-drawer-value">{selected?.label ?? placeholder ?? value}</span>
        <span className="select-drawer-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="select-drawer-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`select-drawer-option ${option.value === value ? 'selected' : ''}`}
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="select-drawer-check">{option.value === value ? '✓' : ''}</span>
              <span className="select-drawer-option-label">{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
