import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { HTMLAttributes, ReactNode } from 'react';

/** The single place a className is merged, so composing components never fights Tailwind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 min-h-11 px-4',
  {
    variants: {
      variant: {
        default: 'bg-slate-900 text-white hover:bg-slate-800',
        secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200',
        outline: 'border border-slate-300 bg-white hover:bg-slate-50',
        destructive: 'bg-red-600 text-white hover:bg-red-700',
        ghost: 'hover:bg-slate-100',
      },
      size: {
        default: 'h-11',
        sm: 'h-9 px-3 text-xs',
        lg: 'h-14 px-6 text-base',
        icon: 'h-11 w-11 px-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends HTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-slate-200 bg-white shadow-sm', className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-slate-100 px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-base font-semibold text-slate-900', className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

export function Input({ className, ...props }: HTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900',
        'placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: HTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1 block text-sm font-medium text-slate-700', className)} {...props} />;
}

export function Select({ className, children, ...props }: HTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

const badgeVariants = cva('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-slate-100 text-slate-700',
      success: 'bg-emerald-100 text-emerald-800',
      warning: 'bg-amber-100 text-amber-900',
      danger: 'bg-red-100 text-red-800',
      info: 'bg-sky-100 text-sky-900',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const ATTENDANCE_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  present: 'success',
  late: 'info',
  present_manual: 'success',
  present_flagged: 'warning',
  absent: 'danger',
  excused: 'neutral',
};

const ATTENDANCE_LABEL: Record<string, string> = {
  present: 'Present',
  late: 'Late',
  present_manual: 'Present (manual)',
  present_flagged: 'Flagged',
  absent: 'Absent',
  excused: 'Excused',
};

export function AttendanceBadge({ status }: { status: string }) {
  return <Badge tone={ATTENDANCE_TONE[status] ?? 'neutral'}>{ATTENDANCE_LABEL[status] ?? status}</Badge>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {detail ? <p className="text-xs text-slate-500">{detail}</p> : null}
    </div>
  );
}

/** Attendance bar with the institution threshold marked. */
export function ProgressLike({ value, threshold }: { value: number; threshold: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const below = clamped < threshold;
  return (
    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${value}% attendance`}>
      <div className={cn('h-full rounded-full', below ? 'bg-red-500' : 'bg-emerald-500')} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children?: ReactNode;
}) {
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-red-200 bg-red-50 text-red-900',
  } as const;
  return (
    <div className={cn('rounded-lg border px-4 py-3 text-sm', tones[tone])} role="status">
      {title ? <p className="font-medium">{title}</p> : null}
      {children}
    </div>
  );
}
