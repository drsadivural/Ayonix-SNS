// Modal dialog and side drawer on the native <dialog> element: it traps focus,
// handles Escape, restores focus on close and marks the page inert.
import { useEffect, useId, useRef, type ReactNode } from 'react';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);
  return ref;
}

function Overlay({ open, onClose, title, description, children, footer, className }: OverlayProps & { className: string }) {
  const ref = useModal(open);
  const titleId = useId();
  const descId = useId();
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <div className="overlay-inner">
          <div className="overlay-head">
            <div className="stack-sm">
              <h2 id={titleId} style={{ fontSize: 22 }}>
                {title}
              </h2>
              {description ? (
                <p id={descId} className="muted small">
                  {description}
                </p>
              ) : null}
            </div>
            <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className="overlay-body">{children}</div>
          {footer ? <div className="overlay-foot">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export function Dialog(props: OverlayProps) {
  return <Overlay {...props} className="dialog" />;
}

export function Drawer({ narrow, ...props }: OverlayProps & { narrow?: boolean }) {
  return <Overlay {...props} className={`drawer ${narrow ? 'narrow' : ''}`} />;
}

/** Confirmation dialog for destructive actions. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  onConfirm,
  pending,
  danger,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  danger?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Keep it
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
